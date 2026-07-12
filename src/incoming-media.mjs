// incoming-media.mjs — limb-agnostic processing of incoming media.
//
// The principle (operator 2026-06-13): the transport LIMB (Beeper, Telegram,
// baileys, …) is a thin pipe — it pulls the raw bytes off its own transport and
// hands them to the bridge. Everything *after* the bytes land — transcription,
// the 👂 ack, save policy — must be ONE implementation, not re-derived per limb.
// A limb that forgot to wire this (Telegram, pre-2026-06-13) silently dropped
// voice + images; that's the regression this module prevents.
//
// This is that one implementation for the voice path. The limb supplies the
// downloaded file + a reply mechanism + the host's enrolled/mute verdict + the
// transcriber; the ack POLICY lives here. Saving to the chat's media/ folder is
// the host's `_saveIncomingMedia` (egpt.mjs), reached via the limb's `onMedia`
// callback — also limb-agnostic.
//
// IMPORTANT: this module imports NOTHING Node-only. telegram.mjs (which imports
// it) is bundled for the browser extension; pulling in transcribe.mjs (which
// needs node:child_process) would break that build. The transcriber is INJECTED
// by the host (egpt.mjs / the Beeper limb), which run in Node.

import { flagDegenerateTranscript } from './transcript-repeat-guard.mjs';

// 👂 posts-back debounce (operator 2026-06-21: "fire the transcript 5 minutes
// after it posts … quieter, batched"). HEARD stays instant — the transcript is
// returned synchronously so the model + transcript.md get every note right away.
// Only the SPOKEN 👂 echo is held: on each voice note we (re)arm a trailing timer
// per chat, and when a burst goes quiet for `postsBackDelayMs` we post the
// accumulated transcripts as ONE 👂 message (so five notes in a row become one
// echo, not five). The ack POLICY lives in this shared module, so every limb
// (Beeper, Telegram) debounces identically. setTimeout/clearTimeout are globals
// (not Node-only imports), so the browser-bundled limb still builds.
export const POSTS_BACK_DELAY_MS = 5 * 60 * 1000;

// debounceKey (the stable chat id) → { handle, items[], reply, onLog, scheduler }.
// `reply` is the NEWEST note's closure so the batched echo quotes the most recent
// voice note. In-memory + best-effort: a restart drops a pending echo, but the
// transcript is already in transcript.md + the model, so nothing is lost.
const _pendingAcks = new Map();
const _defaultScheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };

// Format ONE 👂-ack line's BODY — without the 👂 prefix, which the firing/immediate
// paths add once. The duration is DECOUPLED from the author (operator 2026-07-10) so
// it survives when the author is omitted (Beeper exposes no push name → the limb passes
// no author; the quoted reply carries attribution):
//   author + duration → "<author> (<Ns>): <transcript>"
//   author, no dur    → "<author>: <transcript>"
//   no author, dur    → "(<Ns>) <transcript>"
//   neither           → "<transcript>"
function _ackItem({ author, durationSec, transcript } = {}) {
  const dur = (Number.isFinite(durationSec) && durationSec > 0) ? `(${Math.round(durationSec)}s)` : '';
  let head = '';
  if (author) head = dur ? `${author} ${dur}: ` : `${author}: `;   // author head, duration inside it when known
  else if (dur) head = `${dur} `;                                  // no author → duration still leads the line
  return `${head}${transcript}`;
}

function _queueAck(key, line, reply, onLog, delayMs, scheduler) {
  let e = _pendingAcks.get(key);
  if (e) scheduler.clear(e.handle);                       // reset the trailing window
  else { e = { handle: null, items: [], reply, onLog, scheduler }; _pendingAcks.set(key, e); }
  e.items.push(line);
  e.reply = reply; e.onLog = onLog; e.scheduler = scheduler;   // keep the freshest closures
  e.handle = scheduler.set(() => _firePendingAck(key), delayMs);
  if (e.handle && typeof e.handle.unref === 'function') e.handle.unref();   // don't pin the event loop (no-op in browser)
}

