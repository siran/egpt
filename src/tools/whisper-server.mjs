// whisper-server.mjs — resident whisper.cpp server: load the model ONCE.
//
// The per-note whisper-cli path (transcribe.mjs) reloads the GGUF on every
// call — ~10s+ fixed overhead with large-v3 (operator-measured on the GPU
// worker, 2026-06-10). whisper.cpp ships `whisper-server.exe`, an HTTP
// server that loads the model at startup and keeps it resident, exposing
// an OpenAI-shaped POST /inference (multipart: file + response_format).
// This module owns that server's lifecycle (spawn, readiness wait, crash
// respawn with backoff) and a transcribe-over-HTTP function — mirroring
// the resident llama-server pattern egpt already uses for @l.
//
// Used by the transcriptor WORKER (src/tools/transcriptor.mjs wiring in
// egpt.mjs) so the GPU box answers in ~encode+decode time, not +model-
// load. The main spine's LOCAL fallback stays whisper-cli (rare path; no
// reason to hold a resident model there).
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { convertToWav16k } from './transcribe.mjs';
import { reapPort } from './reap-port.mjs';

const READY_POLL_MS = 500;

// Spawn + supervise a resident whisper-server. Returns { url, stop,
// isAlive }. Respawns on crash with backoff; stop() is idempotent.
export async function startWhisperServer({
  command,                 // path to whisper-server(.exe)
  model,                   // GGUF model path (-m)
  host = '127.0.0.1',
  port = 8089,
  language,                // optional ISO 639-1 default (-l); per-request can override
  extraArgs = [],
  readyTimeoutMs = 120_000,
  onLog = () => {},
} = {}) {
  if (!command) throw new Error('startWhisperServer: command (whisper-server path) required');
  if (!model) throw new Error('startWhisperServer: model path required');
  const url = `http://${host}:${port}`;

  let proc = null, stopped = false, backoff = 1000, ready = false, stableTimer = null;

  const spawnOnce = () => {
    if (stopped) return;
    const args = ['-m', model, '--host', host, '--port', String(port)];
    if (language) args.push('-l', String(language));
    args.push(...extraArgs.map(String));
    // Free the port first: a prior whisper-server orphaned by a soft restart
    // (Windows doesn't kill the child with the parent) would still hold it and
    // block this bind. The daemon is elevated, so it can reap it. See reap-port.mjs.
    reapPort(port, onLog);
    onLog(`whisper-server: spawning ${command} ${args.join(' ')}`);
    proc = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout?.on('data', (d) => { const s = d.toString().trim(); if (s) onLog(`whisper-server: ${s.slice(0, 200)}`); });
    proc.stderr?.on('data', (d) => { const s = d.toString().trim(); if (/error|fail|load/i.test(s)) onLog(`whisper-server: ${s.slice(0, 200)}`); });
    proc.on('exit', (code) => {
      ready = false;
      proc = null;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      if (stopped) return;
      onLog(`whisper-server: exited code=${code}; respawning in ${backoff}ms`);
      setTimeout(spawnOnce, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    proc.on('error', (e) => onLog(`whisper-server: spawn error — ${e?.message ?? e}`));
    // Reset backoff after a stable minute (a fast crash-loop keeps the cap).
    stableTimer = setTimeout(() => { if (proc && !stopped) backoff = 1000; }, 60_000);
  };

  const pingReady = async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return r.status > 0;   // any HTTP response = listener is up
    } catch { return false; }
  };

  spawnOnce();
  const deadline = Date.now() + readyTimeoutMs;
  while (!ready && Date.now() < deadline && !stopped) {
    if (await pingReady()) { ready = true; break; }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  if (!ready) onLog(`whisper-server: NOT ready within ${readyTimeoutMs}ms — first request will retry the readiness check`);
  else onLog(`whisper-server: ready at ${url}`);

  return {
    url,
    isAlive: () => ready && !!proc,
    stop: () => {
      stopped = true;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      try { proc?.kill(); } catch { /* already gone */ }
      proc = null;
    },
  };
}

// Transcribe one audio file via a running whisper-server's /inference.
// Converts to 16kHz WAV first (whisper's required input), POSTs multipart,
// returns the transcript text (or null on empty). Throws on transport/HTTP
// error so the caller can fall back.
export async function transcribeViaWhisperServer(audioPath, { url, ffmpeg = 'ffmpeg', language, timeoutMs = 120_000, convert = convertToWav16k }, log = () => {}) {
  const t0 = Date.now();
  let wav;
  try {
    wav = await convert(audioPath, ffmpeg);
    const bytes = await readFile(wav);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (language) form.append('language', String(language));
    const res = await fetch(`${url.replace(/\/+$/, '')}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`/inference ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json().catch(() => ({}));
    const text = String(j.text ?? '').trim();
    log(`whisper-server: ${audioPath.split(/[\\/]/).pop()} → ${text.length}ch in ${Date.now() - t0}ms`);
    return text || null;
  } finally {
    if (wav) { try { await unlink(wav); } catch { /* ignore */ } }
  }
}

// Adapter: a (audioPath, cfg, log) => text function — the shape
// startTranscriptorServer's `transcribe` option expects — bound to a
// running server. Errors return null so the worker reports a 422 (and the
// main spine falls back to its local whisper), never a 500 storm.
export function makeWhisperServerTranscriber({ url, ffmpeg, language, timeoutMs, convert }) {
  return async function transcribe(audioPath, cfg = {}, log = () => {}) {
    try {
      return await transcribeViaWhisperServer(audioPath, {
        url,
        ffmpeg: cfg.ffmpeg_command || ffmpeg || 'ffmpeg',
        language: cfg.language ?? language,
        timeoutMs,
        convert,
      }, log);
    } catch (e) {
      log(`whisper-server: transcribe failed — ${e?.message ?? e}`);
      return null;
    }
  };
}
