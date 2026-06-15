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
} = {}) {
  if (!localPath) return null;
  if (!enabled) { onLog('transcription service disabled for this room — voice not transcribed'); return null; }
  if (typeof transcribe !== 'function') { onLog('no transcriber injected — voice not transcribed'); return null; }
  let transcript = null;
  try { transcript = await transcribe(localPath, audioCfg, onLog); }
  catch (e) { onLog(`transcribe threw: ${e?.message ?? e}`); }
  if (!transcript) return null;
  if (reply && postsBack && !muted) {
    try { await reply(`👂 ${transcript}`); }
    catch (e) { onLog(`👂 ack failed: ${e?.message ?? e}`); }
  } else if (!postsBack) {
    onLog(`👂 ack withheld — transcription posts_back disabled for this room`);
  }
  return transcript;
}
