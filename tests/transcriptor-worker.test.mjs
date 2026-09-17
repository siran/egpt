// transcriptor-worker.test.mjs — the WORKER ROLE service (src/spine/transcriptor-worker.mjs),
// ported from v1 egpt-spine.mjs (~4861) to the v2 spine. Covers the CONFIG-RESOLUTION ladder
// (canonical wins + each legacy fallback), the enabled/token gate, the resident-whisper-server
// vs whisper-cli-per-note branch, and teardown — all against FAKE spawn seams, so no real
// whisper-server is spawned and no real port is bound.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTranscriptorWorker, resolveAudioCfg, resolveToken, resolveServerCfg, routesToOwnTranscriptor,
} from '../src/spine/transcriptor-worker.mjs';
import { startWhisperServer as realStartWhisperServer, makeWhisperServerTranscriber as realMakeTranscriber } from '../src/tools/whisper-server.mjs';
import { startTranscriptorServer as realStartTranscriptorServer, transcribeViaEndpoint } from '../src/tools/transcriptor.mjs';

// Fake process-boundary seams: record the opts each spawner was called with, hand back handles
// whose stop/close increment counters. NOTHING spawns, NOTHING binds.
function fakes() {
  const calls = { whisper: [], mk: [], server: [], whisperStopped: 0, serverClosed: 0 };
  const whisperHandle = { url: 'http://127.0.0.1:8089', isAlive: () => true, stop: () => { calls.whisperStopped++; } };
  const serverHandle = { port: 23390, close: () => { calls.serverClosed++; } };
  return {
    calls, whisperHandle, serverHandle,
    startWhisperServer: async (opts) => { calls.whisper.push(opts); return whisperHandle; },
    makeWhisperServerTranscriber: (opts) => { calls.mk.push(opts); return async () => 'text'; },
    startTranscriptorServer: async (opts) => { calls.server.push(opts); serverHandle.port = opts.port; return serverHandle; },
  };
}

describe('transcriptor worker — config resolution (canonical wins, legacy fallbacks)', () => {
  it('resolveAudioCfg: transcription.cli canonical → transcription.whisper → whatsapp.media.audio_transcribe → {}', () => {
    expect(resolveAudioCfg({ transcription: { cli: { model_path: 'A' }, whisper: { model_path: 'B' } }, whatsapp: { media: { audio_transcribe: { model_path: 'C' } } } })).toEqual({ model_path: 'A' });
    expect(resolveAudioCfg({ transcription: { whisper: { model_path: 'B' } }, whatsapp: { media: { audio_transcribe: { model_path: 'C' } } } })).toEqual({ model_path: 'B' });
    expect(resolveAudioCfg({ whatsapp: { media: { audio_transcribe: { model_path: 'C' } } } })).toEqual({ model_path: 'C' });
    expect(resolveAudioCfg({})).toEqual({});
  });

  it('resolveToken: transcription.server.token canonical → transcription.token → transcription_token → null', () => {
    expect(resolveToken({ transcription: { server: { token: 'S' }, token: 'T' }, transcription_token: 'F' })).toBe('S');
    expect(resolveToken({ transcription: { token: 'T' }, transcription_token: 'F' })).toBe('T');
    expect(resolveToken({ transcription_token: 'F' })).toBe('F');
    expect(resolveToken({})).toBeNull();
  });

  it('resolveServerCfg: transcriptor.server canonical → audioCfg.server (legacy) → {}', () => {
    expect(resolveServerCfg({ transcriptor: { server: { enabled: true, port: 8091 } } }, { server: { enabled: true, port: 8089 } })).toEqual({ enabled: true, port: 8091 });
    expect(resolveServerCfg({}, { server: { enabled: true, port: 8089 } })).toEqual({ enabled: true, port: 8089 });
    expect(resolveServerCfg({}, {})).toEqual({});
  });
});

describe('transcriptor worker — start gate', () => {
  it('does NOTHING when transcriptor.enabled is not true (no seam calls)', async () => {
    const f = fakes();
    const w = createTranscriptorWorker({ getConfig: () => ({ transcriptor: { enabled: false }, transcription_token: 'K' }), ...f });
    await w.start();
    expect(f.calls.server).toHaveLength(0);
    expect(f.calls.whisper).toHaveLength(0);
  });

  it('REFUSES to start unauthenticated: enabled but no token → logs, no server bound', async () => {
    const f = fakes();
    const logs = [];
    const w = createTranscriptorWorker({ getConfig: () => ({ transcriptor: { enabled: true } }), ...f, onLog: (m) => logs.push(m) });
    await w.start();
    expect(f.calls.server).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/transcription token unset|unauthenticated/);
  });
});

