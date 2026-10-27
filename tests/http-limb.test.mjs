// http-limb.test.mjs — the chatbox limb (src/bridges/http.mjs) on a real loopback server: sessions,
// the JSON and SSE reads, CORS, max_chars, the rate limit, widget.js.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge, isHttpChatId, httpClientOf, HTTP_STRINGS, DEEP_CHAT } from '../src/bridges/http.mjs';
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

  it('a token idle past session_days (default 365, per client) is expired and starts a new session', async () => {
    const DAY = 24 * 3600_000;
    let t = Date.UTC(2026, 9, 26);
    const { post, got } = await limb({ acme: { being: 'ed' }, brief: { being: 'ed', session_days: 30 } }, { now: () => t });
    const a = await (await post({ text: 'hola' })).json();
    const s = await (await post({ text: 'hola' }, {}, 'brief')).json();
    t += 31 * DAY;
    expect((await (await post({ session: a.session, text: 'sigo aquí' })).json()).session).toBe(a.session);
    expect(got[2].from.chatId).toBe(got[0].from.chatId);
    const s2 = await (await post({ session: s.session, text: 'sigo aquí' }, {}, 'brief')).json();
    expect(s2.session).not.toBe(s.session);
    expect(got[3].from.chatId).not.toBe(got[1].from.chatId);
    t += 365 * DAY;
    const b = await (await post({ session: a.session, text: 'un año después' })).json();
    expect(b.session).not.toBe(a.session);
    expect(got[4].from.chatId).not.toBe(got[0].from.chatId);
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
      await two.b.stop();
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it('history survives a restart: GET messages returns the log (a reply cut mid-stream settled as it stood), old ids stay editable, new seqs come after', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-state-'));
    const t = Date.UTC(2026, 9, 26);   // a frozen clock: only the saved seqs keep the new ones ahead
    try {
      const one = await limb(undefined, { stateDir, now: () => t });
      const a = await (await one.post({ text: 'hola' })).json();
      const chatId = one.got[0].from.chatId;
      const sent = await one.b.send('Hola, ¿en qué te ayudo?', { chatId });
      const h = one.b.startStreamMessage('⏳', { chatId });
      h.update('Un momento');
      await one.b.stop();
      const sid = chatId.slice(-16);
      expect(await readdir(join(stateDir, 'http-messages'))).toEqual([`${sid}.json`]);
      expect(await readFile(join(stateDir, 'http-messages', `${sid}.json`), 'utf8')).not.toContain(a.session);

      const two = await limb(undefined, { stateDir, now: () => t });
      const r = await fetch(`${two.url()}messages?session=${encodeURIComponent(a.session)}`);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.messages.map((m) => [m.from, m.text, m.done])).toEqual([['visitor', 'hola', true], ['being', 'Hola, ¿en qué te ayudo?', true], ['being', 'Un momento', true]]);
      expect(j.messages[1].id).toBe(sent.messageId);
      expect(two.b.editMessage(chatId, sent.messageId, 'Hola de nuevo')).toBe(true);
      const after = await (await fetch(`${two.url()}messages?session=${encodeURIComponent(a.session)}&since=${j.seq}`)).json();
      expect(after.messages.map((m) => [m.id, m.text])).toEqual([[sent.messageId, 'Hola de nuevo']]);
      const b = await (await two.post({ session: a.session, text: 'sigo' })).json();
      expect(b.message.seq).toBeGreaterThan(after.seq);
      expect(j.messages.map((m) => m.id)).not.toContain(b.message.id);
      await two.b.stop();
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it('an expired session\'s history file is removed, and a file with no session is pruned at start', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-state-'));
    let t = Date.UTC(2026, 9, 26);
    try {
      const one = await limb(undefined, { stateDir, now: () => t });
      const a = await (await one.post({ text: 'hola' })).json();
      t += 366 * 24 * 3600_000;
      await one.post({ session: a.session, text: 'sigo aquí' });
      await one.b.stop();
      const [oldChat, newChat] = one.got.map((g) => g.from.chatId.slice(-16));
      expect(await readdir(join(stateDir, 'http-messages'))).toEqual([`${newChat}.json`]);
      expect(oldChat).not.toBe(newChat);

      await writeFile(join(stateDir, 'http-messages', 'ffffffffffffffff.json'), '[]');
      const two = await limb(undefined, { stateDir, now: () => t });
      await two.b.stop();
      expect(await readdir(join(stateDir, 'http-messages'))).toEqual([`${newChat}.json`]);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it('beforeLine is awaited before each line enters; isNew only for a new session\'s first', async () => {
    const order = [];
    const { post } = await limb(undefined, {
      beforeLine: async ({ client, chatId, isNew }) => { order.push(`hook ${client} ${chatId} ${isNew}`); await new Promise((r) => setTimeout(r, 50)); order.push('hook done'); },
      onIncoming: (text) => order.push(`line ${text}`),
    });
    const a = await (await post({ text: 'uno' })).json();
    await post({ session: a.session, text: 'dos' });
    expect(order).toHaveLength(6);
    expect(order[0]).toMatch(/^hook acme http:acme-[0-9a-f]{16} true$/);
    expect(order[3]).toBe(order[0].replace(/true$/, 'false'));
    expect(order.filter((_, i) => i !== 0 && i !== 3)).toEqual(['hook done', 'line uno', 'hook done', 'line dos']);
  });

  it("beforeLine's recap(): the panel's earlier lines, a header with their count and the last five", async () => {
    const recaps = [];
    const { b, post, got } = await limb({ acme: { being: 'asesor', strings: { earlier: 'antes: {n}' } } }, { beforeLine: ({ recap }) => { recaps.push(recap()); } });
    const a = await (await post({ text: 'l1' })).json();
    b.send('r1', { chatId: got[0].from.chatId });
    for (const t of ['l2', 'l3', 'l4', 'l5', 'l6']) await post({ session: a.session, text: t });
    expect(recaps[0]).toBeNull();
    expect(recaps.at(-1)).toBe(['antes: 6', 'asesor: r1', 'visitor: l2', 'visitor: l3', 'visitor: l4', 'visitor: l5'].join('\n'));
    expect(HTTP_STRINGS.earlier).toBe('(conversación iniciada antes: {n} mensajes)');
  });

  it('a failing beforeLine is logged and the line still enters', async () => {
    const { post, got, lines } = await limb(undefined, { beforeLine: () => { throw new Error('seed folder missing'); } });
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

  it('a retried POST (the same client id) posts one line and gets the first answer, a new session\'s token included', async () => {
    const { post, got, url } = await limb();
    const id = 'c0ffee'.repeat(4);
    const first = await (await post({ text: 'hola', id })).json();
    const again = await post({ text: 'hola', id });   // the first answer was lost: still no session
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    const next = { session: first.session, text: 'otra', id: 'beef'.repeat(6) };
    const n1 = await (await post(next)).json();
    expect(await (await post(next)).json()).toEqual(n1);
    expect(got.map((g) => g.text)).toEqual(['hola', 'otra']);
    const log = await (await fetch(`${url()}messages?session=${encodeURIComponent(first.session)}`)).json();
    expect(log.messages.map((m) => m.text)).toEqual(['hola', 'otra']);
  });

  it('a retry while the first POST is still held waits for it: one session, one line; a retry is not counted by the rate', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const { post, got, lines } = await limb({ acme: { being: 'ed', rate: { messages: 2, minutes: 10 } } }, { beforeLine: ({ isNew }) => (isNew ? held : null) });
    const id = 'f00d'.repeat(6);
    const one = post({ text: 'hola', id });
    while (!lines.some((l) => /new session/.test(l))) await new Promise((r) => setTimeout(r, 10));
    const two = post({ text: 'hola', id });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(0);
    release();
    const [a, b] = await Promise.all([one, two].map((p) => p.then((r) => r.json())));
    expect(b).toEqual(a);
    expect(got).toHaveLength(1);
    expect((await post({ session: a.session, text: 'dos' })).status).toBe(200);
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

describe('POST end: the visitor ends the conversation', () => {
  const end = (url, session, headers = {}) => fetch(`${url}end`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ session }) });
  const history = async (url, session) => (await (await fetch(`${url}messages?session=${encodeURIComponent(session)}`)).json()).messages;

  it('onEnd gets the chat and the ended line; the history is cleared, on disk too; the same token keeps the same chat', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-end-'));
    try {
      const ends = [];
      const { b, post, url, got } = await limb({ acme: { being: 'ed', strings: { ended: 'FIN' } } }, { stateDir, onEnd: (e) => { ends.push(e); } });
      const a = await (await post({ text: 'hola' })).json();
      const chatId = got[0].from.chatId;
      await b.send('respuesta', { chatId });
      expect(await history(url(), a.session)).toHaveLength(2);
      const r = await end(url(), a.session);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      expect(ends).toEqual([{ client: 'acme', chatId, ended: 'FIN' }]);
      expect(await history(url(), a.session)).toEqual([]);
      const again = await (await post({ session: a.session, text: 'otra cosa' })).json();
      expect(again.session).toBe(a.session);
      expect(got[1].from.chatId).toBe(chatId);
      expect((await history(url(), a.session)).map((m) => m.text)).toEqual(['otra cosa']);
      await b.stop();
      const saved = JSON.parse(await readFile(join(stateDir, 'http-messages', `${chatId.split('-').at(-1)}.json`), 'utf8'));
      expect(saved.map((m) => m.text)).toEqual(['otra cosa']);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it('the default ended line is the Spanish one; nothing said since the last end: a second end does nothing', async () => {
    const ends = [];
    const { post, url } = await limb(undefined, { onEnd: (e) => { ends.push(e); } });
    const a = await (await post({ text: 'hola' })).json();
    expect((await end(url(), a.session)).status).toBe(200);
    expect((await end(url(), a.session)).status).toBe(200);
    expect(ends.map((e) => e.ended)).toEqual([HTTP_STRINGS.ended]);
  });

  it('an unknown session is 404 and onEnd is not called', async () => {
    const ends = [];
    const { url } = await limb(undefined, { onEnd: (e) => { ends.push(e); } });
    expect((await end(url(), 'no-such-token')).status).toBe(404);
    expect((await end(url(), undefined)).status).toBe(404);
    expect(ends).toEqual([]);
  });

  it('the client\'s origins hold: a listed origin gets CORS (preflight too), an unlisted one is refused', async () => {
    const ends = [];
    const { post, url } = await limb({ acme: { being: 'ed', allowed_origins: ['https://www.acme.test'] } }, { onEnd: (e) => { ends.push(e); } });
    const a = await (await post({ text: 'hola' })).json();
    expect((await end(url(), a.session, { Origin: 'https://evil.test' })).status).toBe(403);
    expect(ends).toEqual([]);
    const pre = await fetch(`${url()}end`, { method: 'OPTIONS', headers: { Origin: 'https://www.acme.test', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    const ok = await end(url(), a.session, { Origin: 'https://www.acme.test' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://www.acme.test');
    expect(ends).toHaveLength(1);
  });

  it('a failing onEnd: 500, the history kept', async () => {
    const { post, url, lines } = await limb(undefined, { onEnd: () => { throw new Error('boom'); } });
    const a = await (await post({ text: 'hola' })).json();
    expect((await end(url(), a.session)).status).toBe(500);
    expect((await history(url(), a.session)).map((m) => m.text)).toEqual(['hola']);
    expect(lines.some((l) => /^end acme-[0-9a-f]{16}: boom$/.test(l))).toBe(true);
  });

  it('a reply still streaming when the visitor ends stays out of the fresh panel', async () => {
    const { b, post, url, got } = await limb(undefined, { onEnd: () => {} });
    const a = await (await post({ text: 'hola' })).json();
    const h = b.startStreamMessage('…', { chatId: got[0].from.chatId });
    h.update('a medias');
    expect((await end(url(), a.session)).status).toBe(200);
    h.update('a medias, y más');
    await h.finish('respuesta vieja');
    expect(await history(url(), a.session)).toEqual([]);
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

  it('widget.js is a Deep Chat loader: the pinned bundle with its integrity, wired to messages and events', async () => {
    const { url } = await limb();
    const js = await (await fetch(`${url()}widget.js`)).text();
    expect(DEEP_CHAT.url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/deep-chat@\d+\.\d+\.\d+\/dist\/deepChat\.bundle\.js$/);
    expect(DEEP_CHAT.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(js).toContain(JSON.stringify(DEEP_CHAT));
    expect(js).toContain("createElement('deep-chat')");
    expect(js).toContain("base + 'messages?session='");
    expect(js).toContain("base + 'events?session='");
    expect(js).toContain("fetch(base + 'messages', { method: 'POST'");
    expect(js).toContain('"client":"acme"');
  });

  it('widget.js has the end button with its inline confirm, and ends through POST end then clears the panel', async () => {
    const { url } = await limb();
    const js = await (await fetch(`${url()}widget.js`)).text();
    expect(js).toContain('class="egc-end"');
    expect(js).toContain('class="egc-ask"');
    expect(js).not.toContain('confirm(');
    expect(js).toContain("fetch(base + 'end', { method: 'POST'");
    expect(js).toContain('JSON.stringify({ session: token, identity: identity })');
    expect(js).toContain('chat.clearMessages()');
    expect(js).toContain(`"end":${JSON.stringify(HTTP_STRINGS.end)}`);
  });

  it('widget.js shows ⏳ (Deep Chat\'s loading bubble) while a line is out, and retries a POST that got no answer or a 5xx, with the same id', async () => {
    const { url } = await limb();
    const js = await (await fetch(`${url()}widget.js`)).text();
    expect(js).toContain('chat.displayLoadingBubble = true');
    expect(js).toContain("loading: { message: { html: '⏳' } }");
    expect(js).toContain('var BACKOFF = [1000, 3000, 9000]');
    expect(js).toContain('JSON.stringify({ session: token, text: text, id: id, identity: identity })');
    expect(js).toContain('crypto.getRandomValues');
    expect(js).toMatch(/if \(\(status && status < 500\) \|\| n >= BACKOFF\.length\) return Promise\.reject\(status\)/);
  });

  it('an unknown client or path is 404', async () => {
    const { port, post } = await limb();
    expect((await post({ text: 'hola' }, {}, 'other')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
  });
});
