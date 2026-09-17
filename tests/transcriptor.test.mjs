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

// ONE DECODE AT A TIME (operator 2026-09-16): on 2026-09-14 dolly ran three whisper-cli at once
// and paged until nothing finished. The worker is the machine-wide chokepoint, so it queues.
describe('transcriptor server — one decode at a time', () => {
  // A transcribe whose every call waits for the test to settle it. Records the order decodes
  // STARTED in (by body), how many ran at once, and the most that ever did.
  function gated() {
    const g = { started: [], gates: [], inFlight: 0, maxInFlight: 0 };
    g.transcribe = async (path) => {
      g.started.push(readFileSync(path, 'utf8'));
      g.inFlight += 1; g.maxInFlight = Math.max(g.maxInFlight, g.inFlight);
      try { return await new Promise((resolve, reject) => g.gates.push({ resolve, reject })); }
      finally { g.inFlight -= 1; }
    };
    return g;
  }
  const until = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)); }
  };
  const post = (endpoint, tag) => {
    const body = Buffer.from(tag); const ts = Date.now();
    return fetch(`${endpoint}/v1/transcribe`, { method: 'POST', headers: { 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, body) }, body });
  };
  const queuedAt = (logs, n) => logs.some((m) => m.includes(`queue position ${n}`));

  it('concurrent POSTs decode one at a time, in arrival order; none is refused', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const b = post(endpoint, 'B');
    await until(() => g.started.length === 2 || queuedAt(logs, 1));
    const c = post(endpoint, 'C');
    await until(() => g.started.length === 3 || queuedAt(logs, 2));
    expect(g.started).toEqual(['A']);           // B and C wait while A decodes

    g.gates[0].resolve('text A');
    expect((await (await a).json()).transcript).toBe('text A');
    await until(() => g.started.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(g.started).toEqual(['A', 'B']);      // FIFO: B next, C still waiting

    g.gates[1].resolve('text B');
    expect((await (await b).json()).transcript).toBe('text B');
    await until(() => g.started.length === 3);
    g.gates[2].resolve('text C');
    expect((await (await c).json()).transcript).toBe('text C');
    expect(g.maxInFlight).toBe(1);
    // the request's lifetime is in the log: its position on arrival, then wait + decode
    expect(logs.some((m) => /queue position 2/.test(m))).toBe(true);
    expect(logs.some((m) => /waited \d+ms, decoded in \d+ms/.test(m))).toBe(true);
  });

  it('a decode that throws releases the slot: the queued one runs, and so does the next', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const b = post(endpoint, 'B');
    await until(() => g.started.length === 2 || queuedAt(logs, 1));
    expect(g.started).toEqual(['A']);

    g.gates[0].reject(new Error('whisper crashed'));
    expect((await a).status).toBe(500);
    await until(() => g.started.length === 2);
    g.gates[1].resolve('text B');
    const rb = await b;
    expect(rb.status).toBe(200);
    expect((await rb.json()).transcript).toBe('text B');

    const c = post(endpoint, 'C');
    await until(() => g.started.length === 3);
    g.gates[2].resolve('text C');
    expect((await c).status).toBe(200);
    expect(g.maxInFlight).toBe(1);
  });

  it('a queued caller that gives up (its timeoutMs counts the wait) never reaches transcribe', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);

    const bPath = join(dir, 'b.ogg');
    writeFileSync(bPath, 'B');
    await expect(transcribeViaEndpoint(bPath, { endpoint, keyB64: KEY, timeoutMs: 300 })).rejects.toThrow(/timeout|abort/i);
    expect(g.started).toEqual(['A']);           // B timed out on the caller while A decoded
    await until(() => logs.some((m) => /left after \d+ms queued/.test(m)));

    g.gates[0].resolve('text A');
    expect((await a).status).toBe(200);
    const c = post(endpoint, 'C');
    await until(() => g.started.length === 2);
    g.gates[1].resolve('text C');
    expect((await c).status).toBe(200);
    expect(g.started).toEqual(['A', 'C']);      // B's turn was skipped: whisper never ran for it
  });

  it('an unsigned request is refused at once behind a decode in flight — it never takes a place in the queue', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const r = await fetch(`${endpoint}/v1/transcribe`, { method: 'POST', body: Buffer.from('X') });
    expect(r.status).toBe(401);
    expect(queuedAt(logs, 1)).toBe(false);
    g.gates[0].resolve('text A');
    expect((await a).status).toBe(200);
    expect(g.started).toEqual(['A']);
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