describe('transcriptor worker — engine branch', () => {
  it('no resident server → whisper-cli per-note: startTranscriptorServer gets transcribe UNDEFINED, whisper never spawned', async () => {
    const f = fakes();
    const w = createTranscriptorWorker({
      getConfig: () => ({ transcriptor: { enabled: true, bind: '0.0.0.0', port: 23390 }, transcription: { server: { token: 'BUSKEY' } } }),
      ...f,
    });
    await w.start();
    expect(f.calls.whisper).toHaveLength(0);
    expect(f.calls.server).toHaveLength(1);
    expect(f.calls.server[0]).toMatchObject({ port: 23390, bind: '0.0.0.0', keyB64: 'BUSKEY' });
    expect(f.calls.server[0].transcribe).toBeUndefined();
  });

  // The worker's decode memory lives in the node's state/ folder (operator 2026-09-17): boot hands the folder in.
  it('hands the endpoint the node\'s state folder, where its memory of decoded transcripts lives', async () => {
    const f = fakes();
    const w = createTranscriptorWorker({
      getConfig: () => ({ transcriptor: { enabled: true }, transcription: { server: { token: 'K' } } }),
      stateDir: '/egpt-home/state',
      ...f,
    });
    await w.start();
    expect(f.calls.server[0].stateDir).toBe('/egpt-home/state');
  });

  it('resident server (CANONICAL transcriptor.server) → spawns whisper-server with resolved args; endpoint gets a transcribe', async () => {
    const f = fakes();
    const w = createTranscriptorWorker({
      getConfig: () => ({
        transcriptor: { enabled: true, port: 23390, server: { enabled: true, command: 'ws.exe', model: '/m/large-v3.bin', port: 8091, language: 'en', extra_args: ['-x'] } },
        transcription: { server: { token: 'K' } },
      }),
      ...f,
    });
    await w.start();
    expect(f.calls.whisper).toHaveLength(1);
    expect(f.calls.whisper[0]).toMatchObject({ command: 'ws.exe', model: '/m/large-v3.bin', host: '127.0.0.1', port: 8091, language: 'en', extraArgs: ['-x'], antiRepetition: true });
    expect(f.calls.mk).toHaveLength(1);                 // makeWhisperServerTranscriber wired to the resident url
    expect(f.calls.mk[0].url).toBe('http://127.0.0.1:8089');
    expect(f.calls.server[0].transcribe).toBeTypeOf('function');   // resident server → per-request POSTs to it
  });

  it('resident server via the LEGACY audio_transcribe.server + audio_transcribe model/language (DOLLY shape)', async () => {
    const f = fakes();
    const w = createTranscriptorWorker({
      getConfig: () => ({
        transcriptor: { enabled: true, bind: '0.0.0.0', port: 23390 },
        whatsapp: { media: { audio_transcribe: { model_path: '/m/large-v3.bin', language: 'es', server: { enabled: true, command: 'ws.exe' } } } },
        transcription_token: 'tok',
      }),
      ...f,
    });
    await w.start();
    // server config from audio_transcribe.server; model/language filled from the audio_transcribe block; port defaults to 8089
    expect(f.calls.whisper[0]).toMatchObject({ command: 'ws.exe', model: '/m/large-v3.bin', port: 8089, language: 'es' });
    expect(f.calls.server[0]).toMatchObject({ bind: '0.0.0.0', port: 23390, keyB64: 'tok' });
    expect(f.calls.server[0].transcribe).toBeTypeOf('function');
    expect(f.calls.server[0].audioCfg).toMatchObject({ model_path: '/m/large-v3.bin' });   // audioCfg = the legacy block
  });
});