function _firePendingAck(key) {
  const e = _pendingAcks.get(key);
  if (!e) return Promise.resolve();
  _pendingAcks.delete(key);
  // A debounced rank-1 echo that got covered by a peer's 👂 while it waited stands down (operator
  // 2026-07-11): the observed-echo set is the one authority every post path consults.
  if (hasEchoObserved(key)) { e.onLog('👂 already echoed for this note — standing down (debounced)'); return Promise.resolve(); }
  const body = '👂 ' + e.items.join('\n\n');
  return Promise.resolve(e.reply(body)).catch((err) => e.onLog(`👂 ack failed: ${err?.message ?? err}`));
}

// Flush a chat's pending 👂 echo now (e.g. on shutdown). Returns the post promise.
export function flushPostsBackAck(key) { return _firePendingAck(key); }
// Test isolation: clear all timers + pending state.
export function _resetPostsBackDebounce() {
  for (const e of _pendingAcks.values()) { try { e.scheduler.clear(e.handle); } catch { /* ignore */ } }
  _pendingAcks.clear();
}

// 👂 PROMOTION — ORDERED FAILOVER (operator 2026-07-11, Phase 3b; plans/2607101713-HRW-ECHO-PLAN.md).
// A co-account node that is NOT rank-1 for a note (echoRank > 1, echo-priority.mjs) does NOT drop its 👂
// as in 3a — it HOLDS the already-made transcript and schedules the post at (rank-1)*echoTimeoutMs,
// CANCELLING it the instant it observes the note's 👂 from a higher rank (the bridge calls
// markEchoObserved on a 👂 reply to the note — co-account peers see each other's posts as normal
// inbound). STAGGERED by rank so failover is ORDERED: rank-2 fires at +T, rank-3 at +2T, … so when
// rank-2 posts, rank-3 observes it before its own +2T and stands down → still exactly ONE poster
// even if several top ranks are down. NOT dedup: the rank is a deterministic UPFRONT pre-assignment;
// the observe only covers an offline/slow higher rank. Distinct from _pendingAcks (rank-1's debounce)
// because a promotion must be individually CANCELLABLE by note. key = the per-note debounceKey
// (`${chatID}:${noteId}`), the same id the bridge correlates an inbound 👂 reply against.
//
// HAZARD (documented — the operator's one real trade-off): a waiter cannot distinguish "rank-1 DOWN"
// from "rank-1 SLOW". If echoTimeoutMs < rank-1's worst-case transcribe+post+network latency, rank-2
// pre-empts a merely-slow winner → DOUBLE 👂. So the boot default is GENEROUS (~20s); tune from live
// tests. Too-long = slow failover; too-short = double.
const _pendingPromotions = new Map();   // key -> { rank, handle, scheduler }

// 👂 OBSERVED-ECHOES (operator 2026-07-11): the PERSISTENT record of "a co-account peer already posted
// this note's 👂", consulted by EVERY post path so no path double-echoes. It supersedes the bare
// observe-and-cancel, which kept NO record: a slow standby arms its promotion AFTER the fast primary
// already posted, so when the primary's 👂 was observed there was nothing armed to cancel, and the
// standby then fired anyway → double on every note. Recording the observation regardless means the
// late-arming standby (and a debounced/immediate rank-1) checks the set and stands down. key = the
// per-note debounceKey (`${chatID}:${noteId}`). Capped + oldest-first evicted (Map keeps insertion
// order) so it can't grow unbounded on a long-lived node. Node globals only (browser-safe).
const _observedEchoes = new Map();      // key -> insertion marker (Date.now()); FIFO-evicted at the cap
const _OBSERVED_ECHOES_CAP = 1000;

