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

function _queueAck(key, transcript, reply, onLog, delayMs, scheduler) {
  let e = _pendingAcks.get(key);
  if (e) scheduler.clear(e.handle);                       // reset the trailing window
  else { e = { handle: null, items: [], reply, onLog, scheduler }; _pendingAcks.set(key, e); }
  e.items.push(transcript);
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
 * @param {string}   [o.debounceKey] stable chat id → debounce + coalesce the 👂
 *                                  echo per chat. Omit/null → post immediately.
 * @param {number}   [o.postsBackDelayMs] trailing-debounce window for the echo.
 * @param {object}   [o.scheduler] { set, clear } timer injection (tests).
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
  debounceKey = null,
  postsBackDelayMs = POSTS_BACK_DELAY_MS,
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
    if (debounceKey && postsBackDelayMs > 0) {
      // HEARD already happened (we return below); hold + coalesce the SPOKEN echo.
      _queueAck(debounceKey, transcript, reply, onLog, postsBackDelayMs, scheduler);
      onLog(`👂 ack queued (debounced ${Math.round(postsBackDelayMs / 1000)}s, ${_pendingAcks.get(debounceKey)?.items.length ?? 1} pending) for ${debounceKey}`);
    } else {
      try { await reply(`👂 ${transcript}`); }
      catch (e) { onLog(`👂 ack failed: ${e?.message ?? e}`); }
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
