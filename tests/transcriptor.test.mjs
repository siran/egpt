// Worker-spine transcription: HMAC auth, byte round-trip, and the
// remote-first / local-fallback contract on the main-spine side.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startTranscriptorServer, transcribeViaEndpoint, makeRemoteFirstTranscriber, signAudio,
} from '../src/tools/transcriptor.mjs';

const KEY = 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMDA';   // base64url, any 32ish bytes
const OTHER_KEY = 'b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci0wMA';

let dir, audioPath, server, servers;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'egpt-transcriptor-'));
  audioPath = join(dir, 'note.ogg');
  writeFileSync(audioPath, Buffer.from('fake-ogg-bytes-' + 'x'.repeat(100)));
  servers = [];
});
afterEach(() => {
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function startServer(extra = {}) {
  const calls = [];
  const s = await startTranscriptorServer({
    port: 0, bind: '127.0.0.1', keyB64: KEY,
    transcribe: async (path) => { calls.push(readFileSync(path)); return 'hola desde el worker'; },
    ...extra,
  });
  servers.push(s);
  return { s, calls, endpoint: `http://127.0.0.1:${s.port}` };
}

describe('transcriptor server', () => {
  it('round-trips audio bytes and returns the transcript', async () => {
    const { calls, endpoint } = await startServer();
    const t = await transcribeViaEndpoint(audioPath, { endpoint, keyB64: KEY });
    expect(t).toBe('hola desde el worker');
    // The worker transcribed EXACTLY the bytes we sent.
    expect(calls).toHaveLength(1);
    expect(Buffer.compare(calls[0], readFileSync(audioPath))).toBe(0);
  });

  it('round-trips durationSec from the worker (the ffmpeg WAV) to the client meta', async () => {
    const { endpoint } = await startServer({
      transcribe: async (_p, _cfg, _log, meta) => { if (meta) meta.durationSec = 3.5; return 'hola'; },
    });
    const meta = {};
    const t = await transcribeViaEndpoint(audioPath, { endpoint, keyB64: KEY }, () => {}, meta);
    expect(t).toBe('hola');
    expect(meta.durationSec).toBe(3.5);   // #3: duration survives the LAN round-trip
  });

  it('rejects missing, wrong-key, and stale signatures', async () => {
    const { endpoint } = await startServer();
    const body = readFileSync(audioPath);
    const post = (headers) => fetch(`${endpoint}/v1/transcribe`, { method: 'POST', headers, body });

    expect((await post({})).status).toBe(401);                                   // unsigned

    const ts = Date.now();
    expect((await post({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(OTHER_KEY, ts, body) })).status).toBe(401);   // wrong key

    const stale = Date.now() - 120_000;
    expect((await post({ 'x-egpt-ts': String(stale), 'x-egpt-sig': signAudio(KEY, stale, body) })).status).toBe(401);   // stale

    // tampered body: signed over different bytes
    expect((await post({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, Buffer.from('other')) })).status).toBe(401);
  });

  it('empty transcription → 422, which the client treats as failure', async () => {
    const { endpoint } = await startServer({ transcribe: async () => null });
    await expect(transcribeViaEndpoint(audioPath, { endpoint, keyB64: KEY })).rejects.toThrow(/422/);
  });

  it('health endpoint answers without auth', async () => {
    const { endpoint } = await startServer();
    const j = await (await fetch(`${endpoint}/v1/health`)).json();
    expect(j).toEqual({ ok: true, role: 'transcriptor' });
  });
});

describe('makeRemoteFirstTranscriber (main-spine side)', () => {
  it('uses the worker when healthy; local is never called', async () => {
    const { endpoint } = await startServer();
    let localCalls = 0;
    const transcribe = makeRemoteFirstTranscriber({
      endpoint, getKey: async () => KEY,
      local: async () => { localCalls += 1; return 'local'; },
    });
    expect(await transcribe(audioPath, {}, () => {})).toBe('hola desde el worker');
    expect(localCalls).toBe(0);
  });

  it('falls back to local whisper when the worker is unreachable', async () => {
    const logs = [];
    const transcribe = makeRemoteFirstTranscriber({
      endpoint: 'http://127.0.0.1:9',   // closed port
      getKey: async () => KEY,
      timeoutMs: 1500,
      local: async () => 'local transcript',
    });
    expect(await transcribe(audioPath, {}, (m) => logs.push(m))).toBe('local transcript');
    expect(logs.some((m) => m.includes('falling back to local'))).toBe(true);
  });

  it('falls back when the worker returns an empty transcription', async () => {
    const { endpoint } = await startServer({ transcribe: async () => null });
    const transcribe = makeRemoteFirstTranscriber({
      endpoint, getKey: async () => KEY,
      local: async () => 'local transcript',
    });
    expect(await transcribe(audioPath, {}, () => {})).toBe('local transcript');
  });

  it('no endpoint configured → straight to local', async () => {
    let localCalls = 0;
    const transcribe = makeRemoteFirstTranscriber({
      endpoint: null, getKey: async () => { throw new Error('must not be called'); },
      local: async () => { localCalls += 1; return 'local'; },
    });
    expect(await transcribe(audioPath, {}, () => {})).toBe('local');
    expect(localCalls).toBe(1);
  });
});