function _armPromotion(key, body, reply, onLog, delayMs, scheduler, rank) {
  const existing = _pendingPromotions.get(key);
  if (existing) { try { scheduler.clear(existing.handle); } catch { /* ignore */ } }   // re-arm (defensive; a note is processed once)
  const e = { rank, handle: null, scheduler };
  e.handle = scheduler.set(() => {
    _pendingPromotions.delete(key);   // fired → no longer cancellable
    Promise.resolve(reply(body)).catch((err) => onLog(`👂 promotion post failed: ${err?.message ?? err}`));
  }, delayMs);
  if (e.handle && typeof e.handle.unref === 'function') e.handle.unref();   // don't pin the event loop (no-op in browser)
  _pendingPromotions.set(key, e);
}

// Observe-and-cancel: a higher rank posted the note's 👂 → stand down. Returns true iff a pending
// promotion existed and was cancelled (the bridge logs on true); false for an unknown / already-fired
// / already-cancelled key. This is the ONLY way a promotion is suppressed — never act-then-suppress.
export function cancelPromotion(key) {
  const e = _pendingPromotions.get(key);
  if (!e) return false;
  try { e.scheduler.clear(e.handle); } catch { /* ignore */ }
  _pendingPromotions.delete(key);
  return true;
}
export function hasPendingPromotion(key) { return _pendingPromotions.has(key); }

// Observe-and-RECORD (operator 2026-07-11): the richer observe entry point that SUPERSEDES
// cancelPromotion. It (1) records the note's key in _observedEchoes so any LATER post path for that
// note stands down — the fix for the arming-order double where a slow standby arms after the primary
// already posted (nothing to cancel at observe time) — AND (2) folds in cancelPromotion: if a
// promotion is already armed for the note, cancel it now. Returns true iff a pending promotion existed
// and was cancelled (so the bridge keeps logging only on an actual cancel); false when nothing was
// armed (the observation is still recorded). The bridge calls this on every co-account 👂 it sees.
export function markEchoObserved(key) {
  if (!_observedEchoes.has(key)) {
    _observedEchoes.set(key, Date.now());
    if (_observedEchoes.size > _OBSERVED_ECHOES_CAP) {
      _observedEchoes.delete(_observedEchoes.keys().next().value);   // evict the oldest (insertion order)
    }
  }
  const e = _pendingPromotions.get(key);
  if (!e) return false;
  try { e.scheduler.clear(e.handle); } catch { /* ignore */ }
  _pendingPromotions.delete(key);
  return true;
}
export function hasEchoObserved(key) { return _observedEchoes.has(key); }

// Test isolation: clear all promotion timers + pending state + observed-echo records.
export function _resetPromotions() {
  for (const e of _pendingPromotions.values()) { try { e.scheduler.clear(e.handle); } catch { /* ignore */ } }
  _pendingPromotions.clear();
  _observedEchoes.clear();
}

// The in-chat 👂 echo MARKER — the prefix every posted transcript ack (immediate, debounced, or
// promoted) starts with. The bridge uses it to recognize a co-account peer's 👂 (a reply to the
// note) so it can cancel its own pending promotion (Phase 3b observe-and-cancel).
export const ECHO_MARKER = '👂';

