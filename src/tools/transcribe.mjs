// transcribe.mjs — transport-agnostic voice-note transcription.
//
// Audio file → ffmpeg (→16kHz mono WAV) → whisper-cli → text. Both the WhatsApp
// bridges (baileys' bundled pipeline and the CDP limb's Download-action) feed
// this. v1 uses whisper-cli (one process per note; simple, no server lifecycle)
// — fine for the occasional voice note; a persistent whisper-server is a later
// optimization. Config: whatsapp.media.audio_transcribe
//   { command (whisper-cli path), model_path (REQUIRED), language, ffmpeg_command }.
import { spawn } from 'node:child_process';
import { unlink, stat } from 'node:fs/promises';

// A 16kHz · mono · 16-bit PCM WAV (whisper's input, produced by convertToWav16k)
// has a fixed byte rate, so its duration is exact arithmetic on the file size —
// no ffprobe/extra process. ffmpeg already runs before whisper, so this is free
// (operator 2026-06-16: "ffmpeg should give the stats"). Used to mark voice notes
// "(voice transcription, Ns)" without guessing.
const WAV16K_BYTES_PER_SEC = 16000 * 1 * 2;
const WAV_HEADER_BYTES = 44;
export function wavDurationSec(byteLength) {
  return Math.max(0, (Number(byteLength) - WAV_HEADER_BYTES) / WAV16K_BYTES_PER_SEC);
}

// Build the whisper-cli argv. Pure + exported so the anti-repetition defaults are
// test-locked. Anti-repetition is owned by whisper itself (operator 2026-06-16):
//   -mc 0  don't carry text-context across segments — the lever against the
//          "Michelle. Michelle. …" loop (== condition_on_previous_text:false).
//   -sns   suppress non-speech tokens so silence/music stop hallucinating repeats.
// Temperature fallback (-tpi) + entropy threshold (-et) stay at whisper's
// on-by-default. Verified against the live whisper.cpp build (--max-context /
// --suppress-nst). Defaults FIRST so cfg.extra_args can override; anti_repetition:
// false opts out. The transcript-repeat-guard post-pass is the backend-agnostic
// net for whatever still slips through (C3.5).
export function buildWhisperArgs({ model, wav, language, extra_args, anti_repetition } = {}) {
  const args = ['-m', model, '-nt', '-f', wav];
  if (language) args.push('-l', String(language));
  if (anti_repetition !== false) args.push('-mc', '0', '-sns');
  if (Array.isArray(extra_args)) args.push(...extra_args.map(String));
  return args;
}

export function _run(cmd, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return reject(e); }
    if (captureStdout) child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}${err ? `: ${err.trim().slice(-200)}` : ''}`));
    });
  });
}

/**
 * Convert any ffmpeg-readable audio (ogg/opus/m4a/mp3/…) to a 16kHz mono
 * PCM WAV — whisper's required input. Returns the temp wav path; the
 * caller owns cleanup (unlink). Shared by the whisper-cli path here and
 * the whisper-server path in whisper-server.mjs.
 */
export async function convertToWav16k(audioPath, ffmpeg = 'ffmpeg') {
  const wav = `${audioPath}.tmp.wav`;
  await _run(ffmpeg, ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  return wav;
}

/**
 * Transcribe an audio file. Returns the transcript text, or null on failure /
 * disabled. `audioPath` is any ffmpeg-readable file (ogg/opus/m4a/mp3/…).
 */
export async function transcribeAudioFile(audioPath, cfg = {}, log = () => {}, meta = null) {
  if (cfg.enabled === false) return null;
  const ffmpeg = cfg.ffmpeg_command || 'ffmpeg';
  const whisper = cfg.command || 'whisper-cli';
  const model = cfg.model_path;
  if (!model) { log('transcribe: model_path not set — skipping'); return null; }
  const t0 = Date.now();
  let wav;
  try {
    wav = await convertToWav16k(audioPath, ffmpeg);
    // The ffmpeg step we just ran gives the duration for free (#3, op 2026-06-16).
    if (meta) { try { meta.durationSec = wavDurationSec((await stat(wav)).size); } catch { /* best-effort */ } }
    // whisper-cli prints the transcript to stdout with -nt (no timestamps).
    const args = buildWhisperArgs({ model, wav, language: cfg.language, extra_args: cfg.extra_args, anti_repetition: cfg.anti_repetition });
    const stdout = await _run(whisper, args, { captureStdout: true });
    // whisper-cli may emit a few non-transcript lines; keep printable content,
    // collapse whitespace (whisper splits long output across segment lines).
    const text = stdout.split('\n').map(l => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    log(`transcribe: ${audioPath.split(/[\\/]/).pop()} → ${text.length}ch in ${Date.now() - t0}ms`);
    return text || null;
  } catch (e) {
    log(`transcribe: failed for ${audioPath.split(/[\\/]/).pop()} — ${e?.message ?? e}`);
    return null;
  } finally {
    if (wav) { try { await unlink(wav); } catch { /* ignore */ } }
  }
}

// quick CLI: node src/tools/transcribe.mjs <audiofile> [lang]
if (process.argv[1]?.endsWith('transcribe.mjs')) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node src/tools/transcribe.mjs <audiofile> [lang]'); process.exit(1); }
  const cfg = {
    ffmpeg_command: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
    command: 'C:\\Users\\an\\bin\\whisper.cpp\\whisper-cli.exe',
    model_path: 'C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin',
    language: process.argv[3] || 'es',
  };
  transcribeAudioFile(file, cfg, m => console.log('  ', m)).then(t => { console.log('\nTRANSCRIPT:', JSON.stringify(t)); process.exit(0); });
}
