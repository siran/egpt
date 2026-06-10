// transcriptor-smoke.mjs — end-to-end worker smoke test on the GPU machine.
// Generates a sine-tone WAV, starts the REAL transcriptor server with the
// REAL whisper config, and round-trips it through the HTTP client. A sine
// tone transcribes to nothing, so the expected outcome is a clean 422 —
// which proves HMAC auth, the tmp-file plumbing, ffmpeg, and GPU whisper
// all ran. Real speech audio (pass a path as argv[2]) should return text.
//
//   node tests-manual/transcriptor-smoke.mjs [audio-file]
//   node tests-manual/transcriptor-smoke.mjs --server [audio-file]
//      → resident whisper-server mode: spawns whisper-server once and runs
//        TWO requests, printing both timings so the model-load-once win is
//        visible (request 2 should be much faster than request 1).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTranscriptorServer, transcribeViaEndpoint } from '../src/tools/transcriptor.mjs';
import { startWhisperServer, makeWhisperServerTranscriber } from '../src/tools/whisper-server.mjs';

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

const args = process.argv.slice(2);
const serverMode = args.includes('--server');
let audio = args.find((a) => !a.startsWith('--'));
if (!audio) {
  audio = join(tmpdir(), 'egpt-smoke.wav');
  execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '16000', '-ac', '1', audio], { stdio: 'pipe' });
  console.log('generated sine-tone test audio:', audio);
}

let whisper = null, transcribe;
if (serverMode) {
  whisper = await startWhisperServer({
    command: 'C:\\Users\\an\\bin\\whisper.cpp\\Release\\whisper-server.exe',
    model: audioCfg.model_path,
    port: 8089,
    language: 'es',
    onLog: (m) => console.log('[whisper-server]', m),
  });
  transcribe = makeWhisperServerTranscriber({ url: whisper.url, ffmpeg: FFMPEG, language: 'es' });
}

const s = await startTranscriptorServer({ port: 0, bind: '127.0.0.1', keyB64: KEY, audioCfg, transcribe, onLog: (m) => console.log('[worker]', m) });
const endpoint = `http://127.0.0.1:${s.port}`;
const runs = serverMode ? 2 : 1;   // resident mode: 2 requests to show the model-load-once win
for (let i = 1; i <= runs; i++) {
  const t0 = Date.now();
  try {
    const t = await transcribeViaEndpoint(audio, { endpoint, keyB64: KEY, timeoutMs: 180_000 }, (m) => console.log(`[client ${i}]`, m));
    console.log(`TRANSCRIPT ${i}:`, JSON.stringify(t));
  } catch (e) {
    console.log(`CLIENT RESULT ${i}:`, e.message, ' (a 422 on the sine tone = full pipeline OK; whisper just heard nothing)');
  }
  console.log(`round-trip ${i} ms:`, Date.now() - t0);
}
s.close();
whisper?.stop();
process.exit(0);