/**
 * Run the room's transcription service on a voice/audio note: transcribe it
 * (when the service is `enabled`) and post the 👂 ack in-chat (when it
 * `postsBack`). Returns the transcript text, or null when transcription is
 * disabled/failed. The two gates map onto the GENOME heart (idea #2: everything
 * is HEARD and recorded; only some is SPOKEN):
 *   enabled   → HEARD: do the transcription at all (the transcript is RETURNED
 *               so the caller can dispatch it to the model + log it).
 *   postsBack → SPOKEN: surface the 👂 <transcript> back into the chat.
 * So `enabled:true, postsBack:false` transcribes for the model/log but stays
 * silent. Both verdicts are resolved HOST-side from the entity's config.yaml
 * (src/transcription-service.mjs), keyed off the entity folder, never a name.
 *
 * The 👂 echo is DEBOUNCED when a `debounceKey` is supplied (the stable chat id):
 * the transcript still returns instantly (HEARD), but the SPOKEN echo is held and
 * coalesced — see POSTS_BACK_DELAY_MS. Without a `debounceKey` the echo posts
 * immediately (the legacy behaviour; preserved for callers that don't batch).
 *
 * @param {object}   o
 * @param {string}   o.localPath   downloaded audio file (any ffmpeg-readable)
 * @param {Function} o.transcribe  host-injected transcriber (remote-first or
 *                                  local whisper-cli). Required — no default, so
 *                                  this module stays free of Node-only imports.
 * @param {object}   [o.audioCfg]  whatsapp.media.audio_transcribe config
 * @param {Function} [o.reply]     (text) => Promise — the limb's send bound to
 *                                  this chat + message (a quoted reply)
 * @param {boolean}  [o.enabled]   service: transcribe at all (default true)
 * @param {boolean}  [o.postsBack] service: surface the 👂 ack (default false —
 *                                  fail-closed; the host supplies the real verdict)
 * @param {boolean}  [o.muted]     transport mute → suppress the ack send
 * @param {string}   [o.author]    voice note sender's display name → shown in the
 *                                  👂 ack as "👂 <author> (<Ns>): <text>". Absent →
 *                                  the duration still leads: "👂 (<Ns>) <text>"
 * @param {string}   [o.debounceKey] stable per-note key (`${chatID}:${noteId}`) → debounce
 *                                  + coalesce the rank-1 👂 echo, AND the key a Phase 3b
 *                                  promotion is armed/cancelled under. Omit/null → post
 *                                  immediately (and a rank>1 caller cannot arm — see below).
 * @param {number}   [o.postsBackDelayMs] trailing-debounce window for the rank-1 echo.
 * @param {number}   [o.echoRank]  Phase 3b ORDERED FAILOVER: this node's 1-indexed rank for
 *                                 the note. 1 (default) = post now (rank-1: immediate or
 *                                 debounced, i.e. 3a behavior). >1 = do NOT post now — HOLD
 *                                 the 👂 and ARM a promotion at (rank-1)*echoTimeoutMs,
 *                                 cancellable via cancelPromotion when a higher rank's 👂 is
 *                                 observed. Needs a debounceKey to correlate the cancel.
 * @param {number}   [o.echoTimeoutMs] Phase 3b per-rank promotion step (ms). Only used when
 *                                 echoRank > 1.
 * @param {object}   [o.scheduler] { set, clear } timer injection (tests) — drives BOTH the
 *                                 rank-1 debounce and the rank>1 promotion.
 * @param {Function} [o.onLog]
 * @param {object}   [o.meta]      out-param: the transcriber fills `durationSec`
 *                                 (from the ffmpeg WAV) so the limb can mark the
 *                                 body "(voice transcription, Ns)". String return
 *                                 is unchanged — duration rides the out-param.
 */
