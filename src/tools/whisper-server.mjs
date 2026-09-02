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
// egpt-spine.mjs) so the GPU box answers in ~encode+decode time, not +model-
// load. The main spine's LOCAL fallback stays whisper-cli (rare path; no
// reason to hold a resident model there).
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { convertToWav16k, wavDurationSec } from './transcribe.mjs';
import { reapPort } from './reap-port.mjs';

const READY_POLL_MS = 500;

// Spawn + supervise a resident whisper-server. Returns { url, stop,
// isAlive }. Respawns on crash with backoff; stop() is idempotent.
//
// ADOPTION (operator 2026-09-02: "if installed, spine can monitor whisper.
// whisper is not sine qua non"). If something is ALREADY serving on the port,
// this does not reap it and does not spawn — it ADOPTS it: monitors it by the
// same readiness probe, and never kills what it did not start. That is what
// lets whisper-server run as an ordinary Windows service, in Session 0, with a
// lifetime independent of the spine's — so a forced restart with nobody logged
// in leaves transcription up.
//
// It was NOT possible before, and the failure was not subtle: reapPort below
// KILLS whatever holds the port and takes it, while a service is configured to
// restart on exit. Two supervisors, one port, flapping forever (measured on
// dolly, 2026-09-02). The probe-before-reap is the whole fix.
//
// An adopted server that DIES is not replaced here — isAlive goes false and the
// transcription chain falls through to whisper-cli, its always-available floor.
// That is the "not sine qua non" half: the spine reports the truth about a
// server it does not own rather than fighting the service manager for it.
export async function startWhisperServer({
  command,                 // path to whisper-server(.exe)
  model,                   // GGUF model path (-m)
  host = '127.0.0.1',
  port = 8089,
  language,                // optional ISO 639-1 default (-l); per-request can override
  extraArgs = [],
  antiRepetition = true,   // -mc 0 -sns at launch (the server owns the loop, op 2026-06-16)
  readyTimeoutMs = 120_000,
  onLog = () => {},
  // INJECTION SEAMS (default to the real thing) — the adoption path has to be
  // provable without a whisper binary on the box running the tests.
  spawn: spawnFn = spawn,
  reap: reapFn = reapPort,
  // How often an ADOPTED server is re-probed. Only used when adopted: a server we
  // spawned reports liveness from its own process handle, which needs no polling.
  adoptedProbeMs = 15_000,
} = {}) {
  if (!command) throw new Error('startWhisperServer: command (whisper-server path) required');
  if (!model) throw new Error('startWhisperServer: model path required');
  const url = `http://${host}:${port}`;

  let proc = null, stopped = false, backoff = 1000, ready = false, stableTimer = null;
  // adopted: this server was already running when we arrived. We monitor it; we never own it.
  let adopted = false, adoptedTimer = null;

  const spawnOnce = () => {
    if (stopped) return;
    const args = ['-m', model, '--host', host, '--port', String(port)];
    if (language) args.push('-l', String(language));
    // Anti-repetition at the resident server (the LIVE path, op 2026-06-16): same
    // flags as the whisper-cli builder — -mc 0 (no cross-segment context) + -sns
    // (suppress non-speech tokens). Verified on the build's cli; if the server
    // rejected one it would fail readiness and the spine falls back to local
    // whisper (slower, not broken). extraArgs after, so config can override.
    if (antiRepetition) args.push('-mc', '0', '-sns');
    args.push(...extraArgs.map(String));
    // Free the port first: a prior whisper-server orphaned by a soft restart
    // (Windows doesn't kill the child with the parent) would still hold it and
    // block this bind. The daemon is elevated, so it can reap it. See reap-port.mjs.
    reapFn(port, onLog);
    onLog(`whisper-server: spawning ${command} ${args.join(' ')}`);
    proc = spawnFn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

  // PROBE FIRST. An answer here means a whisper-server is already serving this port —
  // a service, or a previous spine's resident server — so adopt it rather than reap it.
  if (await pingReady()) {
    adopted = true;
    ready = true;
    onLog(`whisper-server: ADOPTED the server already serving ${url} — monitoring it, not supervising it`);
    // Monitor: keep `ready` honest so isAlive stops lying the moment it goes away.
    // unref so this timer never holds the process open.
    adoptedTimer = setInterval(async () => {
      if (stopped) return;
      const up = await pingReady();
      if (up !== ready) onLog(`whisper-server: adopted server at ${url} is now ${up ? 'up' : 'DOWN — falling through to the cli floor'}`);
      ready = up;
    }, adoptedProbeMs);
    adoptedTimer.unref?.();
  } else {
    spawnOnce();
  }
  const deadline = Date.now() + readyTimeoutMs;
  while (!ready && Date.now() < deadline && !stopped) {
    if (await pingReady()) { ready = true; break; }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  if (!ready) onLog(`whisper-server: NOT ready within ${readyTimeoutMs}ms — first request will retry the readiness check`);
  else onLog(`whisper-server: ready at ${url}`);

  return {
    url,
    // An adopted server has no `proc` of ours — its liveness is the probe's verdict.
    isAlive: () => ready && (adopted || !!proc),
    // True when this server belongs to someone else (a service, another spine).
    isAdopted: () => adopted,
    stop: () => {
      stopped = true;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      if (adoptedTimer) { clearInterval(adoptedTimer); adoptedTimer = null; }
      // NEVER kill an adopted server: we did not start it, and on a service-managed
      // box killing it here is exactly the flap this module now avoids.
      if (!adopted) { try { proc?.kill(); } catch { /* already gone */ } }
      proc = null;
    },
  };
}

// Transcribe one audio file via a running whisper-server's /inference.
// Converts to 16kHz WAV first (whisper's required input), POSTs multipart,
// returns the transcript text (or null on empty). Throws on transport/HTTP
// error so the caller can fall back.
export async function transcribeViaWhisperServer(audioPath, { url, ffmpeg = 'ffmpeg', language, timeoutMs = 120_000, convert = convertToWav16k }, log = () => {}, meta = null) {
  const t0 = Date.now();
  let wav;
  try {
    wav = await convert(audioPath, ffmpeg);
    const bytes = await readFile(wav);
    if (meta) meta.durationSec = wavDurationSec(bytes.length);   // duration from the WAV we just made (#3)
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
  return async function transcribe(audioPath, cfg = {}, log = () => {}, meta = null) {
    try {
      return await transcribeViaWhisperServer(audioPath, {
        url,
        ffmpeg: cfg.ffmpeg_command || ffmpeg || 'ffmpeg',
        language: cfg.language ?? language,
        timeoutMs,
        convert,
      }, log, meta);
    } catch (e) {
      log(`whisper-server: transcribe failed — ${e?.message ?? e}`);
      return null;
    }
  };
}
