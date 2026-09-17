// Worker-spine transcription: HMAC auth, byte round-trip, and the
// remote-first / local-fallback contract on the main-spine side.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
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

// ── "DO YOU HAVE THIS SHA?" FIRST, AND A MEMORY THAT OUTLIVES THE WORKER (operator 2026-09-17) ──
// "the initial request is handshake of 'do you have this sha?': if no then 'sending audio', if yes then
// 'response is transcript'". do's log, 2026-09-17: do decoded notes for its own chats between 05:45 and
// 07:03; kg's bridge came back at 07:09 and sent the same notes, and do DECODED FIVE AGAIN (12600b first
// at 05:45:39, again at 07:09:40), because they were older than the 10-minute memory. kg also resent the
// whole audio every time, an 11.5 MB video included.
describe('transcriptor — "do you have this sha?" first, and a memory that outlives the worker', () => {
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const until = async (cond, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)); }
  };
  const fileOf = (tag, bytes = Buffer.from(tag)) => { const p = join(dir, `${tag}-${Math.random().toString(36).slice(2)}.ogg`); writeFileSync(p, bytes); return p; };
  const memoryFile = (stateDir) => join(stateDir, 'transcriptor-decoded.json');
  const post = (endpoint, tag) => {
    const body = Buffer.from(tag); const ts = Date.now();
    return fetch(`${endpoint}/v1/transcribe`, { method: 'POST', headers: { 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, body) }, body });
  };
  // The lookup is signed exactly as a POST of those bytes would be: HMAC over `${ts}.${sha256(bytes)}`.
  const lookup = (endpoint, bytes) => {
    const ts = Date.now();
    return fetch(`${endpoint}/v1/transcript/${sha(bytes)}`, { headers: { 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, bytes) } });
  };
  // Every decode yields a transcript naming its turn, so a second decode of the same bytes shows.
  const counting = () => {
    const c = { decodes: 0 };
    c.transcribe = async (_p, _cfg, _log, meta) => { c.decodes += 1; if (meta) meta.durationSec = 2.5; return `transcript #${c.decodes}`; };
    return c;
  };
  function gated() {
    const g = { started: [], gates: [] };
    g.transcribe = async (path) => { g.started.push(readFileSync(path, 'utf8')); return new Promise((resolve, reject) => g.gates.push({ resolve, reject })); };
    return g;
  }
  const served = (logs) => logs.filter((m) => /served from an existing decode/.test(m)).length;
  const queuePositions = (logs) => logs.filter((m) => m.includes('queue position')).map((m) => m.replace(/.* from \S+ /, ''));
  // An HTTP proxy in front of a worker: records each request the client sent (method, path, the body
  // bytes that crossed the wire, the worker's status) and forwards it unchanged.
  async function recorder(port) {
    const seen = [];
    const srv = createServer((req, res) => {
      const r = { method: req.method, path: req.url, bytes: 0, status: null };
      seen.push(r);
      const up = httpRequest({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers, agent: false }, (ur) => {
        r.status = ur.statusCode; res.writeHead(ur.statusCode, ur.headers); ur.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.on('data', (c) => { r.bytes += c.length; });
      req.pipe(up);
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    servers.push({ close: () => { srv.closeAllConnections?.(); srv.close(); } });
    return { seen, endpoint: `http://127.0.0.1:${srv.address().port}` };
  }

  it('a second request for the same bytes after the worker RESTARTS is answered without decoding', async () => {
    const c = counting(); const stateDir = join(dir, 'state');
    const note = fileOf('note', Buffer.from('opus-voice-note-bytes-'.repeat(40)));
    const first = await startServer({ transcribe: c.transcribe, stateDir });
    expect(await transcribeViaEndpoint(note, { endpoint: first.endpoint, keyB64: KEY })).toBe('transcript #1');
    first.s.close();

    const again = await startServer({ transcribe: c.transcribe, stateDir });
    const meta = {};
    expect(await transcribeViaEndpoint(note, { endpoint: again.endpoint, keyB64: KEY }, () => {}, meta)).toBe('transcript #1');
    expect(c.decodes).toBe(1);
    expect(meta.durationSec).toBe(2.5);
  });

  it('the same bytes 84 minutes later (do: 12600b at 05:45:39, again at 07:09:40; fake clock) are answered without decoding', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const c = counting();
      const { endpoint } = await startServer({ transcribe: c.transcribe, stateDir: join(dir, 'state') });
      const note = fileOf('note', Buffer.from('opus-voice-note-bytes-'.repeat(40)));
      expect(await transcribeViaEndpoint(note, { endpoint, keyB64: KEY })).toBe('transcript #1');
      vi.setSystemTime(Date.now() + 84 * 60_000);
      expect(await transcribeViaEndpoint(note, { endpoint, keyB64: KEY })).toBe('transcript #1');
      expect(c.decodes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a KNOWN sha is answered to the lookup: no audio is uploaded', async () => {
    const c = counting();
    const w = await startServer({ transcribe: c.transcribe });
    const bytes = Buffer.alloc(256 * 1024, 3);                    // stands in for kg's 11.5 MB video
    const video = fileOf('video', bytes);
    expect(await transcribeViaEndpoint(video, { endpoint: w.endpoint, keyB64: KEY })).toBe('transcript #1');

    const rec = await recorder(w.s.port);
    const meta = {};
    expect(await transcribeViaEndpoint(fileOf('same-video', bytes), { endpoint: rec.endpoint, keyB64: KEY }, () => {}, meta)).toBe('transcript #1');
    expect(rec.seen).toEqual([{ method: 'GET', path: `/v1/transcript/${sha(bytes)}`, bytes: 0, status: 200 }]);
    expect(meta.durationSec).toBe(2.5);
    expect(c.decodes).toBe(1);
  });

  it('an UNKNOWN sha: the lookup says so, then the audio is POSTed exactly once', async () => {
    const c = counting(); const logs = [];
    const w = await startServer({ transcribe: c.transcribe, onLog: (m) => logs.push(m) });
    const rec = await recorder(w.s.port);
    const bytes = Buffer.from('a note this worker never saw '.repeat(20));
    expect(await transcribeViaEndpoint(fileOf('new', bytes), { endpoint: rec.endpoint, keyB64: KEY })).toBe('transcript #1');
    expect(rec.seen).toEqual([
      { method: 'GET', path: `/v1/transcript/${sha(bytes)}`, bytes: 0, status: 404 },
      { method: 'POST', path: '/v1/transcribe', bytes: bytes.length, status: 200 },
    ]);
    expect(logs.some((m) => m.includes(`lookup ${sha(bytes).slice(0, 12)} from `) && /unknown — the audio follows/.test(m))).toBe(true);
    expect(c.decodes).toBe(1);
  });

  it('a lookup while that decode RUNS gets its transcript and queues nothing', async () => {
    const g = gated(); const logs = [];
    const w = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const x1 = post(w.endpoint, 'X');                             // one node's POST is decoding
    await until(() => g.started.length === 1);
    const rec = await recorder(w.s.port);
    const x2 = transcribeViaEndpoint(fileOf('X'), { endpoint: rec.endpoint, keyB64: KEY });   // the other node asks
    await until(() => served(logs) === 1);
    g.gates[0].resolve('text X');
    expect(await x2).toBe('text X');
    expect((await (await x1).json()).transcript).toBe('text X');
    expect(rec.seen.map((r) => r.method)).toEqual(['GET']);
    expect(g.started).toEqual(['X']);
    expect(queuePositions(logs)).toEqual([]);
    expect(logs.some((m) => /lookup [0-9a-f]{12} from \S+ served from an existing decode \(already queued or decoding\)/.test(m))).toBe(true);
  });

  it('a lookup of bytes decoded a moment ago is answered from memory, and says so', async () => {
    const c = counting(); const logs = [];
    const w = await startServer({ transcribe: c.transcribe, onLog: (m) => logs.push(m) });
    const bytes = readFileSync(audioPath);
    expect(await transcribeViaEndpoint(audioPath, { endpoint: w.endpoint, keyB64: KEY })).toBe('transcript #1');
    const r = await lookup(w.endpoint, bytes);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, transcript: 'transcript #1', durationSec: 2.5 });
    expect(logs.some((m) => m.includes(`lookup ${sha(bytes).slice(0, 12)} from `) && /served from an existing decode \(a recent result\)/.test(m))).toBe(true);
    expect(c.decodes).toBe(1);
  });

  it('a new client against an OLD worker (no lookup route: 404 not found) still gets its transcript through the POST', async () => {
    // The old worker's routing as deployed (958e88b): POST /v1/transcribe, anything else 404 not found.
    const seen = [];
    const old = createServer((req, res) => {
      const json = (code, obj) => { seen.push({ method: req.method, path: req.url, status: code }); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method !== 'POST' || req.url !== '/v1/transcribe') return json(404, { ok: false, error: 'not found' });
      req.resume();
      req.on('end', () => json(200, { ok: true, transcript: 'hola desde el worker viejo', durationSec: 1.5, ms: 3 }));
    });
    await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
    servers.push({ close: () => { old.closeAllConnections?.(); old.close(); } });
    const meta = {};
    const t = await transcribeViaEndpoint(audioPath, { endpoint: `http://127.0.0.1:${old.address().port}`, keyB64: KEY }, () => {}, meta);
    expect(t).toBe('hola desde el worker viejo');
    expect(meta.durationSec).toBe(1.5);
    expect(seen).toEqual([
      { method: 'GET', path: `/v1/transcript/${sha(readFileSync(audioPath))}`, status: 404 },
      { method: 'POST', path: '/v1/transcribe', status: 200 },
    ]);
  });

  it('a bad or stale signature on the lookup is refused 401, even for a sha the worker knows', async () => {
    const c = counting();
    const w = await startServer({ transcribe: c.transcribe });
    const bytes = readFileSync(audioPath);
    await transcribeViaEndpoint(audioPath, { endpoint: w.endpoint, keyB64: KEY });
    const get = (headers) => fetch(`${w.endpoint}/v1/transcript/${sha(bytes)}`, { headers });

    expect((await get({})).status).toBe(401);                                                                   // unsigned
    const ts = Date.now();
    expect((await get({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(OTHER_KEY, ts, bytes) })).status).toBe(401);   // wrong key
    const stale = Date.now() - 120_000;
    expect((await get({ 'x-egpt-ts': String(stale), 'x-egpt-sig': signAudio(KEY, stale, bytes) })).status).toBe(401);   // stale
    expect((await get({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, Buffer.from('other')) })).status).toBe(401);   // signed for other bytes
    // ONE signing scheme: the signature a POST of these bytes carries opens the lookup.
    const ok = await get({ 'x-egpt-ts': String(ts), 'x-egpt-sig': signAudio(KEY, ts, bytes) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).transcript).toBe('transcript #1');
    expect(c.decodes).toBe(1);
  });

  it('a corrupt memory file does not stop the worker: it starts empty, says so once, and keeps the next result', async () => {
    const c = counting(); const logs = []; const stateDir = join(dir, 'state');
    mkdirSync(stateDir);
    writeFileSync(memoryFile(stateDir), '[["half-written", {"at": 17');
    const w = await startServer({ transcribe: c.transcribe, stateDir, onLog: (m) => logs.push(m) });
    expect(logs.filter((m) => /starting empty/.test(m))).toHaveLength(1);
    expect(logs.some((m) => /listening on/.test(m))).toBe(true);
    expect(await transcribeViaEndpoint(audioPath, { endpoint: w.endpoint, keyB64: KEY })).toBe('transcript #1');
    expect(JSON.parse(readFileSync(memoryFile(stateDir), 'utf8')).map(([k]) => k)).toEqual([sha(readFileSync(audioPath))]);
    expect(logs.filter((m) => /starting empty/.test(m))).toHaveLength(1);
  });

  it('a missing memory file: the worker starts empty and says so once', async () => {
    const c = counting(); const logs = [];
    const w = await startServer({ transcribe: c.transcribe, stateDir: join(dir, 'never-made'), onLog: (m) => logs.push(m) });
    expect(logs.filter((m) => /starting empty/.test(m))).toHaveLength(1);
    expect(await transcribeViaEndpoint(audioPath, { endpoint: w.endpoint, keyB64: KEY })).toBe('transcript #1');
    expect(logs.filter((m) => /starting empty/.test(m))).toHaveLength(1);
  });

  // REGRESSION LOCK: an empty result is remembered nowhere: not for a lookup, not on disk, not after a restart.
  it('LOCK: an EMPTY result is not remembered — the lookup stays unknown, across a restart too, and the bytes decode again', async () => {
    let n = 0;
    const transcribe = async () => (++n === 1 ? null : 'second try');
    const stateDir = join(dir, 'state'); const X = Buffer.from('X');
    const first = await startServer({ transcribe, stateDir });
    expect((await post(first.endpoint, 'X')).status).toBe(422);
    expect((await lookup(first.endpoint, X)).status).toBe(404);
    first.s.close();
    const again = await startServer({ transcribe, stateDir });
    expect((await lookup(again.endpoint, X)).status).toBe(404);
    const r = await post(again.endpoint, 'X');
    expect(r.status).toBe(200);
    expect((await r.json()).transcript).toBe('second try');
    expect(n).toBe(2);
  });

  // REGRESSION LOCK: FIFO. A lookup that joins the running decode takes no queue turn of its own.
  it('LOCK: FIFO — different bytes keep their turns while a lookup joins the running decode', async () => {
    const g = gated(); const logs = [];
    const { endpoint } = await startServer({ transcribe: g.transcribe, onLog: (m) => logs.push(m) });
    const a = post(endpoint, 'A');
    await until(() => g.started.length === 1);
    const b = post(endpoint, 'B');
    await until(() => queuePositions(logs).length === 1);
    const a2 = lookup(endpoint, Buffer.from('A'));
    await until(() => served(logs) === 1 || queuePositions(logs).length === 2);
    const c = post(endpoint, 'C');
    await until(() => queuePositions(logs).length === 2);

    g.gates[0].resolve('text A');
    expect((await (await a).json()).transcript).toBe('text A');
    const r2 = await a2;
    expect(r2.status).toBe(200);
    expect((await r2.json()).transcript).toBe('text A');
    await until(() => g.started.length === 2);
    g.gates[1].resolve('text B');
    expect((await (await b).json()).transcript).toBe('text B');
    await until(() => g.started.length === 3);
    g.gates[2].resolve('text C');
    expect((await (await c).json()).transcript).toBe('text C');
    expect(g.started).toEqual(['A', 'B', 'C']);
    expect(queuePositions(logs)).toEqual(['waits — queue position 1', 'waits — queue position 2']);
  });

  // REGRESSION LOCK: a file over the cap still comes back as a 413 the pipeline reads as "this file", with
  // the lookup in front of it.
  it('LOCK: a file over the cap — unknown to the lookup, then 413 carrying status 413; the next note is served', async () => {
    const c = counting(); const logs = [];
    const w = await startServer({ transcribe: c.transcribe, onLog: (m) => logs.push(m) });
    const big = fileOf('video', Buffer.alloc(32 * 1024 * 1024 + 1, 7));
    const err = await transcribeViaEndpoint(big, { endpoint: w.endpoint, keyB64: KEY }).catch((e) => e);
    expect(err.status).toBe(413);
    expect(logs.some((m) => /lookup [0-9a-f]{12} from \S+ unknown — the audio follows/.test(m))).toBe(true);
    expect(c.decodes).toBe(0);
    expect(await transcribeViaEndpoint(audioPath, { endpoint: w.endpoint, keyB64: KEY })).toBe('transcript #1');
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
