// transcriptor-worker.test.mjs — the WORKER ROLE service (src/spine/transcriptor-worker.mjs),
// ported from v1 egpt-spine.mjs (~4861) to the v2 spine. Covers the CONFIG-RESOLUTION ladder
// (canonical wins + each legacy fallback), the enabled/token gate, the resident-whisper-server
// vs whisper-cli-per-note branch, and teardown — all against FAKE spawn seams, so no real
// whisper-server is spawned and no real port is bound.
import { describe, it, expect } from 'vitest';
import {
  createTranscriptorWorker, resolveAudioCfg, resolveToken, resolveServerCfg,
} from '../src/spine/transcriptor-worker.mjs';

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
