// http-identity.test.mjs — a signed visitor identity on the chatbox limb (clients.<c>.identity): the
// host page signs {abrin, user_type, short_name, username, exp} with the client's key, the limb verifies
// it, binds the session to that user, and renders the team topic's title from it. The widget reads it
// from data-identity and sends it on every call.
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge, renderTopicTitle, HTTP_STRINGS } from '../src/bridges/http.mjs';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

const KEY = 'dummy-test-key-not-a-secret';
const HOUR = 3600;
// The host page's side, as the PHP snippet does it: base64url(JSON) "." base64url(HMAC-SHA256(key, that)).
const sign = (payload, key = KEY) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
};
const exp = (s = HOUR) => Math.floor(Date.now() / 1000) + s;
const JP = { abrin: 'IEV', user_type: 'P', short_name: 'Juan Pérez', username: 'jperez' };
const ML = { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' };
const tok = (who = JP, over = {}) => sign({ ...who, exp: exp(), ...over });

const live = [];
afterEach(async () => { while (live.length) await live.pop()(); });

async function limb(mode = 'required', extra = {}, client = {}) {
  const port = await freeSafeHttpPort();
  const got = [], lines = [], hooks = [];
  const b = await startHttpBridge({
    port, clients: { acme: { being: 'ed', identity: mode, ...client } }, identityKey: (c) => (c === 'acme' ? KEY : null),
    beforeLine: (a) => { hooks.push(a); }, onIncoming: (text, from) => got.push({ text, from }), onLog: (m) => lines.push(m), ...extra,
  });
  live.push(() => b.stop());
  const url = `http://127.0.0.1:${port}/chat/acme/`;
  const post = async (body) => {
    const r = await fetch(`${url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  const read = (session, identity, what = 'messages') => fetch(`${url}${what}?session=${encodeURIComponent(session)}${identity ? `&identity=${encodeURIComponent(identity)}` : ''}`);
  const end = (body) => fetch(`${url}end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { b, got, lines, hooks, url, post, read, end };
}

describe('clients.<c>.identity', () => {
  it('required: a POST with no identity is refused 401 with the Spanish line; nothing enters, no session', async () => {
    const { post, got, hooks } = await limb('required');
    const r = await post({ text: 'hola' });
    expect(r).toEqual({ status: 401, error: 'identity required', message: HTTP_STRINGS.identity });
    expect(HTTP_STRINGS.identity).toMatch(/sesión/);
    expect(got).toEqual([]);
    expect(hooks).toEqual([]);
  });

  it('optional: an unsigned visitor works as before, with no identity', async () => {
    const { post, got, hooks } = await limb('optional');
    const r = await post({ text: 'hola' });
    expect(r.status).toBe(200);
    expect(got).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ isNew: true, identity: null });
  });

  it('a bad signature, a tampered or expired token, a malformed or oversized one: 401, when optional too (never downgraded)', async () => {
    for (const mode of ['required', 'optional']) {
      const { post, got, lines } = await limb(mode);
      const good = tok();
      const [body, mac] = good.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JP, username: 'director', exp: exp() })).toString('base64url');
      const cases = {
        'identity invalid': [sign({ ...JP, exp: exp() }, 'another-dummy-key'), `${forged}.${mac}`, `${body}.`, 'abc', `${body}.${mac}x`,
          `${'A'.repeat(5000)}.${mac}`, sign({ ...JP, username: '', exp: exp() }), sign({ ...JP, exp: 'tomorrow' }), sign([1, 2])],
        'identity expired': [tok(JP, { exp: exp(-5) })],
      };
      for (const [error, tokens] of Object.entries(cases)) {
        for (const identity of tokens) expect(await post({ text: 'hola', identity }), identity.slice(0, 40)).toMatchObject({ status: 401, error, message: HTTP_STRINGS.identity });
      }
      expect(got).toEqual([]);
      expect(lines.join('\n')).not.toContain(body);
    }
  });

  it('a valid token: the line enters, beforeLine gets the verified fields (no exp, no token), and the token is never logged', async () => {
    const { post, got, hooks, lines } = await limb();
    const identity = tok({ ...JP, user_id: 4711, short_name: 'Juan\nPérez​' });
    const r = await post({ text: 'hola', identity });
    expect(r.status).toBe(200);
    expect(got).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ client: 'acme', isNew: true, identity: { abrin: 'IEV', user_type: 'P', short_name: 'Juan Pérez', username: 'jperez', user_id: '4711' } });
    expect(Object.keys(hooks[0].identity).sort()).toEqual(['abrin', 'short_name', 'user_id', 'user_type', 'username']);
    expect(lines.join('\n')).not.toContain(identity.split('.')[0]);
  });

  it('the session is bound to its identity: the same user continues (a fresh token too); another user, or none, gets a new session and chat', async () => {
    const { post, got, hooks } = await limb('optional');
    const a = await post({ text: 'uno', identity: tok() });
    const a2 = await post({ session: a.session, text: 'dos', identity: tok(JP, { exp: exp(2 * HOUR) }) });
    expect(a2.session).toBe(a.session);
    expect(got[1].from.chatId).toBe(got[0].from.chatId);
    expect(hooks[1]).toMatchObject({ isNew: false, identity: { username: 'jperez' } });

    const b = await post({ session: a.session, text: 'soy otra', identity: tok(ML) });
    expect(b.status).toBe(200);
    expect(b.session).not.toBe(a.session);
    expect(got[2].from.chatId).not.toBe(got[0].from.chatId);
    expect(hooks[2]).toMatchObject({ isNew: true, identity: { username: 'mlopez' } });

    const c = await post({ session: a.session, text: 'sin firma' });
    expect(c.session).not.toBe(a.session);
    expect(new Set(got.map((g) => g.from.chatId)).size).toBe(3);
    expect(hooks[3]).toMatchObject({ isNew: true, identity: null });
    // the first user's session is untouched and still theirs
    const a3 = await post({ session: a.session, text: 'sigo', identity: tok() });
    expect(a3.session).toBe(a.session);
    expect(got[4].from.chatId).toBe(got[0].from.chatId);
  });

  it("an unsigned session is not adopted by a signed user: that user's first line opens their own", async () => {
    const { post, got } = await limb('optional');
    const a = await post({ text: 'anónimo' });
    const b = await post({ session: a.session, text: 'ya entré', identity: tok() });
    expect(b.session).not.toBe(a.session);
    expect(got[1].from.chatId).not.toBe(got[0].from.chatId);
  });

  it("reads and the end call need the session's own identity", async () => {
    const { post, read, end } = await limb('optional');
    const a = await post({ text: 'hola', identity: tok() });
    expect((await read(a.session, tok())).status).toBe(200);
    expect((await (await read(a.session, tok())).json()).messages.map((m) => m.text)).toEqual(['hola']);
    expect((await read(a.session, tok(ML))).status).toBe(404);
    expect((await read(a.session)).status).toBe(404);
    expect((await read(a.session, tok(JP, { exp: exp(-5) }))).status).toBe(401);
    expect((await read(a.session, tok(ML), 'events')).status).toBe(404);
    expect((await end({ session: a.session, identity: tok(ML) })).status).toBe(404);
    expect((await end({ session: a.session })).status).toBe(404);
    expect((await end({ session: a.session, identity: tok() })).status).toBe(200);
    // an unsigned session reads as before, and not with an identity
    const u = await post({ text: 'anónimo' });
    expect((await read(u.session)).status).toBe(200);
    expect((await read(u.session, tok())).status).toBe(404);
  });

  it('required: a read with no identity is 401', async () => {
    const { post, read, end } = await limb('required');
    const a = await post({ text: 'hola', identity: tok() });
    expect((await read(a.session)).status).toBe(401);
    expect((await read(a.session, undefined, 'events')).status).toBe(401);
    expect((await end({ session: a.session })).status).toBe(401);
  });

  it('no key file: a signed POST is 503 and logged; an unsigned one when optional still works', async () => {
    const { post, got, lines } = await limb('optional', { identityKey: () => null });
    expect(await post({ text: 'hola', identity: tok() })).toMatchObject({ status: 503, error: 'identity unavailable' });
    expect(lines.some((l) => /acme: .*no key/.test(l))).toBe(true);
    expect((await post({ text: 'hola' })).status).toBe(200);
    expect(got).toHaveLength(1);
  });

  it('the binding survives a restart, and the state file holds no name', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-identity-'));
    try {
      const one = await limb('required', { stateDir });
      const a = await one.post({ text: 'hola', identity: tok() });
      await one.b.stop();
      const saved = await readFile(join(stateDir, 'http-sessions.json'), 'utf8');
      expect(saved).not.toMatch(/jperez|IEV|Juan/);
      const two = await limb('required', { stateDir });
      expect((await two.post({ session: a.session, text: 'de vuelta', identity: tok() })).session).toBe(a.session);
      expect((await two.post({ session: a.session, text: 'soy otra', identity: tok(ML) })).session).not.toBe(a.session);
      expect(two.hooks.map((h) => h.isNew)).toEqual([false, true]);
      await two.b.stop();
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it('off (the default): the identity is not read, even a broken one', async () => {
    const { post, got, hooks } = await limb(null, { identityKey: () => { throw new Error('read'); } });
    expect((await post({ text: 'hola', identity: 'abc' })).status).toBe(200);
    expect(got).toHaveLength(1);
    expect(hooks[0].identity).toBeNull();
  });

  it('an unknown mode fails closed (required), and says so', async () => {
    const { post, lines } = await limb('requried');
    expect((await post({ text: 'hola' })).status).toBe(401);
    expect(lines.some((l) => /acme.*identity 'requried'.*required/.test(l))).toBe(true);
  });
});

