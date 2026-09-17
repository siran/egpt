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

// A 413 REFUSES ONE FILE (operator 2026-09-16). The worker used to destroy the request the moment it
// crossed the 32 MB cap, so its documented 413 was never written: the client saw a connection reset
// ("fetch failed", ECONNRESET) - indistinguishable from a worker that is down.
describe('transcriptor server — a body over the cap', () => {
  it('is answered 413, not a connection reset, and the client error carries status 413; the next note is served', async () => {
    const { calls, endpoint } = await startServer();
    const big = join(dir, 'video.mp4');
    writeFileSync(big, Buffer.alloc(32 * 1024 * 1024 + 1, 7));
    const err = await transcribeViaEndpoint(big, { endpoint, keyB64: KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/413/);
    expect(err.status).toBe(413);
    expect(calls).toHaveLength(0);
    expect(await transcribeViaEndpoint(audioPath, { endpoint, keyB64: KEY })).toBe('hola desde el worker');
  });

  // REGRESSION LOCK: every other refusal carries its status the same way.
  it('an empty transcription carries status 422', async () => {
    const { endpoint } = await startServer({ transcribe: async () => null });
    const err = await transcribeViaEndpoint(audioPath, { endpoint, keyB64: KEY }).catch((e) => e);
    expect(err.status).toBe(422);
  });
});

// ONE DECODE PER BYTES (operator 2026-09-16). One note reaches dolly's worker from both nodes, and
// from each node once per connection whose account is in the chat; the bytes are identical. On
// 2026-09-15 the worker decoded one 22,740-byte note twice back to back (24.4 s + 10.3 s).
describe('transcriptor server — the same bytes are decoded once', () => {
  function gated() {
    const g = { started: [], gates: [], inFlight: 0, maxInFlight: 0 };
    g.transcribe = async (path, _cfg, _log, meta) => {
      g.started.push(readFileSync(path, 'utf8'));
      g.inFlight += 1; g.maxInFlight = Math.max(g.maxInFlight, g.inFlight);
      try {
        const t = await new Promise((resolve, reject) => g.gates.push({ resolve, reject }));
        if (meta) meta.durationSec = 4.5;
        return t;
      } finally { g.inFlight -= 1; }
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
  const served = (logs) => logs.filter((m) => /served from an existing decode/.test(m)).length;
  const fileOf = (tag) => { const p = join(dir, `${tag}-${Math.random().toString(36).slice(2)}.ogg`); writeFileSync(p, tag); return p; };

  it('bytes already QUEUED: the second request takes no queue slot, and both get the one decode\'s transcript and durationSec', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const x1 = post(endpoint, 'X');
    await until(() => queuedAt(logs, 1));
    const x2 = post(endpoint, 'X');
    await until(() => served(logs) === 1 || queuedAt(logs, 2));
    expect(queuedAt(logs, 2)).toBe(false);                       // no slot of its own

    g.gates[0].resolve('text A');
    expect((await (await a).json()).transcript).toBe('text A');
    await until(() => g.started.length === 2);
    g.gates[1].resolve('text X');
    const j1 = await (await x1).json();
    await new Promise((r) => setTimeout(r, 50));
    expect(g.started).toEqual(['A', 'X']);                       // X decoded once
    const j2 = await (await x2).json();
    expect([j1.transcript, j2.transcript]).toEqual(['text X', 'text X']);
    expect([j1.durationSec, j2.durationSec]).toEqual([4.5, 4.5]);
    expect(g.maxInFlight).toBe(1);
  });

  it('bytes decoded a moment ago: answered from that result, without decoding', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const x1 = post(endpoint, 'X');
    await until(() => g.started.length === 1);
    g.gates[0].resolve('text X');
    expect((await (await x1).json()).transcript).toBe('text X');

    const x2 = post(endpoint, 'X');
    await until(() => served(logs) === 1 || g.started.length === 2);
    expect(g.started).toEqual(['X']);
    const r2 = await x2;
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, transcript: 'text X', durationSec: 4.5 });
  });

  it('an EMPTY result is not remembered: the same bytes are decoded again', async () => {
    let n = 0;
    const { endpoint } = await startServer({ transcribe: async () => (++n === 1 ? null : 'second try') });
    expect((await post(endpoint, 'X')).status).toBe(422);
    const r = await post(endpoint, 'X');
    expect(r.status).toBe(200);
    expect((await r.json()).transcript).toBe('second try');
    expect(n).toBe(2);
  });

  // REGRESSION LOCK: FIFO order. A request joining the decode in flight does not reorder the queue.
  it('different bytes keep their FIFO turns while a duplicate of the running decode joins it', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const b = post(endpoint, 'B');
    await until(() => queuedAt(logs, 1));
    const a2 = post(endpoint, 'A');
    await until(() => served(logs) === 1 || queuedAt(logs, 2));
    const c = post(endpoint, 'C');
    await until(() => queuedAt(logs, 2) && logs.filter((m) => m.includes('queue position')).length >= 2);

    g.gates[0].resolve('text A');
    expect((await (await a).json()).transcript).toBe('text A');
    expect((await (await a2).json()).transcript).toBe('text A');
    await until(() => g.started.length === 2);
    g.gates[1].resolve('text B');
    expect((await (await b).json()).transcript).toBe('text B');
    await until(() => g.started.length === 3);
    g.gates[2].resolve('text C');
    expect((await (await c).json()).transcript).toBe('text C');
    expect(g.started).toEqual(['A', 'B', 'C']);
    expect(logs.filter((m) => m.includes('queue position')).map((m) => m.replace(/.* from \S+ /, ''))).toEqual(['waits — queue position 1', 'waits — queue position 2']);
    expect(g.maxInFlight).toBe(1);
  });

  it('the first requester gives up while queued, but a duplicate still waits: the decode runs for it', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const gaveUp = transcribeViaEndpoint(fileOf('X'), { endpoint, keyB64: KEY, timeoutMs: 400 }).catch((e) => e);
    await until(() => queuedAt(logs, 1));
    const x2 = post(endpoint, 'X');
    await until(() => served(logs) === 1 || queuedAt(logs, 2));
    expect((await gaveUp).message).toMatch(/timeout|abort/i);
    await until(() => logs.some((m) => /left after \d+ms queued/.test(m)));

    g.gates[0].resolve('text A');
    expect((await a).status).toBe(200);
    await until(() => g.started.length === 2);
    g.gates[1].resolve('text X');
    const r2 = await x2;
    expect(r2.status).toBe(200);
    expect((await r2.json()).transcript).toBe('text X');
    expect(g.started).toEqual(['A', 'X']);
  });

  it('every requester of those bytes gives up while queued: the decode never runs, and the next arrival starts afresh', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const x1 = transcribeViaEndpoint(fileOf('X'), { endpoint, keyB64: KEY, timeoutMs: 400 }).catch((e) => e);
    await until(() => queuedAt(logs, 1));
    const x2 = transcribeViaEndpoint(fileOf('X'), { endpoint, keyB64: KEY, timeoutMs: 400 }).catch((e) => e);
    await until(() => served(logs) === 1 || queuedAt(logs, 2));
    expect((await x1).message).toMatch(/timeout|abort/i);
    expect((await x2).message).toMatch(/timeout|abort/i);
    await until(() => logs.some((m) => /its decode will not run/.test(m)));

    g.gates[0].resolve('text A');
    expect((await a).status).toBe(200);
    const c = post(endpoint, 'C');
    await until(() => g.started.length === 2);
    expect(g.started).toEqual(['A', 'C']);                       // X's turn was skipped
    const x3 = post(endpoint, 'X');
    g.gates[1].resolve('text C');
    expect((await c).status).toBe(200);
    await until(() => g.started.length === 3);
    g.gates[2].resolve('text X');
    expect((await (await x3).json()).transcript).toBe('text X');
    expect(g.started).toEqual(['A', 'C', 'X']);
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