// ── dolly, 2026-09-16: NOTHING LISTENED ON :23390 ─────────────────────────────────────────
// do's config had carried `transcriptor.enabled: false` since the 2026-09-15 memory incident,
// while its own active profile still sent every note to `worker: http://127.0.0.1:23390`
// first. The gate returned without a word, so the node spent a day falling through to the cli
// rung with nothing in any log saying why. A node that routes its own notes to its own
// transcriptor endpoint while the role is off is misconfigured, and it must say so.
describe('transcriptor worker — a node that routes notes to its OWN disabled endpoint says so', () => {
  const DO_PROFILE = {
    fallback_order: ['worker', 'cli'],
    worker: { type: 'whisper-server-remote', endpoint: 'http://127.0.0.1:23390', token: 'K' },
    cli: { type: 'whisper-cli', model_path: '/m/ggml-base.bin' },
  };

  it('do as measured: transcriptor.enabled false + worker rung at 127.0.0.1:23390 → one loud line naming both, no seam calls', async () => {
    const f = fakes(); const logs = [];
    const w = createTranscriptorWorker({
      getConfig: () => ({
        transcriptor: { enabled: false, bind: '0.0.0.0', port: 23390, server: { enabled: false, command: 'ws.exe', host: '127.0.0.1', port: 8089 } },
        transcription: { server: { token: 'K' } },
        transcription_service: { use_config: 'do', do: DO_PROFILE },
      }),
      ...f, onLog: (m) => logs.push(m),
    });
    await w.start();
    expect(f.calls.server).toHaveLength(0);
    expect(f.calls.whisper).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^!! /);
    expect(logs[0]).toContain('transcription_service.do.worker');
    expect(logs[0]).toContain('http://127.0.0.1:23390');
    expect(logs[0]).toContain('transcriptor.enabled');
  });

  it('a rung that points at ANOTHER node\'s worker (kg → dolly) is not this node\'s business: silent', async () => {
    const f = fakes(); const logs = [];
    const w = createTranscriptorWorker({
      getConfig: () => ({ transcription_service: { use_config: 'reve', reve: { ...DO_PROFILE, worker: { ...DO_PROFILE.worker, endpoint: 'http://203.0.113.7:23390' } } } }),
      ...f, onLog: (m) => logs.push(m),
    });
    await w.start();
    expect(logs).toEqual([]);
    expect(f.calls.server).toHaveLength(0);
  });

  // REGRESSION LOCK: a node with no transcription at all stays silent and inert.
  it('a node with no transcription configuration at all: silent, nothing started', async () => {
    const f = fakes(); const logs = [];
    const w = createTranscriptorWorker({ getConfig: () => ({}), ...f, onLog: (m) => logs.push(m) });
    await w.start();
    expect(logs).toEqual([]);
    expect(f.calls.server).toHaveLength(0);
    expect(f.calls.whisper).toHaveLength(0);
  });
});

// The ONE definition of "this node is its own worker" (the warning above, and whatever decides
// whether a node should run the transcriptor role). localAddresses injected: no real interfaces.
describe('routesToOwnTranscriptor', () => {
  const at = (use, profile, extra = {}) => ({ transcription_service: { use_config: use, [use]: profile }, ...extra });
  const rung = (endpoint) => ({ fallback_order: ['worker', 'cli'], worker: { type: 'whisper-server-remote', endpoint }, cli: { type: 'whisper-cli' } });
  const none = { localAddresses: new Set() };

  it('dolly (do): worker rung at 127.0.0.1:23390 → its own worker', () => {
    expect(routesToOwnTranscriptor(at('do', rung('http://127.0.0.1:23390')), none)).toEqual({ at: 'transcription_service.do.worker', endpoint: 'http://127.0.0.1:23390' });
    expect(routesToOwnTranscriptor(at('do', rung('http://localhost:23390/')), none)).not.toBeNull();
  });

  it('kg: worker rung at dolly\'s LAN address → not its own worker', () => {
    expect(routesToOwnTranscriptor(at('reve', rung('http://192.168.1.102:23390')), { localAddresses: new Set(['192.168.1.50']) })).toBeNull();
  });

  it('a rung at this machine\'s OWN interface address counts as its own', () => {
    expect(routesToOwnTranscriptor(at('do', rung('http://192.168.1.102:23390')), { localAddresses: new Set(['192.168.1.102']) })).not.toBeNull();
  });

  it('the port must be this node\'s transcriptor port (transcriptor.port, default 23390)', () => {
    expect(routesToOwnTranscriptor(at('do', rung('http://127.0.0.1:23391')), none)).toBeNull();
    expect(routesToOwnTranscriptor(at('do', rung('http://127.0.0.1:23400'), { transcriptor: { port: 23400 } }), none)).not.toBeNull();
  });

  it('only a rung IN fallback_order, only the ACTIVE profile, only whisper-server-remote', () => {
    const dropped = { ...rung('http://127.0.0.1:23390'), fallback_order: ['cli'] };
    expect(routesToOwnTranscriptor(at('do', dropped), none)).toBeNull();
    expect(routesToOwnTranscriptor({ transcription_service: { use_config: 'other', do: rung('http://127.0.0.1:23390') } }, none)).toBeNull();
    expect(routesToOwnTranscriptor(at('do', { fallback_order: ['worker'], worker: { type: 'whisper-server-local', endpoint: 'http://127.0.0.1:23390' } }), none)).toBeNull();
    expect(routesToOwnTranscriptor({}, none)).toBeNull();
  });
});

