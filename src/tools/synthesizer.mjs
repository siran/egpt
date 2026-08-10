// synthesizer.mjs — worker-spine text-to-speech over LAN (operator 2026-08-09).
//
// Mirrors src/tools/transcriptor.mjs's shape: a GPU/services box (DOLLY) runs Piper
// TTS and returns synthesized audio for a text+voice request. The main spine uses it
// when config `voice_service` names a remote engine; a dead/asleep worker is the
// reply-pipeline chunk's problem to fall back on — this module is transport only.
//
// KISS decisions (mirrors transcriptor.mjs):
//   - Auth reuses the SAME HMAC scheme as the transcriptor worker — `signAudio` is
//     imported from transcriptor.mjs (generic over any body bytes, not audio-specific
//     despite the name) rather than reimplemented.
//   - Piper is a Python module (venv), not a standalone exe: `pythonPath -m piper
//     --model <voicesDir>/<voice>.onnx --input-file <tmp.txt> --output-file <tmp.wav>`.
//     Text goes in via --input-file (a UTF-8, no-BOM temp file), not stdin — stdin
//     decodes via the process code page and mangles non-ASCII on Windows.
//   - `voice` becomes part of a filesystem path, so it is whitelisted against the
//     ACTUAL .onnx files present in voicesDir at request time — anything not on that
//     list is a 400, never an attempted file open (closes a path-traversal hole).
//   - Piper's WAV output is transcoded to WhatsApp-ready Opus/ogg via ffmpeg.
//
// Protocol:
//   POST /v1/synthesize  { text, voice }  → 200 audio bytes, Content-Type: audio/ogg
//        headers: x-egpt-ts (epoch ms), x-egpt-sig (base64url HMAC over the JSON body)
//        401 bad/missing/stale signature · 400 bad request / unknown voice · 413 too
//        big · 500 piper/ffmpeg failure
//        failure body: JSON { ok: false, error }

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signAudio } from './transcriptor.mjs';

const execFileAsync = promisify(execFile);

export const SYNTHESIZER_DEFAULT_PORT = 23391;
const MAX_BODY_BYTES = 256 * 1024;   // text requests are tiny JSON; generous ceiling
const SIG_MAX_AGE_MS = 60_000;
const CLIENT_RENDER_TIMEOUT_MS = 20_000;   // decode budget, mirrors voice_service.timeout_ms