export async function transcribeVoiceNote({
  localPath,
  transcribe,
  audioCfg = {},
  reply = null,
  enabled = true,
  postsBack = false,
  muted = false,
  author = null,
  debounceKey = null,
  postsBackDelayMs = POSTS_BACK_DELAY_MS,
  echoRank = 1,
  echoTimeoutMs = 0,
  scheduler = _defaultScheduler,
  onLog = () => {},
  meta = null,
} = {}) {
  if (!localPath) return null;
  if (!enabled) { onLog('transcription service disabled for this room — voice not transcribed'); return null; }
  if (typeof transcribe !== 'function') { onLog('no transcriber injected — voice not transcribed'); return null; }
  let transcript = null;
  const innerMeta = {};
  try { transcript = await transcribe(localPath, audioCfg, onLog, innerMeta); }
  catch (e) { onLog(`transcribe threw: ${e?.message ?? e}`); }
  if (!transcript) return null;
  if (meta && Number.isFinite(innerMeta.durationSec)) meta.durationSec = innerMeta.durationSec;
  // Fidelity post-pass: collapse a degenerate whisper repetition loop
  // ("Michelle. Michelle. …") into an honest "(transcription unreliable)" marker
  // before it reaches the model, the transcript, OR the 👂 ack. Runs for every
  // limb + both transcriber backends, since they all funnel through here.
  const flagged = flagDegenerateTranscript(transcript);
  if (flagged !== transcript) { onLog(`transcription flagged unreliable (repetition loop): ${JSON.stringify(transcript.slice(0, 80))}`); transcript = flagged; }
  if (reply && postsBack && !muted) {
    // 👂 ALREADY ECHOED (operator 2026-07-11): a co-account peer's 👂 for THIS note was already
    // observed (recorded persistently in _observedEchoes by the bridge's observe hook). Stand down
    // across EVERY branch below — the rank>1 promotion-arm (fixes the arming-order double: a slow
    // standby arming AFTER the fast primary already posted, when there was nothing to cancel), the
    // debounced rank-1 branch, and the immediate rank-1 branch. The transcript is still HEARD
    // (returned below); only the POST is skipped.
    if (debounceKey && hasEchoObserved(debounceKey)) {
      onLog('👂 already echoed for this note — standing down');
    } else {
      const line = _ackItem({ author, durationSec: innerMeta.durationSec, transcript });
      if (echoRank > 1) {
        // Phase 3b — this node is NOT rank-1 for the note. Don't post now: ARM a staggered
        // PROMOTION (see _armPromotion) that fires the HELD 👂 at (rank-1)*echoTimeoutMs, but
        // ONLY if no higher rank posts first (the bridge cancels it on observing the note's 👂).
        // The 👂 body + the reply closure (a quoted reply to the note) are identical to rank-1's,
        // so a promoted echo is indistinguishable from the winner's. Needs the per-note key to
        // correlate the observe-and-cancel; without one (a non-batching caller) we can't stand
        // down safely, so we WITHHOLD — fail-safe, since a missed echo beats a double 👂.
        if (!debounceKey) { onLog('👂 promotion NOT armed — rank>1 needs a per-note debounceKey to correlate the observe-and-cancel; withholding'); }
        else {
          const delayMs = (echoRank - 1) * echoTimeoutMs;
          _armPromotion(debounceKey, `👂 ${line}`, reply, onLog, delayMs, scheduler, echoRank);
          onLog(`👂 promotion armed (rank ${echoRank}, +${Math.round(delayMs / 1000)}s, cancels on observed echo) for ${debounceKey}`);
        }
      } else if (debounceKey && postsBackDelayMs > 0) {
        // HEARD already happened (we return below); hold + coalesce the SPOKEN echo.
        _queueAck(debounceKey, line, reply, onLog, postsBackDelayMs, scheduler);
        onLog(`👂 ack queued (debounced ${Math.round(postsBackDelayMs / 1000)}s, ${_pendingAcks.get(debounceKey)?.items.length ?? 1} pending) for ${debounceKey}`);
      } else {
        try { await reply(`👂 ${line}`); }
        catch (e) { onLog(`👂 ack failed: ${e?.message ?? e}`); }
      }
    }
  } else if (!postsBack) {
    onLog(`👂 ack withheld — transcription posts_back disabled for this room`);
  }
  return transcript;
}

/**
 * Mark a voice/audio transcript AS audio for the dispatch body (GENOME §4 / C7.6):
 *   "(voice transcription, 8s) <transcript>"
 * — the duration is omitted when unknown (no transport carries it reliably):
 *   "(voice transcription) <transcript>"
 * Kept separate from `transcribeVoiceNote`'s return (the bare transcript) so the
 * 👂 ack and the media sidecar caption stay un-prefixed — only the body the model
 * reads carries the marker. Shared so every limb formats the marker identically.
 */
export function voiceTranscriptBody(transcript, { durationSec } = {}) {
  const t = String(transcript ?? '');
  const dur = (Number.isFinite(durationSec) && durationSec > 0) ? `, ${Math.round(durationSec)}s` : '';
  return `(voice transcription${dur}) ${t}`;
}