describe('renderTopicTitle', () => {
  const sid = 'a1b2c3';
  it("the default reproduces today's title: <title> · <6 of sid>", () => {
    expect(renderTopicTitle(undefined, { title: 'EduWeb', sid })).toBe('EduWeb · a1b2c3');
  });

  it("EduWeb's template, filled from the identity", () => {
    expect(renderTopicTitle('{abrin} {user_type} {short_name} ({username})', { ...JP, title: 'Soporte', sid })).toBe('IEV P Juan Pérez (jperez)');
  });

  it('a placeholder with no value is empty, spaces collapse, empty brackets go; nothing left: the default', () => {
    expect(renderTopicTitle('{abrin} {user_type}  {short_name} ({username})', { abrin: 'IEV', username: 'jperez', title: 'Soporte', sid })).toBe('IEV (jperez)');
    expect(renderTopicTitle('{abrin} {user_type} {short_name} ({username})', { title: 'Soporte', sid })).toBe('Soporte · a1b2c3');
    expect(renderTopicTitle('{title} {sid} {nope}', { title: 'Soporte', sid })).toBe('Soporte a1b2c3 {nope}');
  });

  it("at most 128 (Telegram's limit), ending in …, never splitting a character", () => {
    const long = renderTopicTitle('{short_name} {username}', { short_name: 'N'.repeat(100), username: 'M'.repeat(100), sid });
    expect(long).toHaveLength(128);
    expect(long.endsWith('M…')).toBe(true);
    const emoji = renderTopicTitle('{short_name}', { short_name: '😀'.repeat(100), sid });
    expect(emoji.length).toBeLessThanOrEqual(128);
    expect(emoji).toBe(`${'😀'.repeat(63)}…`);
  });
});

