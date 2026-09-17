// synthesizer-worker.test.mjs — the WORKER ROLE service (src/spine/synthesizer-worker.mjs).
// Covers the config-resolution ladder (resolveToken, resolveFfmpegCommand), the
// enabled/RADIO_PIPER/token gates, and teardown — all against a FAKE startSynthesizerServer
// seam, so no real port is bound.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSynthesizerWorker, resolveToken, resolveFfmpegCommand,
} from '../src/spine/synthesizer-worker.mjs';

const ORIGINAL_RADIO_PIPER = process.env.RADIO_PIPER;
beforeEach(() => { process.env.RADIO_PIPER = 'C:\\radio\\piper'; });
afterEach(() => {
  if (ORIGINAL_RADIO_PIPER === undefined) delete process.env.RADIO_PIPER;
  else process.env.RADIO_PIPER = ORIGINAL_RADIO_PIPER;
});

// Fake process-boundary seam: records the opts it was called with, hands back a handle
// whose close() increments a counter. NOTHING binds a real port.
function fakes() {
  const calls = { server: [], serverClosed: 0 };
  const serverHandle = { port: 23391, close: () => { calls.serverClosed++; } };
  return {
    calls, serverHandle,
    startSynthesizerServer: async (opts) => { calls.server.push(opts); serverHandle.port = opts.port; return serverHandle; },
  };
}

describe('synthesizer worker — config resolution', () => {
  it('resolveToken: synthesizer.server.token canonical → voice_service.server.token → null', () => {
    expect(resolveToken({ synthesizer: { server: { token: 'S' } }, voice_service: { server: { token: 'V' } } })).toBe('S');
    expect(resolveToken({ voice_service: { server: { token: 'V' } } })).toBe('V');
    expect(resolveToken({})).toBeNull();
  });

  it('resolveFfmpegCommand: synthesizer.ffmpeg_command → "ffmpeg" default (NOT coupled to transcription.cli)', () => {
    expect(resolveFfmpegCommand({ synthesizer: { ffmpeg_command: 'C:\\ffmpeg.exe' } })).toBe('C:\\ffmpeg.exe');
    expect(resolveFfmpegCommand({ transcription: { cli: { ffmpeg_command: 'C:\\other-ffmpeg.exe' } } })).toBe('ffmpeg');
    expect(resolveFfmpegCommand({})).toBe('ffmpeg');
  });
});

describe('synthesizer worker — start gate', () => {
  it('does NOTHING when synthesizer.enabled is not true (no seam calls)', async () => {
    const f = fakes();
    const w = createSynthesizerWorker({ getConfig: () => ({ synthesizer: { enabled: false } }), ...f });
    await w.start();
    expect(f.calls.server).toHaveLength(0);
  });

  it('REFUSES to start with RADIO_PIPER unset → logs, no server bound', async () => {
    delete process.env.RADIO_PIPER;
    const f = fakes();
    const logs = [];
    const w = createSynthesizerWorker({
      getConfig: () => ({ synthesizer: { enabled: true, server: { token: 'K' } } }),
      ...f, onLog: (m) => logs.push(m),
    });
    await w.start();
    expect(f.calls.server).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/RADIO_PIPER/);
  });

  it('REFUSES to start unauthenticated: enabled + RADIO_PIPER set but no token → logs, no server bound', async () => {
    const f = fakes();
    const logs = [];
    const w = createSynthesizerWorker({ getConfig: () => ({ synthesizer: { enabled: true } }), ...f, onLog: (m) => logs.push(m) });
    await w.start();
    expect(f.calls.server).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/token unset|unauthenticated/);
  });
});

describe('synthesizer worker — start wiring', () => {
  it('resolves pythonPath/voicesDir from RADIO_PIPER and passes bind/port/keyB64 through', async () => {
    const f = fakes();
    const w = createSynthesizerWorker({
      getConfig: () => ({ synthesizer: { enabled: true, bind: '0.0.0.0', port: 23391, server: { token: 'BUSKEY' } } }),
      ...f,
    });
    await w.start();
    expect(f.calls.server).toHaveLength(1);
    expect(f.calls.server[0]).toMatchObject({
      port: 23391, bind: '0.0.0.0', keyB64: 'BUSKEY',
      pythonPath: 'C:\\radio\\piper\\venv\\Scripts\\python.exe',
      voicesDir: 'C:\\radio\\piper\\voices',
      ffmpegCommand: 'ffmpeg',
    });
  });

  it('defaults bind/port when unset', async () => {
    const f = fakes();
    const w = createSynthesizerWorker({
      getConfig: () => ({ synthesizer: { enabled: true, server: { token: 'K' } } }),
      ...f,
    });
    await w.start();
    expect(f.calls.server[0]).toMatchObject({ bind: '127.0.0.1', port: 23391 });
  });
});

