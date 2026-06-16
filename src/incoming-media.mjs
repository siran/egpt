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
    try { await reply(`👂 ${transcript}`); }
    catch (e) { onLog(`👂 ack failed: ${e?.message ?? e}`); }
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