// ── signing verification glue (local copy of transcriptor.mjs's _sigOk; the HMAC math
//    itself is NOT reimplemented — signAudio is imported from there). ──────────────
function _sigOk(keyB64, tsMs, bodyBytes, sig) {
  if (!sig || !tsMs) return false;
  if (Math.abs(Date.now() - Number(tsMs)) > SIG_MAX_AGE_MS) return false;
  const expect = Buffer.from(signAudio(keyB64, tsMs, bodyBytes));
  const got = Buffer.from(String(sig));
  return expect.length === got.length && timingSafeEqual(expect, got);
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Real piper render + ffmpeg transcode. Writes a UTF-8-no-BOM temp text file (piper
// takes --input-file, not stdin — stdin decodes via the process code page and mangles
// non-ASCII on Windows), spawns piper, checks BOTH exit code AND that the WAV actually
// exists (a model-load failure exits nonzero before any file is written; a mid-synthesis
// death can leave no file, or a partial one, with a clean exit either), then transcodes
// to Opus/ogg. Returns the ogg bytes (Buffer); throws on any piper/ffmpeg failure. All
// temp files cleaned up in a `finally`, best-effort.
export async function synthesizeWithPiper(text, { pythonPath, modelPath, ffmpegCommand = 'ffmpeg' }) {
  const id = randomBytes(8).toString('hex');
  const txtPath = join(tmpdir(), `egpt-synthesizer-${id}.txt`);
  const wavPath = join(tmpdir(), `egpt-synthesizer-${id}.wav`);
  const oggPath = join(tmpdir(), `egpt-synthesizer-${id}.ogg`);
  try {
    await writeFile(txtPath, text, 'utf8');
    await execFileAsync(pythonPath, [
      '-m', 'piper',
      '--model', modelPath,
      '--input-file', txtPath,
      '--output-file', wavPath,
    ]);
    if (!(await fileExists(wavPath))) throw new Error('piper produced no output file');
    await execFileAsync(ffmpegCommand, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', wavPath,
      '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip',
      oggPath,
    ]);
    return await readFile(oggPath);
  } finally {
    for (const p of [txtPath, wavPath, oggPath]) { try { await unlink(p); } catch { /* tmp cleanup is best-effort */ } }
  }
}

// ── worker side ───────────────────────────────────────────────────────
// Starts the synthesizer HTTP server. `pythonPath` is the piper venv's python.exe;
// `voicesDir` holds the whitelisted `<voice>.onnx` model files. `synthesize` is the
// injected piper+ffmpeg pipeline (mirrors transcriptor.mjs's `transcribe` seam) —
// defaults to the real synthesizeWithPiper; tests inject a fake so no real process
// spawns. Returns { port, close }.
export async function startSynthesizerServer({
  port = SYNTHESIZER_DEFAULT_PORT,
  bind = '127.0.0.1',
  keyB64,
  pythonPath,
  voicesDir,
  ffmpegCommand = 'ffmpeg',
  synthesize = synthesizeWithPiper,
  onLog = () => {},
} = {}) {
  if (!keyB64) throw new Error('startSynthesizerServer: keyB64 (bus.key) is required');
  if (!pythonPath) throw new Error('startSynthesizerServer: pythonPath is required');
  if (!voicesDir) throw new Error('startSynthesizerServer: voicesDir is required');

  const server = createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method !== 'POST' || req.url !== '/v1/synthesize') {
      return json(404, { ok: false, error: 'not found' });
    }

    const chunks = [];
    let size = 0, overflow = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { overflow = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { /* destroyed on overflow / client drop — response below or never */ });
    req.on('end', async () => {
      if (overflow) return json(413, { ok: false, error: 'body too large' });
      const body = Buffer.concat(chunks);
      const ts = req.headers['x-egpt-ts'];
      const sig = req.headers['x-egpt-sig'];
      if (!_sigOk(keyB64, ts, body, sig)) {
        onLog(`synthesizer: REJECTED unsigned/stale request from ${req.socket.remoteAddress}`);
        return json(401, { ok: false, error: 'bad signature' });
      }

      let text, voice;
      try {
        ({ text, voice } = JSON.parse(body.toString('utf8')));
      } catch {
        return json(400, { ok: false, error: 'bad JSON body' });
      }
      if (!text || typeof text !== 'string') return json(400, { ok: false, error: 'text is required' });
      if (!voice || typeof voice !== 'string') return json(400, { ok: false, error: 'voice is required' });

      // Whitelist `voice` against the ACTUAL .onnx files present, AT REQUEST TIME — this
      // is what closes the path-traversal hole (voice becomes a filesystem path below).
      let entries;
      try {
        entries = await readdir(voicesDir);
      } catch (e) {
        onLog(`synthesizer: ERROR reading voicesDir — ${e?.message ?? e}`);
        return json(500, { ok: false, error: 'voices directory unavailable' });
      }
      const known = new Set(entries.filter((f) => f.endsWith('.onnx')).map((f) => f.slice(0, -'.onnx'.length)));
      if (!known.has(voice)) {
        onLog(`synthesizer: REJECTED unknown voice "${voice}" from ${req.socket.remoteAddress}`);
        return json(400, { ok: false, error: 'unknown voice' });
      }

      const t0 = Date.now();
      try {
        const modelPath = join(voicesDir, `${voice}.onnx`);
        const audio = await synthesize(text, { pythonPath, modelPath, ffmpegCommand });
        const ms = Date.now() - t0;
        onLog(`synthesizer: ${text.length}ch (${voice}) → ${audio.length}b in ${ms}ms for ${req.socket.remoteAddress}`);
        res.writeHead(200, { 'Content-Type': 'audio/ogg' });
        res.end(audio);
      } catch (e) {
        onLog(`synthesizer: ERROR — ${e?.message ?? e}`);
        json(500, { ok: false, error: String(e?.message ?? e) });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  const actualPort = server.address().port;
  onLog(`synthesizer: listening on ${bind}:${actualPort}`);
  return {
    port: actualPort,
    close: () => { try { server.closeAllConnections?.(); } catch { /* node <18.2 */ } server.close(); },
  };
}

// ── main-spine side ───────────────────────────────────────────────────
// POST one text+voice request to a worker. Returns the audio bytes (Buffer).
// Throws on transport/auth/server errors — the reply-pipeline chunk decides fallback.
export async function synthesizeViaEndpoint(text, voice, { endpoint, keyB64, timeoutMs = CLIENT_RENDER_TIMEOUT_MS }, log = () => {}) {
  const body = Buffer.from(JSON.stringify({ text, voice }), 'utf8');
  const ts = Date.now();
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/synthesize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-egpt-ts': String(ts),
      'x-egpt-sig': signAudio(keyB64, ts, body),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio/')) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`worker ${res.status}: ${j.error ?? 'synthesis failed'}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  log(`synthesize: remote worker → ${audio.length}b for ${voice}`);
  return audio;
}
