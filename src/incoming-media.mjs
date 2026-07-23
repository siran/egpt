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
// the host's `_saveIncomingMedia` (egpt-spine.mjs), reached via the limb's `onMedia`
// callback — also limb-agnostic.
//
// IMPORTANT: this module imports NOTHING Node-only. telegram.mjs (which imports
// it) is bundled for the browser extension; pulling in transcribe.mjs (which
// needs node:child_process) would break that build. The transcriber is INJECTED
// by the host (egpt-spine.mjs / the Beeper limb), which run in Node.

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
// as in 3a — it HOLDS the already-made transcript and schedules the post at (rank-1)*echoTimeoutMs.
// STAGGERED by rank so failover is ORDERED: rank-2 fires at +T, rank-3 at +2T, … so when rank-2 posts,
// rank-3's later timer re-checks coverage, sees the note already covered, and stands down → still
// exactly ONE poster even if several top ranks are down. NOT dedup: the rank is a deterministic UPFRONT
// pre-assignment; the delay only covers an offline/slow higher rank. Distinct from _pendingAcks (rank-1's
// debounce) because a promotion is individually keyed by note (`${chatID}:${noteId}`).
//
// SUPPRESSION IS BY ON-DEMAND COVERAGE QUERY (operator 2026-07-12): a promotion RE-CHECKS `checkCovered`
// the instant its timer fires — it posts only if the note is STILL uncovered (no matching reply exists in
// the chat yet). This replaces the old in-memory observe-and-cancel + observed-set entirely: the query
// reads the chat directly, so a higher rank's 👂 is seen whether it arrived before or after this arm, in
// any delivery order, with no shadow store and no marker in the check (see src/bridges/beeper.mjs
// noteCovered).
//
// HAZARD (documented — the operator's one real trade-off): a waiter cannot distinguish "rank-1 DOWN"
// from "rank-1 SLOW". If echoTimeoutMs < rank-1's worst-case transcribe+post+network latency, rank-2
// pre-empts a merely-slow winner → DOUBLE 👂. So the boot default is GENEROUS (~20s); tune from live
// tests. Too-long = slow failover; too-short = double.
const _pendingPromotions = new Map();   // key -> { rank, handle, scheduler }

// Arm a rank>1 promotion: post `body` at `delayMs`, but ONLY if the note is still uncovered when the
// timer fires (checkCovered(transcript) re-queried at fire time replaces the deleted observe-and-cancel).
function _armPromotion(key, body, reply, onLog, delayMs, scheduler, rank, checkCovered, transcript) {
  const existing = _pendingPromotions.get(key);
  if (existing) { try { scheduler.clear(existing.handle); } catch { /* ignore */ } }   // re-arm (defensive; a note is processed once)
  const e = { rank, handle: null, scheduler };
  e.handle = scheduler.set(async () => {
    _pendingPromotions.delete(key);   // fired → no longer pending
    try {
      if (await checkCovered(transcript)) { onLog('👂 promotion stood down — covered'); return; }
      await reply(body);
    } catch (err) { onLog(`👂 promotion post failed: ${err?.message ?? err}`); }
  }, delayMs);
  if (e.handle && typeof e.handle.unref === 'function') e.handle.unref();   // don't pin the event loop (no-op in browser)
  _pendingPromotions.set(key, e);
}

export function hasPendingPromotion(key) { return _pendingPromotions.has(key); }

// Test isolation: clear all promotion timers + pending state.
export function _resetPromotions() {
  for (const e of _pendingPromotions.values()) { try { e.scheduler.clear(e.handle); } catch { /* ignore */ } }
  _pendingPromotions.clear();
}

// The in-chat 👂 echo MARKER — the prefix every posted transcript ack (immediate, debounced, or
// promoted) starts with. It is written into the echo body ONLY; it is NEVER read by a decision — the
// coverage query matches on normalized WORD TOKENS (src/text-similarity.mjs), which drop all emoji,
// so no marker can reach a post/no-post `if`.
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
 *                                  promotion is armed under. Omit/null → post
 *                                  immediately (and a rank>1 caller cannot arm — see below).
 * @param {number}   [o.postsBackDelayMs] trailing-debounce window for the rank-1 echo.
 * @param {Function} [o.checkCovered] async (transcript) => bool — the ON-DEMAND coverage query
 *                                 (bridge's noteCovered): is a reply to THIS note already in the
 *                                 chat whose transcript matches ours? Consulted BEFORE any post/arm
 *                                 (covered → stand down, still HEARD) AND RE-QUERIED when a rank>1
 *                                 promotion timer fires (post only if STILL uncovered). Default
 *                                 async ()=>false → never covered (a solo/non-batching caller posts
 *                                 as before). Replaces the deleted in-memory observed-set.
 * @param {number}   [o.echoRank]  Phase 3b ORDERED FAILOVER: this node's 1-indexed rank for
 *                                 the note. 1 (default) = post now (rank-1: immediate or
 *                                 debounced, i.e. 3a behavior). >1 = do NOT post now — HOLD
 *                                 the 👂 and ARM a promotion at (rank-1)*echoTimeoutMs that posts
 *                                 only if the note is STILL uncovered at fire time (checkCovered
 *                                 re-queried). Needs a debounceKey to key the promotion.
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
  checkCovered = async () => false,
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
    // 👂 ALREADY COVERED (operator 2026-07-12): ask the CHAT whether a reply to THIS note already
    // carries a matching transcript (bridge's noteCovered, wired in as checkCovered). If so, stand
    // down across EVERY branch below — the rank>1 promotion-arm, the debounced rank-1 branch, and the
    // immediate rank-1 branch. The transcript is still HEARD (returned below); only the POST is
    // skipped. This is the ONE authority (the chat is the source of truth) — no shadow store, no
    // marker in the check, order-independent.
    if (await checkCovered(transcript)) {
      onLog('👂 already covered — standing down');
    } else {
      const line = _ackItem({ author, durationSec: innerMeta.durationSec, transcript });
      // ARM a promotion instead of posting now when this node is NOT rank-1 (Phase 3b ordered
      // failover): rank-R holds its 👂 and posts at (rank-1)*echoTimeoutMs, but ONLY if the note is
      // STILL uncovered when the timer fires (checkCovered re-queried in _armPromotion). rank-1 posts
      // now (immediate/debounced). A missed higher rank is thus covered by the next rank's delayed,
      // coverage-gated post — still exactly one poster.
      const delayMs = (echoRank - 1) * echoTimeoutMs;
      if (echoRank > 1) {
        // The 👂 body + reply closure (a quoted reply to the note) are identical to rank-1's, so a
        // promoted echo is indistinguishable from the winner's. Needs the per-note key to key the
        // promotion; without one (a non-batching caller) we WITHHOLD — fail-safe, a missed echo beats
        // a double 👂.
        if (!debounceKey) { onLog('👂 promotion NOT armed — the arm path needs a per-note debounceKey; withholding'); }
        else {
          _armPromotion(debounceKey, `👂 ${line}`, reply, onLog, delayMs, scheduler, echoRank, checkCovered, transcript);
          onLog(`👂 promotion armed (rank ${echoRank}, +${Math.round(delayMs / 1000)}s, re-checks coverage at fire) for ${debounceKey}`);
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
