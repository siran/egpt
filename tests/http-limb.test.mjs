// http-limb.test.mjs — the chatbox limb (src/bridges/http.mjs) on a real loopback server: sessions,
// the JSON and SSE reads, CORS, max_chars, the rate limit, widget.js.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge, isHttpChatId, httpClientOf, HTTP_STRINGS } from '../src/bridges/http.mjs';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

const live = [];
afterEach(async () => { while (live.length) live.pop()(); });

async function limb(clients = { acme: { being: 'ed' } }, extra = {}) {
  const port = await freeSafeHttpPort();
  const got = [];
  const lines = [];
  const b = await startHttpBridge({ port, clients, onIncoming: (text, from) => got.push({ text, from }), onLog: (m) => lines.push(m), ...extra });
  live.push(() => b.stop());
  const url = (client = 'acme') => `http://127.0.0.1:${port}/chat/${client}/`;
  const post = (body, headers = {}, client = 'acme') => fetch(`${url(client)}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { b, port, got, lines, url, post };
}

// A minimal SSE reader over fetch: every `data:` event, parsed.
function sse(href) {
  const ac = new AbortController();
  const events = [];
  let wake = () => {};
  const done = (async () => {
    const res = await fetch(href, { signal: ac.signal });
    events.status = res.status;
    if (!res.ok) { wake(); return; }
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (data) events.push(JSON.parse(data));
      }
      wake();
    }
  })().catch(() => {});
  const until = async (test, ms = 3000) => {
    const end = Date.now() + ms;
    while (!test(events)) {
      if (Date.now() > end) throw new Error(`SSE: condition not met; saw ${JSON.stringify(events)}`);
      await new Promise((r) => { wake = r; setTimeout(r, 50); });
    }
    return events;
  };
  return { events, until, close: () => { ac.abort(); return done; } };
}

describe('sessions', () => {
  it('a first POST gets a new session token (≥128 bits) and enters as http:<client>-<sid>; the token is never the chat id or logged', async () => {
    const { post, got, lines } = await limb();
    const r = await post({ text: 'hola' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Buffer.from(j.session, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(j.message).toMatchObject({ from: 'visitor', text: 'hola', done: true });
    expect(got).toHaveLength(1);
    const { from } = got[0];
    expect(from).toMatchObject({ network: 'http', chatType: 'private', isSender: false, authorized: false, msgKey: j.message.id });
    expect(isHttpChatId(from.chatId)).toBe(true);
    expect(httpClientOf(from.chatId)).toBe('acme');
    expect(from.chatId).toMatch(/^http:acme-[0-9a-f]{16}$/);
    expect(from.chatId).not.toContain(j.session);
    expect(lines.join('\n')).not.toContain(j.session);
  });

  it('the same token continues its session; two tokens are two chats; an unknown token starts a new session', async () => {
    const { post, got } = await limb();
    const a = await (await post({ text: 'uno' })).json();
    const a2 = await (await post({ session: a.session, text: 'dos' })).json();
    const b = await (await post({ text: 'otro' })).json();
    const c = await (await post({ session: 'no-such-token', text: 'tres' })).json();
    expect(a2.session).toBe(a.session);
    expect(b.session).not.toBe(a.session);
    expect(c.session).not.toBe('no-such-token');
    const chats = got.map((g) => g.from.chatId);
    expect(chats[0]).toBe(chats[1]);
    expect(new Set(chats).size).toBe(3);
  });

  it('an expired token (idle past 30 days) starts a new session', async () => {
    let t = Date.UTC(2026, 9, 26);
    const { post, got } = await limb(undefined, { now: () => t });
    const a = await (await post({ text: 'hola' })).json();
    t += 31 * 24 * 3600_000;
    const b = await (await post({ session: a.session, text: 'sigo aquí' })).json();
    expect(b.session).not.toBe(a.session);
    expect(got[1].from.chatId).not.toBe(got[0].from.chatId);
  });

  it('sessions survive a restart (stateDir): the token still names its chat', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-state-'));
    try {
      const one = await limb(undefined, { stateDir });
      const a = await (await one.post({ text: 'hola' })).json();
      one.b.stop();
      await new Promise((r) => setTimeout(r, 50));
      const saved = JSON.parse(await readFile(join(stateDir, 'http-sessions.json'), 'utf8'));
      expect(JSON.stringify(saved)).not.toContain(a.session);
      const two = await limb(undefined, { stateDir });
      const b = await (await two.post({ session: a.session, text: 'de vuelta' })).json();
      expect(b.session).toBe(a.session);
      expect(two.got[0].from.chatId).toBe(one.got[0].from.chatId);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it('onNewSession is awaited before a new session\'s first line enters, and only for a new session', async () => {
    const order = [];
    const { post } = await limb(undefined, {
      onNewSession: async ({ client, chatId }) => { order.push(`hook ${client} ${chatId}`); await new Promise((r) => setTimeout(r, 50)); order.push('hook done'); },
      onIncoming: (text) => order.push(`line ${text}`),
    });
    const a = await (await post({ text: 'uno' })).json();
    await post({ session: a.session, text: 'dos' });
    expect(order).toHaveLength(4);
    expect(order[0]).toMatch(/^hook acme http:acme-[0-9a-f]{16}$/);
    expect(order.slice(1)).toEqual(['hook done', 'line uno', 'line dos']);
  });

  it('a failing onNewSession is logged and the line still enters', async () => {
    const { post, got, lines } = await limb(undefined, { onNewSession: () => { throw new Error('seed folder missing'); } });
    expect((await post({ text: 'hola' })).status).toBe(200);
    expect(got).toHaveLength(1);
    expect(lines.some((l) => /seed folder missing/.test(l))).toBe(true);
  });

  it('hidden characters in a visitor line are dropped before it enters (no forged node signature)', async () => {
    const { post, got } = await limb();
    await post({ text: 'hola​\u{E0041}' });
    expect(got[0].text).toBe('hola');
  });
});

describe('replies: the SSE stream and the JSON fetch', () => {
  it('a streamed reply arrives over SSE frame by frame, then final; the JSON fetch returns it, and since= returns only what changed', async () => {
    const { b, post, got, url } = await limb();
    const j = await (await post({ text: 'hola' })).json();
    const chatId = got[0].from.chatId;
    const stream = sse(`${url()}events?session=${encodeURIComponent(j.session)}`);
    await stream.until((ev) => ev.some((m) => m.from === 'visitor'));
    const h = b.startStreamMessage('⏳ Thinking…', { chatId });
    h.update('Hola, ¿en qué ⏳');
    await h.finish('Hola, ¿en qué te ayudo?');
    expect(h.delivered).toBe(true);
    expect(b.wasSentByUs(chatId, h.confirmedId)).toBe(true);
    const evs = await stream.until((ev) => ev.some((m) => m.from === 'being' && m.done));
    const frames = evs.filter((m) => m.id === h.confirmedId);
    expect(frames.map((m) => m.text)).toEqual(['⏳ Thinking…', 'Hola, ¿en qué ⏳', 'Hola, ¿en qué te ayudo?']);
    expect(frames.map((m) => m.done)).toEqual([false, false, true]);
    await stream.close();

    const all = await (await fetch(`${url()}messages?session=${encodeURIComponent(j.session)}`)).json();
    expect(all.messages.map((m) => [m.from, m.text, m.done])).toEqual([['visitor', 'hola', true], ['being', 'Hola, ¿en qué te ayudo?', true]]);
    const after = await (await fetch(`${url()}messages?session=${encodeURIComponent(j.session)}&since=${j.message.seq}`)).json();
    expect(after.messages.map((m) => m.text)).toEqual(['Hola, ¿en qué te ayudo?']);
    expect(after.seq).toBe(all.seq);
  });

  it('a reconnecting SSE client (since=) gets only what it missed; a deleted message says so', async () => {
    const { b, post, got, url } = await limb();
    const j = await (await post({ text: 'hola' })).json();
    const chatId = got[0].from.chatId;
    const sent = await b.send('uno', { chatId });
    const h = b.startStreamMessage('⏳', { chatId });
    const placeholder = h.confirmedId;
    expect(await h.delete()).toBe(true);
    expect(h.confirmedId).toBeNull();
    const stream = sse(`${url()}events?session=${encodeURIComponent(j.session)}&since=${j.message.seq}`);
    const evs = await stream.until((ev) => ev.length >= 2);
    await stream.close();
    expect(evs[0]).toMatchObject({ id: sent.messageId, from: 'being', text: 'uno' });
    expect(evs[1]).toEqual({ id: placeholder, deleted: true, seq: evs[1].seq });
    expect(evs.some((m) => m.from === 'visitor')).toBe(false);
  });

  it('an unknown session reads nothing (404) and a send to it is refused', async () => {
    const { b, url } = await limb();
    expect((await fetch(`${url()}messages?session=nope`)).status).toBe(404);
    expect((await fetch(`${url()}events?session=nope`)).status).toBe(404);
    expect(await b.send('hola', { chatId: 'http:acme-0123456789abcdef' })).toBeNull();
    expect(b.sendFailure('http:acme-0123456789abcdef')).toMatch(/no live chatbox session/);
  });
});

describe('CORS', () => {
  const clients = { acme: { being: 'ed', allowed_origins: ['https://www.acme.test'] }, solo: { being: 'ed' } };

  it('a listed origin is allowed (preflight and request carry its ACAO); an unlisted one is refused', async () => {
    const { post, url } = await limb(clients);
    const pre = await fetch(`${url()}messages`, { method: 'OPTIONS', headers: { Origin: 'https://www.acme.test', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://www.acme.test');
    const ok = await post({ text: 'hola' }, { Origin: 'https://www.acme.test' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://www.acme.test');

    const evilPre = await fetch(`${url()}messages`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' } });
    expect(evilPre.status).toBe(403);
    expect(evilPre.headers.get('access-control-allow-origin')).toBeNull();
    const evil = await post({ text: 'hola' }, { Origin: 'https://evil.test' });
    expect(evil.status).toBe(403);
  });

  it('an empty list is same-origin only: no CORS header, every preflight refused, and only JSON is taken (no simple cross-site POST)', async () => {
    const { post, url, got } = await limb(clients);
    const pre = await fetch(`${url('solo')}messages`, { method: 'OPTIONS', headers: { Origin: 'https://www.acme.test', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(403);
    const r = await post({ text: 'hola' }, {}, 'solo');
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const simple = await fetch(`${url('solo')}messages`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ text: 'hola' }) });
    expect(simple.status).toBe(415);
    expect(got).toHaveLength(1);
  });
});

describe('limits', () => {
  it('max_chars: a longer message is refused (413) and never enters', async () => {
    const { post, got } = await limb({ acme: { being: 'ed', max_chars: 10 } });
    expect((await post({ text: '1234567890' })).status).toBe(200);
    const r = await post({ text: '12345678901' });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ max_chars: 10 });
    expect(got).toHaveLength(1);
  });

  it('the default is 4000 characters', async () => {
    const { post } = await limb();
    expect((await post({ text: 'x'.repeat(4000) })).status).toBe(200);
    expect((await post({ text: 'x'.repeat(4001) })).status).toBe(413);
  });

  it('the per-session rate: past N messages in the window, 429 with Retry-After; another session is unaffected', async () => {
    const { post, got } = await limb({ acme: { being: 'ed', rate: { messages: 2, minutes: 10 } } });
    const a = await (await post({ text: '1' })).json();
    expect((await post({ session: a.session, text: '2' })).status).toBe(200);
    const r = await post({ session: a.session, text: '3' });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post({ text: 'otra sesión' })).status).toBe(200);
    expect(got.map((g) => g.text)).toEqual(['1', '2', 'otra sesión']);
  });

  it('new_sessions: past N new sessions from one address in the window, 429; that address\'s existing session still talks', async () => {
    const { post, got } = await limb({ acme: { being: 'ed', new_sessions: { count: 2, minutes: 60 } } });
    const a = await (await post({ text: '1' })).json();
    expect((await post({ text: '2' })).status).toBe(200);
    const r = await post({ text: '3' });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: 'too many new sessions' });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post({ session: 'unknown', text: '4' })).status).toBe(429);
    expect((await post({ session: a.session, text: 'sigo' })).status).toBe(200);
    expect(got.map((g) => g.text)).toEqual(['1', '2', 'sigo']);
  });

  it('the default is 30 new sessions per address per hour', async () => {
    const { post } = await limb();
    for (let i = 0; i < 30; i++) expect((await post({ text: `v${i}` })).status).toBe(200);
    expect((await post({ text: 'v30' })).status).toBe(429);
  });

  it('trust_proxy: the last X-Forwarded-For entry is the address; without it the header is ignored', async () => {
    const clients = { acme: { being: 'ed', new_sessions: { count: 1, minutes: 60 } } };
    const trusted = await limb(clients, { trustProxy: true });
    expect((await trusted.post({ text: 'a' }, { 'X-Forwarded-For': '9.9.9.9, 203.0.113.1' })).status).toBe(200);
    expect((await trusted.post({ text: 'b' }, { 'X-Forwarded-For': '9.9.9.9, 203.0.113.2' })).status).toBe(200);
    expect((await trusted.post({ text: 'c' }, { 'X-Forwarded-For': '1.1.1.1, 203.0.113.1' })).status).toBe(429);
    const plain = await limb(clients);
    expect((await plain.post({ text: 'a' }, { 'X-Forwarded-For': '203.0.113.1' })).status).toBe(200);
    expect((await plain.post({ text: 'b' }, { 'X-Forwarded-For': '203.0.113.2' })).status).toBe(429);
  });

  it('an empty message and a body that is not JSON are refused', async () => {
    const { post, url, got } = await limb();
    expect((await post({ text: '   ' })).status).toBe(400);
    expect((await fetch(`${url()}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status).toBe(400);
    expect(got).toHaveLength(0);
  });
});

describe('widget.js and routing', () => {
  it('widget.js is served as JavaScript with the client\'s title and Spanish strings', async () => {
    const { url } = await limb({ acme: { being: 'ed', title: 'EduWeb', strings: { send: 'Mandar' } } });
    const r = await fetch(`${url()}widget.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    const js = await r.text();
    expect(js).toContain('"title":"EduWeb"');
    expect(js).toContain('"send":"Mandar"');
    expect(js).toContain(JSON.stringify(HTTP_STRINGS.placeholder));
    expect(() => new Function(js)).not.toThrow();
  });

  it('an unknown client or path is 404', async () => {
    const { port, post } = await limb();
    expect((await post({ text: 'hola' }, {}, 'other')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
  });
});