// ── THE WORKER FRONTS THE SERVICE'S RESIDENT SERVER, IT NEVER STARTS ITS OWN ───────────────
// Real startWhisperServer, real startTranscriptorServer and the real remote-rung client, with
// only the process boundary faked: a stand-in for the WhisperServer service's server on an
// ephemeral port, spawn/reap counters, no ffmpeg, and :23390 moved to port 0.
describe('transcriptor worker — serves :23390 in front of an ADOPTED resident server', () => {
  const KEY = 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMDA';
  let resident, dir, audio;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'egpt-worker-'));
    audio = join(dir, 'note.ogg');
    writeFileSync(audio, Buffer.from('fake-ogg-bytes'));
    resident = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inference') {
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'hola desde el residente' })); });
        return;
      }
      res.writeHead(200); res.end('whisper.cpp server');
    });
    await new Promise((r) => resident.listen(0, '127.0.0.1', r));
  });
  afterEach(() => { resident.close(); rmSync(dir, { recursive: true, force: true }); });

  it('adopts the serving resident, binds the endpoint, a signed note is transcribed by the resident — zero spawns, zero reaps', async () => {
    const residentPort = resident.address().port;
    const calls = { spawn: 0, reap: 0 }; const logs = [];
    let bound = null, askedPort = null;
    const w = createTranscriptorWorker({
      getConfig: () => ({
        transcriptor: { enabled: true, bind: '127.0.0.1', port: 23390, server: { enabled: true, command: 'C:\\w\\whisper-server.exe', host: '127.0.0.1', port: residentPort } },
        transcription: { server: { token: KEY }, cli: { model_path: '/m/ggml-large-v3.bin', language: 'auto' } },
      }),
      startWhisperServer: (o) => realStartWhisperServer({
        ...o, readyTimeoutMs: 1000,
        spawn: () => { calls.spawn++; throw new Error('a second whisper-server must never be spawned'); },
        reap: () => { calls.reap++; },
        serviceFor: async () => null,
      }),
      makeWhisperServerTranscriber: (o) => realMakeTranscriber({ ...o, convert: async (p) => p }),
      startTranscriptorServer: async (o) => { askedPort = o.port; bound = await realStartTranscriptorServer({ ...o, port: 0 }); return bound; },
      onLog: (m) => logs.push(m),
    });
    await w.start();
    try {
      expect(askedPort).toBe(23390);
      expect(bound).not.toBeNull();
      expect(logs.join('\n')).toMatch(/ADOPTED/);
      expect(logs.join('\n')).toMatch(/worker role up .*resident whisper-server/);
      const t = await transcribeViaEndpoint(audio, { endpoint: `http://127.0.0.1:${bound.port}`, keyB64: KEY });
      expect(t).toBe('hola desde el residente');
      expect(calls).toEqual({ spawn: 0, reap: 0 });
    } finally {
      w.stop();
    }
    // stop() closed the endpoint and left the resident it did not start serving
    expect((await fetch(`http://127.0.0.1:${residentPort}/`)).status).toBe(200);
  });
});

