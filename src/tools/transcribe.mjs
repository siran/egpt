// transcribe.mjs — transport-agnostic voice-note transcription.
//
// Audio file → ffmpeg (→16kHz mono WAV) → whisper-cli → text. Both the WhatsApp
// bridges (baileys' bundled pipeline and the CDP limb's Download-action) feed
// this. v1 uses whisper-cli (one process per note; simple, no server lifecycle)
// — fine for the occasional voice note; a persistent whisper-server is a later
// optimization. Config: whatsapp.media.audio_transcribe
//   { command (whisper-cli path), model_path (REQUIRED), language, ffmpeg_command }.
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';

function _run(cmd, args, { captureStdout = false } = {}) {
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
 * Transcribe an audio file. Returns the transcript text, or null on failure /
 * disabled. `audioPath` is any ffmpeg-readable file (ogg/opus/m4a/mp3/…).
 */
export async function transcribeAudioFile(audioPath, cfg = {}, log = () => {}) {
  if (cfg.enabled === false) return null;
  const ffmpeg = cfg.ffmpeg_command || 'ffmpeg';
  const whisper = cfg.command || 'whisper-cli';
  const model = cfg.model_path;
  if (!model) { log('transcribe: model_path not set — skipping'); return null; }
  const wav = `${audioPath}.tmp.wav`;
  const t0 = Date.now();
  try {
    // opus/ogg/m4a/mp3 → 16kHz mono PCM WAV
    await _run(ffmpeg, ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    // whisper-cli prints the transcript to stdout with -nt (no timestamps).
    const args = ['-m', model, '-nt', '-f', wav];
    if (cfg.language) args.push('-l', cfg.language);
    if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args.map(String));
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
    try { await unlink(wav); } catch { /* ignore */ }
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
