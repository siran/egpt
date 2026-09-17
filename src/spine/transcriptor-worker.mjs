// transcriptor-worker.mjs — the WORKER ROLE (operator 2026-06-10; ported to the v2 spine
// 2026-07-10). Topology: ONE main spine owns all conversation context + every outbound send;
// other machines (e.g. DOLLY, the GPU box) run the SAME egpt in a WORKER role. The first
// worker role is `transcriptor`: it serves the signed POST /v1/transcribe endpoint
// (src/tools/transcriptor.mjs) for the main spine's voice notes — main spine sends, workers
// compute. This module owns the worker's lifecycle inside boot: config resolution, the
// resident whisper-server spawn+supervise (src/tools/whisper-server.mjs), the :23390 HTTP
// server, and teardown of BOTH.
//
// WHY THIS EXISTS: v1 started the worker from an egpt-spine.mjs startEffect (~4861); the v2
// spine (boot.mjs) never did, so a node configured `transcriptor.enabled: true` (DOLLY) ran
// NOTHING — nothing listening on :8089 (resident whisper-server) or :23390 (the endpoint), and
// voice-note transcription silently failed. This restores it, DI-wired like the other services
// so the process spawns are (a) ingest-gated in boot (real node only) and (b) seam-injectable
// (tests never spawn a real whisper-server or bind a real port).
//
// FIRE-AND-FORGET: start() is faithful to v1's async IIFE — boot kicks it off WITHOUT awaiting,
// because startWhisperServer waits for model readiness (up to 120s with large-v3) and the spine
// must not block its tick (the alive heartbeat) on that. start() itself is awaitable so callers
// (tests) can observe the resolved wiring deterministically.

import { networkInterfaces } from 'node:os';
import { startWhisperServer as realStartWhisperServer, makeWhisperServerTranscriber as realMakeTranscriber } from '../tools/whisper-server.mjs';
import { startTranscriptorServer as realStartTranscriptorServer, TRANSCRIPTOR_DEFAULT_PORT } from '../tools/transcriptor.mjs';
import { listenRetrying } from './bind-retry.mjs';

const WHISPER_DEFAULT_PORT = 8089;   // mirrors src/tools/whisper-server.mjs (port = 8089)

// ── IS THIS NODE ITS OWN WORKER? ─────────────────────────────────────────────────────────────
// True-ish when this node's ACTIVE transcription profile (transcription_service[use_config])
// lists, IN fallback_order, a whisper-server-remote rung whose endpoint is THIS machine
// (a loopback host, or one of this machine's interface addresses) on THIS node's transcriptor
// port (transcriptor.port, default 23390). Returns { at, endpoint } for the first such rung,
// else null. dolly: `do.worker` → http://127.0.0.1:23390 → its own worker. kg: `reve.worker` →
// http://192.168.1.102:23390 (dolly's address) → not. The one definition of "a node that sends
// voice notes to its own transcriptor endpoint", so the worker's warning below and anything that
// decides whether a node should run the worker role cannot disagree.
export function routesToOwnTranscriptor(cfg, { localAddresses = localAddressSet() } = {}) {
  const txSvc = cfg?.transcription_service;
  const name = txSvc?.use_config;
  const profile = txSvc?.[name];
  if (!profile || typeof profile !== 'object' || !Array.isArray(profile.fallback_order)) return null;
  const port = Number(cfg?.transcriptor?.port) > 0 ? Number(cfg.transcriptor.port) : TRANSCRIPTOR_DEFAULT_PORT;
  for (const rung of profile.fallback_order) {
    const eng = profile[rung];
    if (eng?.type !== 'whisper-server-remote' || typeof eng.endpoint !== 'string') continue;
    let u;
    try { u = new URL(eng.endpoint); } catch { continue; }
    if (Number(u.port || (u.protocol === 'https:' ? 443 : 80)) !== port) continue;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host === '::1' || /^127\./.test(host) || localAddresses.has(host)) {
      return { at: `transcription_service.${name}.${rung}`, endpoint: eng.endpoint };
    }
  }
  return null;
}

function localAddressSet() {
  return new Set(Object.values(networkInterfaces()).flat().map((i) => String(i?.address ?? '').toLowerCase()));
}

// ── config resolution (faithful to v1 txCli/txToken; CANONICAL first, legacy fallbacks the
//    recent consolidation established). Pure + exported so the fallback ladder is test-locked. ──

// whisper-cli engine config AND the universal per-note fallback (v1 `txCli`). On the WORKER this
// is its OWN whisper binary/model — on the GPU box it's what makes it fast. transcription.cli is
// canonical; then the older transcription.whisper; then the legacy whatsapp.media.audio_transcribe.
export function resolveAudioCfg(cfg) {
  return cfg?.transcription?.cli ?? cfg?.transcription?.whisper ?? cfg?.whatsapp?.media?.audio_transcribe ?? {};
}

// Auth key: the shared bus key the MAIN spine signs its POSTs with (v1 `txServerToken`). The
// server block's token is canonical; then transcription.token; then the flat transcription_token.
export function resolveToken(cfg) {
  return cfg?.transcription?.server?.token ?? cfg?.transcription?.token ?? cfg?.transcription_token ?? null;
}

