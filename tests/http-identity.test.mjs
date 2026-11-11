// http-identity.test.mjs — a signed visitor identity on the chatbox limb (clients.<c>.identity): the
// host page signs {abrin, user_type, short_name, username, exp} with the client's key, the limb verifies
// it, binds the session to that user, and renders the team topic's title from it. The widget reads it
// from data-identity and sends it on every call.
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge, renderTopicTitle, verifyIdentity, HTTP_STRINGS } from '../src/bridges/http.mjs';
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

// Every `data:` event of an SSE response, as it arrives.
function sse(href) {
  const ac = new AbortController();
  const events = [];
  const done = (async () => {
    const res = await fetch(href, { signal: ac.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        buf = buf.slice(i + 2);
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch(() => {});
  const until = async (test) => { for (let t = 0; !test(events); t++) { if (t > 60) throw new Error(`SSE: saw ${JSON.stringify(events)}`); await new Promise((r) => setTimeout(r, 50)); } };
  return { events, until, close: () => { ac.abort(); return done; } };
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

  it('a valid token: the line enters, beforeLine gets the verified fields and every claim (no token), and the token is never logged', async () => {
    const { post, got, hooks, lines } = await limb();
    const identity = tok({ ...JP, user_id: 4711, short_name: 'Juan\nPérez​' });
    const r = await post({ text: 'hola', identity });
    expect(r.status).toBe(200);
    expect(got).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ client: 'acme', isNew: true, identity: { abrin: 'IEV', user_type: 'P', short_name: 'Juan Pérez', username: 'jperez', user_id: '4711' } });
    expect(Object.keys(hooks[0].identity).sort()).toEqual(['abrin', 'claims', 'short_name', 'user_id', 'user_type', 'username']);
    expect(hooks[0].identity.claims).toEqual({ ...JP, user_id: 4711, exp: expect.any(Number) });
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

describe('identity: { mode, required, key } — generic claims', () => {
  const custom = { mode: 'required', required: ['user_id'], key: ['user_id'] };

  it('custom required + key: a token with no abrin or username verifies, every claim reaches beforeLine, and the key binds the session', async () => {
    const { post, got, hooks } = await limb(custom);
    const e = exp();
    const ana = sign({ user_id: 7, org: 'Acme', staff: true, name: 'Ana\nRuiz', nested: { a: 1 }, list: [1], none: null, exp: e });
    const a = await post({ text: 'hola', identity: ana });
    expect(a.status).toBe(200);
    expect(hooks[0].identity.claims).toEqual({ user_id: 7, org: 'Acme', staff: true, name: 'Ana Ruiz', exp: e });
    const renamed = await post({ session: a.session, text: 'otra vez', identity: sign({ user_id: 7, name: 'Ana R.', exp: exp() }) });
    expect(renamed.session).toBe(a.session);
    const other = await post({ session: a.session, text: 'soy otro', identity: sign({ user_id: 8, exp: exp() }) });
    expect(other.session).not.toBe(a.session);
    expect(new Set(got.map((g) => g.from.chatId)).size).toBe(2);
  });

  it('a missing or empty required claim is refused 401, whatever else the token carries; a key claim is required too', async () => {
    const { post, got } = await limb({ mode: 'required', required: ['user_id', 'org'] });
    expect(await post({ text: 'hola', identity: tok({ ...JP, user_id: 4711 }) })).toMatchObject({ status: 401, error: 'identity invalid' });
    expect(await post({ text: 'hola', identity: tok({ ...JP, user_id: 4711, org: ' ' }) })).toMatchObject({ status: 401, error: 'identity invalid' });
    expect((await post({ text: 'hola', identity: tok({ ...JP, user_id: 4711, org: 'Acme' }) })).status).toBe(200);
    expect(got).toHaveLength(1);
    const keyed = await limb({ mode: 'required', required: [], key: ['user_id'] });
    expect(await keyed.post({ text: 'hola', identity: tok(JP) })).toMatchObject({ status: 401, error: 'identity invalid' });
    expect((await keyed.post({ text: 'hola', identity: sign({ user_id: 9, exp: exp() }) })).status).toBe(200);
  });

  it("the default verifies today's tokens exactly: the same fields, abrin + username required, the same session key on disk", async () => {
    const r = verifyIdentity(tok({ ...JP, user_id: 4711 }), KEY);
    expect(r.why).toBeUndefined();
    expect(r.identity).toMatchObject({ ...JP, user_id: '4711' });
    expect(verifyIdentity(sign({ user_id: 4711, username: 'jperez', exp: exp() }), KEY)).toEqual({ why: 'invalid' });
    expect(verifyIdentity(sign({ user_id: 4711, abrin: 'IEV', exp: exp() }), KEY)).toEqual({ why: 'invalid' });
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-identity-'));
    try {
      const one = await limb('required', { stateDir });
      const a = await one.post({ text: 'hola', identity: tok() });
      await one.b.stop();
      const saved = JSON.parse(await readFile(join(stateDir, 'http-sessions.json'), 'utf8'));
      const who = createHash('sha256').update(JSON.stringify(['IEV', 'jperez'])).digest('hex').slice(0, 16);
      expect(Object.values(saved)).toEqual([expect.objectContaining({ client: 'acme', who })]);
      expect(one.got[0].from.chatId).toBe(`http:acme-${createHash('sha256').update(a.session).digest('hex').slice(0, 16)}`);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});

describe('conversation_by', () => {
  it('identity: two sessions of one identity are one conversation — one chat id, one panel, and every open tab gets each reply', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-identity-'));
    try {
      const { b, post, got, hooks, url } = await limb('optional', { stateDir }, { conversation_by: 'identity' });
      const laptop = await post({ text: 'desde el portátil', identity: tok() });
      const phone = await post({ text: 'desde el móvil', identity: tok(JP, { exp: exp(2 * HOUR) }) });
      expect(phone.session).not.toBe(laptop.session);
      const chatId = got[0].from.chatId;
      expect(chatId).toMatch(/^http:acme-[0-9a-f]{16}$/);
      expect(got[1].from.chatId).toBe(chatId);
      expect(got[1].from.chatName).toBe(chatId.slice('http:'.length));
      expect(hooks.map((h) => h.isNew)).toEqual([true, false]);
      const tabs = [laptop, phone].map((s) => sse(`${url}events?session=${encodeURIComponent(s.session)}&identity=${encodeURIComponent(tok())}`));
      for (const t of tabs) await t.until((ev) => ev.length >= 2);
      await b.send('respuesta', { chatId });
      for (const t of tabs) await t.until((ev) => ev.some((m) => m.text === 'respuesta'));
      for (const t of tabs) await t.close();
      const panel = async (one) => (await (await fetch(`${url}messages?session=${encodeURIComponent(one.session)}&identity=${encodeURIComponent(tok())}`)).json()).messages.map((m) => m.text);
      expect(await panel(phone)).toEqual(['desde el portátil', 'desde el móvil', 'respuesta']);
      // another identity, and an unsigned visitor: their own conversations
      await post({ text: 'soy otra', identity: tok(ML) });
      await post({ text: 'anónimo' });
      await post({ text: 'anónimo 2' });
      expect(new Set(got.map((g) => g.from.chatId)).size).toBe(4);
      await b.stop();
      // after a restart both tokens still name that conversation, its history kept
      const two = await limb('optional', { stateDir }, { conversation_by: 'identity' });
      const again = await two.post({ session: phone.session, text: 'de vuelta', identity: tok() });
      expect(again.session).toBe(phone.session);
      expect(two.got[0].from.chatId).toBe(chatId);
      const after = await (await fetch(`${two.url}messages?session=${encodeURIComponent(laptop.session)}&identity=${encodeURIComponent(tok())}`)).json();
      expect(after.messages.map((m) => m.text)).toEqual(['desde el portátil', 'desde el móvil', 'respuesta', 'de vuelta']);
    } finally {
      while (live.length) await live.pop()();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('switched on over live sessions: a session keeps its token, and its next line starts the identity\'s conversation (isNew)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'egpt-http-identity-'));
    try {
      const one = await limb('required', { stateDir });
      const a = await one.post({ text: 'antes', identity: tok() });
      const b = await one.post({ text: 'antes también', identity: tok() });
      await one.b.stop();
      const two = await limb('required', { stateDir }, { conversation_by: 'identity' });
      expect((await two.post({ session: a.session, text: 'ahora', identity: tok() })).session).toBe(a.session);
      expect((await two.post({ session: b.session, text: 'ahora también', identity: tok() })).session).toBe(b.session);
      expect(two.got[0].from.chatId).not.toBe(one.got[0].from.chatId);
      expect(two.got[1].from.chatId).toBe(two.got[0].from.chatId);
      expect(two.hooks.map((h) => h.isNew)).toEqual([true, false]);
    } finally {
      while (live.length) await live.pop()();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('session (the default): two sessions of one identity are two conversations', async () => {
    const { post, got, hooks } = await limb('required');
    const a = await post({ text: 'uno', identity: tok() });
    const b = await post({ text: 'dos', identity: tok() });
    expect(b.session).not.toBe(a.session);
    expect(got[1].from.chatId).not.toBe(got[0].from.chatId);
    expect(hooks.map((h) => h.isNew)).toEqual([true, true]);
  });
});

describe('rate.turns_per_identity_per_hour', () => {
  it('past N lines from one identity in an hour, across its sessions: 429 with Retry-After; another identity is unaffected', async () => {
    const { post, got, lines } = await limb('required', {}, { rate: { turns_per_identity_per_hour: 2 } });
    const a = await post({ text: '1', identity: tok() });
    expect((await post({ text: '2', identity: tok() })).status).toBe(200);   // a second session
    const over = await post({ session: a.session, text: '3', identity: tok() });
    expect(over).toMatchObject({ status: 429, error: 'too many messages from this identity' });
    expect(over.retry_after_s).toBeGreaterThan(3500);
    expect((await post({ text: 'otra', identity: tok(ML) })).status).toBe(200);
    expect(got.map((g) => g.text)).toEqual(['1', '2', 'otra']);
    expect(lines.some((l) => /acme: a line refused — 2 already from one identity in 60 min/.test(l))).toBe(true);
  });

  it('the 429 carries Retry-After, as the other limits do; off by default', async () => {
    const { url } = await limb('required', {}, { rate: { turns_per_identity_per_hour: 1 } });
    const send = (body) => fetch(`${url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await send({ text: '1', identity: tok() })).status).toBe(200);
    const r = await send({ text: '2', identity: tok() });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    const off = await limb('required');
    for (let i = 0; i < 3; i++) expect((await off.post({ text: `${i}`, identity: tok() })).status).toBe(200);
  });
});

describe('init: the widget opened', () => {
  it('a session as for a line, one recorded line with the verified claims (backlog: never dispatched), nothing on the panel; a repeated init records nothing; a line after it dispatches', async () => {
    const { post, got, hooks, read } = await limb('required', {}, { init: true });
    const identity = tok({ ...JP, user_id: 4711 });
    const i = await post({ kind: 'init', identity });
    expect(i).toEqual({ status: 200, session: expect.any(String) });
    expect(got).toHaveLength(1);
    expect(got[0].from).toMatchObject({ backlog: true, prime: false, network: 'http', senderName: 'visitor' });
    expect(got[0].text).toBe('(opened the chatbox, signed in as {"abrin":"IEV","user_type":"P","short_name":"Juan Pérez","username":"jperez","user_id":4711})');
    expect(hooks[0]).toMatchObject({ isNew: true, init: true, identity: { username: 'jperez' } });
    expect((await (await read(i.session, identity)).json()).messages).toEqual([]);
    const again = await post({ kind: 'init', session: i.session, identity });
    expect(again.session).toBe(i.session);
    expect(got).toHaveLength(1);
    const line = await post({ session: i.session, text: 'hola', identity });
    expect(line.session).toBe(i.session);
    expect(got[1]).toMatchObject({ text: 'hola', from: { backlog: false, chatId: got[0].from.chatId } });
    expect(hooks.at(-1)).toMatchObject({ isNew: false, init: false });
  });

  it("init: prime delivers the same line as a wake (not backlog), addressed to the being, once per new session; a reload or another tab primes nothing; the turn budget is not charged and no hook seats a topic", async () => {
    const { post, got, hooks, read } = await limb('required', {}, { init: 'prime', rate: { turns_per_identity_per_hour: 1 } });
    const identity = tok({ ...JP, user_id: 4711 });
    const i = await post({ kind: 'init', identity });
    expect(i).toEqual({ status: 200, session: expect.any(String) });
    expect(got).toHaveLength(1);
    expect(got[0].from).toMatchObject({ backlog: false, replyToBot: true, replyToBeing: 'ed', network: 'http', senderName: 'visitor' });
    expect(got[0].text).toBe('(opened the chatbox, signed in as {"abrin":"IEV","user_type":"P","short_name":"Juan Pérez","username":"jperez","user_id":4711}; nothing to answer yet — answer … alone)');
    expect(got[0].from).toMatchObject({ prime: true });
    expect(hooks[0]).toMatchObject({ isNew: true, init: true });
    expect((await (await read(i.session, identity)).json()).messages).toEqual([]);
    expect((await post({ kind: 'init', session: i.session, identity })).session).toBe(i.session);   // a reload / another tab
    expect(got).toHaveLength(1);
    // the one turn of the hour is still the visitor's
    expect((await post({ session: i.session, text: 'hola', identity })).status).toBe(200);
    expect(got[1]).toMatchObject({ text: 'hola', from: { backlog: false } });
    expect((await post({ session: i.session, text: 'otra', identity })).status).toBe(429);
  });

  describe('the prime is kept warm: every init, unless the conversation was warmed within 4 minutes', () => {
    const MIN = 60_000;
    const rig = async (init, extra = {}) => {
      let t = Date.now();
      const r = await limb('required', { now: () => t, ...extra }, { init });
      const identity = tok(JP, { exp: exp(86400) });
      return { ...r, identity, tick: (ms) => { t += ms; }, init: (session) => r.post({ kind: 'init', session, identity }) };
    };

    it('a resumed init after the gap primes again (prime, not backlog); within the gap after a prime, after a visitor line, or from a second tab: none', async () => {
      const { post, got, hooks, identity, tick, init } = await rig('prime');
      const a = await init();
      expect(got).toHaveLength(1);
      tick(MIN);
      await init(a.session);   // within the gap after a prime
      expect(got).toHaveLength(1);
      tick(5 * MIN);
      await init(a.session);   // resumed, after the gap
      expect(got).toHaveLength(2);
      expect(got[1].from).toMatchObject({ prime: true, backlog: false });
      expect(got[1].text).toBe(got[0].text);
      expect(hooks[1]).toMatchObject({ isNew: false, init: true });
      tick(5 * MIN);
      await post({ session: a.session, text: 'hola', identity });
      expect(got).toHaveLength(3);
      tick(3 * MIN);
      await init(a.session);   // within the gap after a visitor line
      expect(got).toHaveLength(3);
      tick(2 * MIN);
      await Promise.all([init(a.session), init(a.session)]);   // two tabs back to back
      expect(got).toHaveLength(4);
    });

    it('end() primes right after onEnd, even within the gap; nothing said: no prime', async () => {
      const { post, end, got, identity, tick, init } = await rig('prime');
      const a = await init();
      expect((await end({ session: a.session, identity })).status).toBe(200);   // nothing said
      expect(got).toHaveLength(1);
      await post({ session: a.session, text: 'hola', identity });
      expect(got).toHaveLength(2);
      tick(MIN);
      expect((await end({ session: a.session, identity })).status).toBe(200);
      expect(got).toHaveLength(3);
      expect(got[2].from).toMatchObject({ prime: true, backlog: false });
      expect(got[2].text).toBe(got[0].text);
    });

    it('end() delivers the prime after onEnd has run', async () => {
      const order = [];
      const { post, end, identity } = await rig('prime', { onEnd: () => { order.push('end'); }, onIncoming: (x, f) => order.push(f.prime ? 'prime' : 'line') });
      const a = await post({ text: 'hola', identity });
      await end({ session: a.session, identity });
      expect(order).toEqual(['line', 'end', 'prime']);
    });

    it('init: true keeps today: a resumed init records nothing; no init: end() delivers nothing', async () => {
      const { got, tick, init } = await rig(true);
      const a = await init();
      tick(10 * MIN);
      await init(a.session);
      expect(got).toHaveLength(1);
      const off = await rig(undefined);
      const b = await off.post({ text: 'hola', identity: off.identity });
      await off.end({ session: b.session, identity: off.identity });
      expect(off.got).toHaveLength(1);
    });
  });

  it('init: prime reaches the widget as init (and true stays true)', async () => {
    for (const init of [true, 'prime']) {
      const { url } = await limb('required', {}, { init });
      expect(await (await fetch(`${url}widget.js`)).text()).toContain(`"init":${JSON.stringify(init)}`);
    }
    const { url } = await limb('required', {}, { init: 'other' });
    expect(await (await fetch(`${url}widget.js`)).text()).not.toContain('"init"');
  });

  it('under conversation_by: identity, a second device\'s init joins the conversation and records its arrival', async () => {
    const { post, got } = await limb('required', {}, { init: true, conversation_by: 'identity' });
    const a = await post({ kind: 'init', identity: tok() });
    const b = await post({ kind: 'init', identity: tok() });
    expect(b.session).not.toBe(a.session);
    expect(got.map((g) => g.from.chatId)).toEqual([got[0].from.chatId, got[0].from.chatId]);
  });

  it('init needs a verified identity; with init off (the default) a kind: init body is an ordinary POST, as today', async () => {
    const { post, got } = await limb('optional', {}, { init: true });
    expect(await post({ kind: 'init' })).toMatchObject({ status: 401, error: 'identity required' });
    expect(got).toEqual([]);
    const off = await limb('required');
    expect(await off.post({ kind: 'init', identity: tok() })).toMatchObject({ status: 400, error: 'empty message' });
    expect((await off.post({ kind: 'init', text: 'hola', identity: tok() })).status).toBe(200);
    expect(off.got[0].from.backlog).toBe(false);
  });
});

describe('renderTopicTitle', () => {
  const sid = 'a1b2c3';
  it("the default reproduces today's title: <title> · <6 of sid>", () => {
    expect(renderTopicTitle(undefined, { title: 'Contoso', sid })).toBe('Contoso · a1b2c3');
  });

  it("Contoso's template, filled from the identity", () => {
    expect(renderTopicTitle('{abrin} {user_type} {short_name} ({username})', { ...JP, title: 'Soporte', sid })).toBe('IEV P Juan Pérez (jperez)');
  });

  it('a placeholder with no value is empty, spaces collapse, empty brackets go; nothing left: the default', () => {
    expect(renderTopicTitle('{abrin} {user_type}  {short_name} ({username})', { abrin: 'IEV', username: 'jperez', title: 'Soporte', sid })).toBe('IEV (jperez)');
    expect(renderTopicTitle('{abrin} {user_type} {short_name} ({username})', { title: 'Soporte', sid })).toBe('Soporte · a1b2c3');
    expect(renderTopicTitle('{title} {sid} {nope}', { title: 'Soporte', sid })).toBe('Soporte a1b2c3 {nope}');
  });

  it('any claim of the identity is a placeholder', () => {
    expect(renderTopicTitle('{org} #{user_id} · {roleName}', { org: 'Acme', user_id: 7, roleName: 'admin', title: 'Soporte', sid })).toBe('Acme #7 · admin');
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
function page({ identity = null, stored = {}, place = null, vars = {} } = {}) {
  const styles = [];
  const storage = new Map(Object.entries(stored));
  const calls = [], sources = [], parts = new Map(), responses = [];
  let chat = null;
  const node = (extra = {}) => ({ hidden: false, textContent: '', setAttribute() {}, appendChild() {}, ...extra });
  const root = node({ querySelector: (sel) => parts.get(sel) ?? (parts.set(sel, node({ hidden: ['.egc-panel', '.egc-ask', '.egc-err', '.egc-user'].includes(sel) })), parts.get(sel)) });
  const document = {
    currentScript: { src: 'https://x.test/chat/acme/widget.js', getAttribute: (n) => (n === 'data-identity' ? identity : n === 'data-place' ? place : null) },
    body: node(), head: node({ appendChild: (s) => styles.push(s.textContent) }),
    createElement: (tag) => {
      if (tag === 'div') return root;
      if (tag === 'style') return node();
      if (tag !== 'deep-chat') return node();
      const msgs = [];
      return (chat = { addMessage: (m) => msgs.push(m), getMessages: () => msgs, updateMessage() {}, focusInput() {}, scrollToBottom() {}, clearMessages() {} });
    },
    addEventListener() {},
  };
  const window = { getComputedStyle: () => ({ getPropertyValue: (k) => vars[k] ?? '' }), customElements: { get: () => true }, EventSource: function (src) { sources.push(src); this.close = () => {}; } };
  const localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const fetch = async (href, init) => {
    calls.push({ href, init, body: init?.body ? JSON.parse(init.body) : null });
    const r = responses.shift() ?? { status: 200, json: { session: 'tok-1', message: { id: '1', seq: 1, text: 'hola' }, seq: 0, messages: [] } };
    return { ok: r.status < 300, status: r.status, json: async () => r.json };
  };
  return {
    storage, calls, sources, responses, styles, part: (sel) => parts.get(sel), chat: () => chat,
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

  it('init on: the page load sends one init (kind: init, its stored session, the identity) and keeps the answer\'s session', async () => {
    const { url } = await limb('required', {}, { init: true });
    const js = await (await fetch(`${url}widget.js`)).text();
    const identity = tok();
    const p = page({ identity, stored: { 'egpt-chat:acme:IEV/jperez': 'tok-0' } });
    p.responses.push({ status: 200, json: { session: 'tok-1' } });
    p.run(js);
    await flush();
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].href).toBe('https://x.test/chat/acme/messages');
    expect(p.calls[0].body).toEqual({ kind: 'init', session: 'tok-0', identity });
    expect(p.storage.get('egpt-chat:acme:IEV/jperez')).toBe('tok-1');
  });

  it('waiting: the loading bubble is ⏳ unless the client lists phrases; they rotate by CSS, one cell, escaped as text', async () => {
    const run = async (client) => {
      const { url } = await limb('required', {}, client);
      const js = await (await fetch(`${url}widget.js`)).text();
      const p = page({ identity: tok() });
      p.run(js);
      p.open();
      await flush();
      return { js, styles: p.chat().messageStyles };
    };
    const off = await run({});
    expect(off.js).toContain('"waiting":[]');
    expect(off.styles.loading).toEqual({ message: { html: '⏳' } });
    const on = await run({ strings: { waiting: ['Un momento…', '<img src=x onerror=alert(1)>', 'Ya casi', 7, ''] } });
    expect(on.js).toContain('"waiting":["Un momento…","<img src=x onerror=alert(1)>","Ya casi"]');
    const html = on.styles.loading.message.html;
    expect(html).toContain('@keyframes egc-w');
    expect(html.match(/<span style="grid-area/g)).toHaveLength(3);
    expect(html).toContain('animation:egc-w 7500ms linear 2500ms infinite');
    expect(html).toContain('Un momento…');
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect((await run({ strings: { waiting: ['Solo uno'] } })).styles.loading.message.html).toBe('Solo uno');
  });

  it('init off (the default), or no identity: nothing is sent on load', async () => {
    const off = await limb('required');
    const p = page({ identity: tok() });
    p.run(await (await fetch(`${off.url}widget.js`)).text());
    await flush();
    expect(p.calls).toEqual([]);
    const on = await limb('optional', {}, { init: true });
    const anon = page();
    anon.run(await (await fetch(`${on.url}widget.js`)).text());
    await flush();
    expect(anon.calls).toEqual([]);
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

describe('places: where the host page is', () => {
  const places = { espacio: { user_strip: true, css: '.egc{--egc-bg:#123}', ignored: 1 }, plain: {} };

  it('a configured place prefixes the being\'s line only: same chatId with and without it, the visitor\'s log unprefixed', async () => {
    const { post, got, read } = await limb('required', {}, { places });
    const identity = tok();
    const a = await post({ text: 'hola', identity, place: 'espacio' });
    expect(got[0].text).toBe('(in espacio) hola');
    const b = await post({ session: a.session, text: 'otra', identity });
    expect(got[1].text).toBe('otra');
    expect(got[1].from.chatId).toBe(got[0].from.chatId);
    expect(got[1].from.chatName).toBe(got[0].from.chatName);
    expect((await (await read(a.session, identity)).json()).messages.map((m) => m.text)).toEqual(['hola', 'otra']);
    expect(b.status).toBe(200);
  });

  it('an unknown, malformed or non-string place is no place; an unknown one is logged, never an error', async () => {
    const { post, got, lines } = await limb('required', {}, { places });
    const identity = tok();
    for (const place of ['nope', 'BAD NAME', 7, '__proto__', 'constructor']) {
      expect((await post({ text: 'hola', identity, place })).status).toBe(200);
      expect(got.at(-1).text).toBe('hola');
    }
    expect(lines.some((l) => l.includes("place 'nope'"))).toBe(true);
    const none = await limb('required', {}, {});
    await none.post({ text: 'hola', identity, place: 'espacio' });
    expect(none.got[0].text).toBe('hola');
  });

  it('init with a place names it', async () => {
    for (const init of [true, 'prime']) {
      const { post, got } = await limb('required', {}, { init, places });
      await post({ kind: 'init', identity: tok(), place: 'espacio' });
      expect(got[0].text.startsWith('(opened the chatbox in espacio, signed in as {')).toBe(true);
    }
  });

  it('clientConfig embeds user_strip and css only, caps css, and drops bad names', async () => {
    const { url } = await limb('required', {}, { places: { ...places, 'Bad Name': { css: 'x' }, big: { css: 'a'.repeat(30000) } } });
    const js = await (await fetch(`${url}widget.js`)).text();
    expect(js).toContain('"places":{"espacio":{"user_strip":true,"css":".egc{--egc-bg:#123}"},"plain":{"user_strip":false,"css":""},"big":{"user_strip":false,"css":"' + 'a'.repeat(20000) + '"}}');
    expect(js).not.toContain('Bad Name');
  });

  it('no places: the widget config is as before', async () => {
    const { url } = await limb('required');
    const js = await (await fetch(`${url}widget.js`)).text();
    expect(js).not.toContain('"places"');
    expect(js).toMatch(/\)\(\{"client":"acme","maxChars":4000,"strings":\{.*\},"deepChat":\{[^}]*\}\}\);\n$/s);
  });

  it('widget: data-place names a configured place: its css after the base, the strip with the user, the place sent with a line and init', async () => {
    const { url } = await limb('required', {}, { init: true, places });
    const js = await (await fetch(`${url}widget.js`)).text();
    const identity = tok();
    const p = page({ identity, place: 'espacio' });
    p.run(js);
    await flush();
    expect(p.calls[0].body).toEqual({ kind: 'init', session: null, identity, place: 'espacio' });
    p.open();
    await flush();
    expect(p.styles.at(-1)).toContain('.egc{--egc-bg:#123}');
    expect(p.styles[0].indexOf('.egc{--egc-bg:#123}')).toBeGreaterThan(p.styles[0].indexOf(':where('));
    expect(p.part('.egc-user').textContent).toBe('Juan Pérez');
    expect(p.part('.egc-user').hidden).toBe(false);
    const signals = { newUserMessage: {}, onOpen() {}, onResponse() {} };
    p.chat().connect.handler(null, signals);
    signals.newUserMessage.listener({ messages: [{ text: 'hola' }] });
    await flush();
    expect(p.calls.at(-1).body).toMatchObject({ text: 'hola', place: 'espacio' });
  });

  it('widget: unknown place or none: no css, no strip, no place sent', async () => {
    const { url } = await limb('required', {}, { places });
    const js = await (await fetch(`${url}widget.js`)).text();
    const p = page({ identity: tok(), place: 'nope' });
    p.run(js);
    p.open();
    await flush();
    expect(p.styles.join('')).not.toContain('--egc-bg:#123');
    expect(p.part('.egc-user')).toBeUndefined();   // never unhidden
    const signals = { newUserMessage: {}, onOpen() {}, onResponse() {} };
    p.chat().connect.handler(null, signals);
    signals.newUserMessage.listener({ messages: [{ text: 'hola' }] });
    await flush();
    expect(p.calls.at(-1).body).not.toHaveProperty('place');
  });

  it('widget: the strip falls back to username, and is empty with no identity', async () => {
    const { url } = await limb('optional', {}, { places });
    const js = await (await fetch(`${url}widget.js`)).text();
    const a = page({ identity: tok({ abrin: 'IEV', username: 'solo' }), place: 'espacio' });
    a.run(js);
    expect(a.part('.egc-user').textContent).toBe('solo');
    const b = page({ place: 'espacio' });
    b.run(js);
    expect(b.part('.egc-user')).toBeUndefined();
  });

  it('widget: look is overridable (:where, --egc-*, color-scheme), minimize and end are inline SVG, Deep Chat reads the variables', async () => {
    const { url } = await limb('required');
    const js = await (await fetch(`${url}widget.js`)).text();
    expect(js).toContain('color-scheme:light');
    expect(js).toContain(':where(.egc-panel)');
    expect(js).toContain('class="egc-x">\' + icon(');
    const p = page({ identity: tok() });
    p.run(js);
    p.open();
    await flush();
    expect(p.chat().chatStyle.backgroundColor).toBe('#f6f8fa');
    expect(p.chat().messageStyles.default.user.bubble).toMatchObject({ backgroundColor: '#1f6feb', color: '#fff' });
    expect(p.chat().avatars).toBeUndefined();
    const v = page({ identity: tok(), vars: { '--egc-bg': ' #D3DDE9 ', '--egc-user-bg': '#345D98', '--egc-avatar': 'url("https://x.test/a.png")' } });
    v.run(js);
    v.open();
    await flush();
    expect(v.chat().chatStyle.backgroundColor).toBe('#D3DDE9');
    expect(v.chat().messageStyles.default.user.bubble.backgroundColor).toBe('#345D98');
    expect(v.chat().avatars.ai.src).toBe('https://x.test/a.png');
    expect(v.chat().avatars.user.styles.container.display).toBe('none');
  });
});