// On 2026-09-14 a restart race left :23390 held for a moment; the one listen failed with
// EADDRINUSE and the worker never tried again. It re-listens with shell-port.mjs's backoff.
describe('transcriptor worker — the bind retries while the port is taken', () => {
  const CFG = { transcriptor: { enabled: true, bind: '0.0.0.0', port: 23390, server: { enabled: true, command: 'ws.exe', model: '/m', port: 8089 } }, transcription: { server: { token: 'K' } } };
  const inUse = () => Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:23390'), { code: 'EADDRINUSE' });
  // listen seam: the first `fails` attempts throw `err()`, then the fake server binds
  function listenFailing(f, fails, err = inUse) {
    const l = { attempts: 0 };
    l.fn = async (opts) => { l.attempts += 1; if (l.attempts <= fails) throw err(); return f.startTranscriptorServer(opts); };
    return l;
  }
  // timer seam: records each armed delay; fires it at once unless `hold`
  function timers({ hold = false } = {}) {
    const t = { delays: [], cleared: 0 };
    t.setTimeout = (fn, ms) => { t.delays.push(ms); if (!hold) queueMicrotask(fn); return t.delays.length; };
    t.clearTimeout = () => { t.cleared += 1; };
    return t;
  }

  it('EADDRINUSE on the first listen → retries and binds once the port frees; each attempt is logged', async () => {
    const f = fakes(); const t = timers(); const l = listenFailing(f, 1); const logs = [];
    const w = createTranscriptorWorker({ getConfig: () => CFG, ...f, startTranscriptorServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, onLog: (m) => logs.push(m) });
    await w.start();
    expect(l.attempts).toBe(2);
    expect(t.delays).toEqual([3000]);
    expect(logs.some((m) => /EADDRINUSE/.test(m) && /attempt 1/.test(m) && /retrying in 3s/.test(m))).toBe(true);
    expect(logs.some((m) => /worker role up/.test(m))).toBe(true);
    expect(logs.some((m) => /failed to start/.test(m))).toBe(false);
    w.stop();
    expect(f.calls.serverClosed).toBe(1);
  });

  it('backs off 3s → 60s while the port stays taken', async () => {
    const f = fakes(); const t = timers(); const l = listenFailing(f, 7); const logs = [];
    const w = createTranscriptorWorker({ getConfig: () => CFG, ...f, startTranscriptorServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, onLog: (m) => logs.push(m) });
    await w.start();
    expect(t.delays).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000]);
    expect(l.attempts).toBe(8);
    expect(logs.filter((m) => /EADDRINUSE/.test(m))).toHaveLength(7);
  });

  it('stop() during the backoff ends it: no further listen, start() returns, the resident whisper-server is stopped', async () => {
    const f = fakes(); const t = timers({ hold: true }); const l = listenFailing(f, 1);
    const w = createTranscriptorWorker({ getConfig: () => CFG, ...f, startTranscriptorServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
    const started = w.start();
    for (let i = 0; i < 50 && !t.delays.length; i++) await new Promise((r) => setTimeout(r, 1));
    expect(t.delays).toEqual([3000]);
    w.stop();
    await started;
    expect(t.cleared).toBe(1);
    expect(l.attempts).toBe(1);
    expect(f.calls.whisperStopped).toBe(1);
    expect(f.calls.serverClosed).toBe(0);
  });

  it('any other listen error stays fatal: one attempt, logged, no retry', async () => {
    const f = fakes(); const t = timers(); const logs = [];
    const l = listenFailing(f, 1, () => Object.assign(new Error('listen EACCES: permission denied 0.0.0.0:23390'), { code: 'EACCES' }));
    const w = createTranscriptorWorker({ getConfig: () => CFG, ...f, startTranscriptorServer: l.fn, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, onLog: (m) => logs.push(m) });
    await w.start();
    expect(l.attempts).toBe(1);
    expect(t.delays).toEqual([]);
    expect(logs.some((m) => /failed to start: listen EACCES/.test(m))).toBe(true);
  });
});

describe('transcriptor worker — teardown', () => {
  it('stop() closes BOTH the resident whisper-server and the transcriptor endpoint', async () => {
    const f = fakes();
    const w = createTranscriptorWorker({
      getConfig: () => ({ transcriptor: { enabled: true, port: 23390, server: { enabled: true, command: 'ws.exe', model: '/m', port: 8089 } }, transcription: { server: { token: 'K' } } }),
      ...f,
    });
    await w.start();
    expect(f.calls.serverClosed).toBe(0);
    expect(f.calls.whisperStopped).toBe(0);
    w.stop();
    expect(f.calls.serverClosed).toBe(1);
    expect(f.calls.whisperStopped).toBe(1);
  });
});