// do, 2026-09-17 07:28 and 12:36: both deploys started the spine while the one it replaces still
// held :23391; the one listen failed with EADDRINUSE and nothing tried again, so every 🔊 reading
// from kg (whose only synthesis rung is this endpoint) failed until a manual restart at 13:28.
// The same bind retry as the transcriptor worker's (src/spine/bind-retry.mjs).
describe('synthesizer worker — the bind retries while the port is taken', () => {
  const CFG = { synthesizer: { enabled: true, bind: '0.0.0.0', port: 23391, server: { token: 'K' } } };
  const inUse = () => Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:23391'), { code: 'EADDRINUSE' });
  // listen seam: the first `fails` attempts throw `err()`, then the fake server binds
  function listenFailing(f, fails, err = inUse) {
    const l = { attempts: 0 };
    l.fn = async (opts) => { l.attempts += 1; if (l.attempts <= fails) throw err(); return f.startSynthesizerServer(opts); };
    return l;
  }
  // timer seam: records each armed delay; fires it at once unless `hold`
  function timers({ hold = false } = {}) {
    const t = { delays: [], cleared: 0 };
    t.setTimeout = (fn, ms) => { t.delays.push(ms); if (!hold) queueMicrotask(fn); return t.delays.length; };
    t.clearTimeout = () => { t.cleared += 1; };
    return t;
  }

  it('do as measured: EADDRINUSE on the first listen → retries and binds once the port frees; the attempt is logged', async () => {
    const f = fakes(); const t = timers(); const l = listenFailing(f, 1); const logs = [];
    const w = createSynthesizerWorker({ getConfig: () => CFG, ...f, startSynthesizerServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, onLog: (m) => logs.push(m) });
    await w.start();
    expect(l.attempts).toBe(2);
    expect(t.delays).toEqual([3000]);
    expect(logs).toContain('synthesizer: could not bind 0.0.0.0:23391 — EADDRINUSE (attempt 1); retrying in 3s. Text sent to this endpoint falls past it until it binds.');
    expect(logs).toContain('synthesizer: worker role up on 0.0.0.0:23391');
    expect(logs.some((m) => /failed to start/.test(m))).toBe(false);
    w.stop();
    expect(f.calls.serverClosed).toBe(1);
  });

  it('backs off 3s → 60s while the port stays taken', async () => {
    const f = fakes(); const t = timers(); const l = listenFailing(f, 7);
    const w = createSynthesizerWorker({ getConfig: () => CFG, ...f, startSynthesizerServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
    await w.start();
    expect(t.delays).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000]);
    expect(l.attempts).toBe(8);
  });

  it('stop() during the backoff ends it: no further listen, start() returns, nothing bound', async () => {
    const f = fakes(); const t = timers({ hold: true }); const l = listenFailing(f, 1); const logs = [];
    const w = createSynthesizerWorker({ getConfig: () => CFG, ...f, startSynthesizerServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, onLog: (m) => logs.push(m) });
    const started = w.start();
    for (let i = 0; i < 50 && !t.delays.length; i++) await new Promise((r) => setTimeout(r, 1));
    expect(t.delays).toEqual([3000]);
    w.stop();
    await started;
    expect(t.cleared).toBe(1);
    expect(l.attempts).toBe(1);
    expect(f.calls.server).toHaveLength(0);
    expect(logs.some((m) => /worker role up|failed to start/.test(m))).toBe(false);
  });

  it('any other listen error stays fatal: one attempt, logged, no retry', async () => {
    const f = fakes(); const t = timers(); const logs = [];
    const l = listenFailing(f, 1, () => Object.assign(new Error('listen EACCES: permission denied 0.0.0.0:23391'), { code: 'EACCES' }));
    const w = createSynthesizerWorker({ getConfig: () => CFG, ...f, startSynthesizerServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, onLog: (m) => logs.push(m) });
    await w.start();
    expect(l.attempts).toBe(1);
    expect(t.delays).toEqual([]);
    expect(logs).toContain('!! synthesizer failed to start: listen EACCES: permission denied 0.0.0.0:23391');
  });
});

describe('synthesizer worker — teardown', () => {
  it('stop() closes the synthesizer endpoint', async () => {
    const f = fakes();
    const w = createSynthesizerWorker({
      getConfig: () => ({ synthesizer: { enabled: true, server: { token: 'K' } } }),
      ...f,
    });
    await w.start();
    expect(f.calls.serverClosed).toBe(0);
    w.stop();
    expect(f.calls.serverClosed).toBe(1);
  });
});