// widget.js on a minimal fake page: just what the loader touches.
function page({ identity = null, stored = {} } = {}) {
  const storage = new Map(Object.entries(stored));
  const calls = [], sources = [], parts = new Map(), responses = [];
  let chat = null;
  const node = (extra = {}) => ({ hidden: false, textContent: '', setAttribute() {}, appendChild() {}, ...extra });
  const root = node({ querySelector: (sel) => parts.get(sel) ?? (parts.set(sel, node({ hidden: ['.egc-panel', '.egc-ask', '.egc-err'].includes(sel) })), parts.get(sel)) });
  const document = {
    currentScript: { src: 'https://x.test/chat/acme/widget.js', getAttribute: (n) => (n === 'data-identity' ? identity : null) },
    body: node(), head: node(),
    createElement: (tag) => {
      if (tag === 'div') return root;
      if (tag !== 'deep-chat') return node();
      const msgs = [];
      return (chat = { addMessage: (m) => msgs.push(m), getMessages: () => msgs, updateMessage() {}, focusInput() {}, scrollToBottom() {}, clearMessages() {} });
    },
    addEventListener() {},
  };
  const window = { customElements: { get: () => true }, EventSource: function (src) { sources.push(src); this.close = () => {}; } };
  const localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const fetch = async (href, init) => {
    calls.push({ href, init, body: init?.body ? JSON.parse(init.body) : null });
    const r = responses.shift() ?? { status: 200, json: { session: 'tok-1', message: { id: '1', seq: 1, text: 'hola' }, seq: 0, messages: [] } };
    return { ok: r.status < 300, status: r.status, json: async () => r.json };
  };
  return {
    storage, calls, sources, responses, chat: () => chat,
    run: (js) => new Function('document', 'window', 'localStorage', 'fetch', 'EventSource', js)(document, window, localStorage, fetch, window.EventSource),
    open: () => parts.get('.egc-bubble').onclick(),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('widget.js and the identity', () => {
  it('reads data-identity and sends it with each line, each read and the end; each user has their own stored session', async () => {
    const { url } = await limb();
    const js = await (await fetch(`${url}widget.js`)).text();
    const identity = tok();
    const p = page({ identity, stored: { 'egpt-chat:acme:IEV/jperez': 'tok-0', 'egpt-chat:acme': 'tok-anon' } });
    p.run(js);
    p.open();
    await flush();
    expect(p.calls[0].href).toBe(`https://x.test/chat/acme/messages?session=tok-0&identity=${encodeURIComponent(identity)}`);
    const signals = { newUserMessage: {}, onOpen() {}, onResponse: (r) => { signals.got = r; } };
    p.chat().connect.handler(null, signals);
    expect(p.sources.at(-1)).toContain(`&identity=${encodeURIComponent(identity)}`);
    p.chat().addMessage({ role: 'user', text: 'hola' });
    signals.newUserMessage.listener({ messages: [{ text: 'hola' }] });
    await flush();
    expect(p.calls[1].body).toMatchObject({ session: 'tok-0', text: 'hola', identity });
    expect(p.storage.get('egpt-chat:acme:IEV/jperez')).toBe('tok-1');   // the server's answer: switched to its session
    expect(p.storage.get('egpt-chat:acme')).toBe('tok-anon');

    p.responses.push({ status: 401, json: { error: 'identity expired' } });
    signals.newUserMessage.listener({ messages: [{ text: 'otra' }] });
    await flush();
    expect(signals.got).toEqual({ error: HTTP_STRINGS.identity });
  });

  it('a page with no data-identity sends none and keeps the shared slot', async () => {
    const { url } = await limb('optional');
    const js = await (await fetch(`${url}widget.js`)).text();
    const p = page({ stored: { 'egpt-chat:acme': 'tok-anon' } });
    p.run(js);
    p.open();
    await flush();
    expect(p.calls[0].href).toBe('https://x.test/chat/acme/messages?session=tok-anon');
  });
});