// Resident whisper.cpp server config: it belongs to the WORKER that owns it
// (transcriptor.server, canonical); legacy fallback to the cli/audio_transcribe.server block
// (v1: `EGPT_CONFIG.transcriptor?.server ?? audioCfg.server ?? {}`).
export function resolveServerCfg(cfg, audioCfg) {
  return cfg?.transcriptor?.server ?? audioCfg?.server ?? {};
}

export function createTranscriptorWorker({
  getConfig = () => ({}),
  // process-boundary seams — default to the real spawners; tests inject fakes so no real
  // whisper-server is spawned and no real port is bound.
  startWhisperServer = realStartWhisperServer,
  makeWhisperServerTranscriber = realMakeTranscriber,
  startTranscriptorServer = realStartTranscriptorServer,
  setTimeout: setTimeoutFn = globalThis.setTimeout,       // the bind retry's timer seams
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  stateDir = null,                                        // EGPT_HOME/state: the endpoint keeps its memory of decoded transcripts there
  onLog = () => {},
} = {}) {
  let server = null, whisper = null, closed = false;
  const stopping = new AbortController();   // stop() ends a pending bind retry (src/spine/bind-retry.mjs)

  async function start() {
    const cfg = getConfig() ?? {};
    const tcfg = cfg.transcriptor;
    if (!tcfg?.enabled) {   // gate: not a transcriptor worker → nothing to run
      // ...but a node that sends its own voice notes to its own transcriptor endpoint with the
      // role off falls past that rung on every note, and on dolly (2026-09-15/16) nothing said
      // so for a day. Say it once, at boot.
      const own = routesToOwnTranscriptor(cfg);
      if (own) onLog(`!! transcriptor: ${own.at} sends this node's voice notes to ${own.endpoint}, this node's OWN transcriptor endpoint, but transcriptor.enabled is not true — nothing listens there, and every note falls past that rung. Enable the transcriptor worker role on this node, or point that rung at another node.`);
      return;
    }
    const keyB64 = resolveToken(cfg);
    if (!keyB64) {
      onLog('!! transcriptor enabled but transcription token unset — refusing to start an unauthenticated server. Set transcription.server.token (same value as the main spine) in config.yaml.');
      return;
    }
    const audioCfg = resolveAudioCfg(cfg);
    const scfg = resolveServerCfg(cfg, audioCfg);
    const bind = tcfg.bind || '127.0.0.1';   // default 127.0.0.1 — set transcriptor.bind to the LAN ip to expose
    const port = Number(tcfg.port) > 0 ? Number(tcfg.port) : TRANSCRIPTOR_DEFAULT_PORT;
    try {
      let transcribe;   // undefined → startTranscriptorServer uses whisper-cli per-note
      if (scfg?.enabled) {
        // Resident whisper-server (load the GGUF ONCE instead of per-note; ~10s+ saved per call
        // with large-v3). whisper-server.mjs owns spawn + readiness wait + crash-respawn with
        // backoff; the per-request transcribe POSTs to it. v1 defaults preserved.
        whisper = await startWhisperServer({
          command: scfg.command,
          model: scfg.model ?? audioCfg.model_path,
          host: scfg.host || '127.0.0.1',
          port: Number(scfg.port) > 0 ? Number(scfg.port) : WHISPER_DEFAULT_PORT,
          language: scfg.language ?? audioCfg.language,
          extraArgs: Array.isArray(scfg.extra_args) ? scfg.extra_args : [],
          antiRepetition: scfg.anti_repetition !== false,   // -mc 0 -sns (op 2026-06-16); set false to opt out
          onLog,
        });
        if (closed) { whisper.stop(); return; }   // stopped mid-start
        transcribe = makeWhisperServerTranscriber({ url: whisper.url, ffmpeg: audioCfg.ffmpeg_command, language: audioCfg.language });
      }
      const s = await listenRetrying(() => startTranscriptorServer({ port, bind, keyB64, audioCfg, transcribe, stateDir, onLog }), {
        signal: stopping.signal, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn,
        onRetry: (attempt, delay) => onLog(`transcriptor: could not bind ${bind}:${port} — EADDRINUSE (attempt ${attempt}); retrying in ${Math.round(delay / 1000)}s. Notes sent to this endpoint fall past it until it binds.`),
      });
      if (!s) return;                                        // stopped during a bind retry (stop() already stopped whisper)
      if (closed) { s.close(); whisper?.stop(); return; }   // stopped mid-start
      server = s;
      onLog(`transcriptor: worker role up on ${bind}:${s.port}${scfg?.enabled ? ' (resident whisper-server)' : ' (whisper-cli per-note)'}`);
    } catch (e) {
      onLog(`!! transcriptor failed to start: ${e?.message ?? e}`);
    }
  }

  // Teardown: stop BOTH the whisper-server (kills the resident child) and the transcriptor HTTP
  // server (closes the listener). Idempotent; safe if start() is still in flight (the mid-start
  // `closed` checks catch it). boot.stop() calls this.
  function stop() {
    closed = true;
    stopping.abort();
    try { server?.close(); } catch { /* already gone */ }
    try { whisper?.stop(); } catch { /* already gone */ }
  }

  return { start, stop };
}
