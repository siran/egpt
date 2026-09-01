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

// PLATFORM venv LAYOUT: `python -m venv` puts the interpreter at venv/Scripts/python.exe on
// Windows but venv/bin/python on macOS/Linux. Getting this wrong kills TTS SILENTLY — the
// bad path only surfaces when piper is spawned, and start()'s try/catch just logs it.
describe('synthesizer worker — pythonPath venv layout per platform', () => {
  const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
  const setPlatform = (value) => Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM, value });
  afterEach(() => Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM));

  async function pythonPathOn(platform) {
    setPlatform(platform);
    const f = fakes();
    const w = createSynthesizerWorker({
      getConfig: () => ({ synthesizer: { enabled: true, server: { token: 'K' } } }),
      ...f,
    });
    await w.start();
    return f.calls.server[0].pythonPath;
  }

  // Separator-agnostic: node:path's join follows the HOST, so a faked darwin on a Windows dev
  // box still yields backslashes. The SEGMENTS are what this bug is about, not the separator.
  const tail = (p) => p.split(/[\\/]/).slice(-3).join('/');

  it('darwin/linux: the POSIX venv layout, venv/bin/python', async () => {
    expect(tail(await pythonPathOn('darwin'))).toBe('venv/bin/python');
    expect(tail(await pythonPathOn('linux'))).toBe('venv/bin/python');
  });

  it('win32 REGRESSION LOCK: still venv/Scripts/python.exe (the operator\'s live node)', async () => {
    expect(tail(await pythonPathOn('win32'))).toBe('venv/Scripts/python.exe');
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
