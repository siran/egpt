// transcriptor-smoke.mjs — end-to-end worker smoke test on the GPU machine.
// Generates a sine-tone WAV, starts the REAL transcriptor server with the
// REAL whisper config, and round-trips it through the HTTP client. A sine
// tone transcribes to nothing, so the expected outcome is a clean 422 —
// which proves HMAC auth, the tmp-file plumbing, ffmpeg, and GPU whisper
// all ran. Real speech audio (pass a path as argv[2]) should return text.
//
//   node tests-manual/transcriptor-smoke.mjs [audio-file]
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTranscriptorServer, transcribeViaEndpoint } from '../src/tools/transcriptor.mjs';

const FFMPEG = 'C:\\Users\\an\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe';
const audioCfg = {
  enabled: true,
  command: 'C:\\Users\\an\\bin\\whisper.cpp\\Release\\whisper-cli.exe',
  ffmpeg_command: FFMPEG,
  model_path: 'C:\\Users\\an\\bin\\whisper.cpp\\models\\ggml-large-v3.bin',
  language: 'es',
};
// Throwaway key — deliberately NOT ~/.egpt/bus.key (that file must be
// copied from the main spine, never generated here).
const KEY = 'c21va2Uta2V5LXNtb2tlLWtleS1zbW9rZS1rZXk';

let audio = process.argv[2];
if (!audio) {
  audio = join(tmpdir(), 'egpt-smoke.wav');
  execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '16000', '-ac', '1', audio], { stdio: 'pipe' });
  console.log('generated sine-tone test audio:', audio);
}

const s = await startTranscriptorServer({ port: 0, bind: '127.0.0.1', keyB64: KEY, audioCfg, onLog: (m) => console.log('[worker]', m) });
const t0 = Date.now();
try {
  const t = await transcribeViaEndpoint(audio, { endpoint: `http://127.0.0.1:${s.port}`, keyB64: KEY, timeoutMs: 180_000 }, (m) => console.log('[client]', m));
  console.log('TRANSCRIPT:', JSON.stringify(t));
} catch (e) {
  console.log('CLIENT RESULT:', e.message, ' (a 422 here on the sine tone = full pipeline OK; whisper just heard nothing)');
}
console.log('round-trip ms:', Date.now() - t0);
s.close();
process.exit(0);
