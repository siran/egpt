// synthesizer-worker.mjs — the WORKER ROLE for Piper text-to-speech (operator 2026-08-09).
// Topology: ONE main spine owns all conversation context + every outbound send; other
// machines (e.g. DOLLY, the GPU box) run the SAME egpt in a WORKER role. `synthesizer`
// is the TTS counterpart to `transcriptor` (src/spine/transcriptor-worker.mjs): it serves
// the signed POST /v1/synthesize endpoint (src/tools/synthesizer.mjs) for the main
// spine's voice replies — main spine sends text, the worker renders it with Piper and
// transcodes to Opus/ogg. This module owns the worker's lifecycle inside boot: config
// resolution, the :23391 HTTP server, and its teardown.
//
// UNLIKE transcriptor-worker.mjs there is no resident supervised process here — piper
// and ffmpeg are spawned per-request, inside startSynthesizerServer itself. This module
// only wires the HTTP server up/down.
//
// FIRE-AND-FORGET: start() is not awaited by boot — mirrors transcriptor-worker.mjs so a
// slow/failing worker start never stalls the spine's tick + alive heartbeat. start() is
// itself awaitable so callers (tests) can observe the resolved wiring deterministically.

import { join } from 'node:path';
import { startSynthesizerServer as realStartSynthesizerServer, SYNTHESIZER_DEFAULT_PORT } from '../tools/synthesizer.mjs';

// ── config resolution (mirrors transcriptor-worker.mjs's resolveToken shape — pure +
//    exported so the fallback ladder is test-locked). `synthesizer:` is the WORKER-role
//    block (mirrors `transcriptor:`); `voice_service:` is the CLIENT/rung-resolved block
//    (mirrors `transcription_service:`) — a node running both roles may collapse the
//    token onto either, so both are read, worker's own block first. ──────────────────
export function resolveToken(cfg) {
  return cfg?.synthesizer?.server?.token ?? cfg?.voice_service?.server?.token ?? null;
}

// ffmpeg binary path. Deliberately NOT coupled to transcription.cli.ffmpeg_command in
// code — the synthesizer and transcription config trees stay logically separate; an
// operator who wants the same ffmpeg path in both is free to set it in both configs,
// that's a config-time choice, not a code-level fallback.
export function resolveFfmpegCommand(cfg) {
  return cfg?.synthesizer?.ffmpeg_command ?? 'ffmpeg';
}

export function createSynthesizerWorker({
  getConfig = () => ({}),
  // process-boundary seam — defaults to the real spawner; tests inject a fake so no real
  // port is bound (piper/ffmpeg spawn per-request inside startSynthesizerServer itself).
  startSynthesizerServer = realStartSynthesizerServer,
  onLog = () => {},
} = {}) {
  let server = null, closed = false;

  async function start() {
    const cfg = getConfig() ?? {};
    const scfg = cfg.synthesizer;
    if (!scfg?.enabled) return;   // gate: not a synthesizer worker → nothing to run

    // RADIO_PIPER is read directly from the environment — an operator must NOT hardcode
    // this path in config.yaml (station-engineer requirement: it's machine-local layout,
    // not a portable config value).
    const radioPiper = process.env.RADIO_PIPER;
    if (!radioPiper) {
      onLog('!! synthesizer enabled but RADIO_PIPER env var unset — refusing to start. Set RADIO_PIPER to the piper install root on this machine (contains venv/ and voices/).');
      return;
    }

    const keyB64 = resolveToken(cfg);
    if (!keyB64) {
      onLog('!! synthesizer enabled but voice token unset — refusing to start an unauthenticated server. Set synthesizer.server.token (same value as the main spine) in config.yaml.');
      return;
    }

    const pythonPath = join(radioPiper, 'venv', 'Scripts', 'python.exe');
    const voicesDir = join(radioPiper, 'voices');
    const ffmpegCommand = resolveFfmpegCommand(cfg);
    const bind = scfg.bind || '127.0.0.1';   // default 127.0.0.1 — set synthesizer.bind to the LAN ip to expose
    const port = Number(scfg.port) > 0 ? Number(scfg.port) : SYNTHESIZER_DEFAULT_PORT;
    try {
      const s = await startSynthesizerServer({ port, bind, keyB64, pythonPath, voicesDir, ffmpegCommand, onLog });
      if (closed) { s.close(); return; }   // stopped mid-start
      server = s;
      onLog(`synthesizer: worker role up on ${bind}:${s.port}`);
    } catch (e) {
      onLog(`!! synthesizer failed to start: ${e?.message ?? e}`);
    }
  }

  // Teardown: close the HTTP server. Idempotent; safe if start() is still in flight (the
  // mid-start `closed` check catches it). boot.stop() calls this.
  function stop() {
    closed = true;
    try { server?.close(); } catch { /* already gone */ }
  }

  return { start, stop };
}
