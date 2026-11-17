// http-identity.test.mjs — a signed visitor identity on the chatbox limb (clients.<c>.identity): the
// host page signs {abrin, user_type, short_name, username, exp} with the client's key, the limb verifies
// it, binds the session to that user, and renders the team topic's title from it. The UI (the chatboxes-egpt widget) reads it
// from data-identity and sends it on every call.
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge, renderTopicTitle, renderChatLabel, verifyIdentity, HTTP_STRINGS } from '../src/bridges/http.mjs';
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

describe('the chat\'s title and subtitle, for /ayde\'s lists', () => {
  it('beforeLine gets a title and subtitle from the identity\'s claims: by default {abrin} · {short_name} · {username} and {user_type}; empty claims and their separators are left out', async () => {
    const { post, hooks } = await limb();
    await post({ text: 'hola', identity: tok(JP) });
    await post({ text: 'hola', identity: tok({ abrin: 'CSJ', username: 'ana', short_name: '', user_type: '' }) });
    expect(hooks[0]).toMatchObject({ title: 'IEV · Juan Pérez · jperez', subtitle: 'P' });
    expect(hooks[1]).toMatchObject({ title: 'CSJ · ana', subtitle: '' });
  });

  it('chat_title and chat_subtitle are templates like topic_title: any claim of the token; unsigned: neither', async () => {
    const { post, hooks } = await limb('optional', {}, { chat_title: '{school} · {short_name}', chat_subtitle: '{user_type} · {username}' });
    await post({ text: 'hola', identity: tok(JP, { school: 'Colegio Demo' }) });
    await post({ text: 'hola', identity: tok(ML) });   // no school claim: its separator goes with it
    await post({ text: 'hola' });
    expect(hooks[0]).toMatchObject({ title: 'Colegio Demo · Juan Pérez', subtitle: 'P · jperez' });
    expect(hooks[1]).toMatchObject({ title: 'María López', subtitle: 'R · mlopez' });
    expect(hooks[2].title).toBeUndefined();
    expect(hooks[2].subtitle).toBeUndefined();
  });

  it('the template renderer: claims in the same words as a topic\'s; a missing one is empty, dangling separators go, cut at 128; a blank config falls back to the default', async () => {
    expect(renderChatLabel('{school} · {short_name} · {username}', { short_name: 'Ana', username: 'ana1' })).toBe('Ana · ana1');
    expect(renderChatLabel('{school} · {short_name} · {username}', { school: 'S', short_name: '', username: 'ana1' })).toBe('S · ana1');
    expect(renderChatLabel('{short_name} ({school})', { short_name: 'Ana' })).toBe('Ana');
    expect(renderChatLabel('{school}', {})).toBe('');
    expect([...renderChatLabel('{short_name}', { short_name: 'x'.repeat(200) })].length).toBeLessThanOrEqual(80);
    const { post, hooks } = await limb('optional', {}, { chat_title: '  ', chat_subtitle: ['user_type'] });
    await post({ text: 'hola', identity: tok(JP) });
    expect(hooks[0]).toMatchObject({ title: 'IEV · Juan Pérez · jperez', subtitle: 'P' });
  });

  it('under conversation_by: identity the title is built once, with the conversation, for every tab and device', async () => {
    const { post, hooks } = await limb('optional', {}, { conversation_by: 'identity', chat_title: '{school} · {short_name}' });
    await post({ text: 'uno', identity: tok(JP, { school: 'Colegio Demo' }) });
    await post({ text: 'dos', identity: tok(JP, { school: 'Colegio Demo', exp: exp(2 * HOUR) }) });
    expect(hooks.map((h) => [h.isNew, h.title])).toEqual([[true, 'Colegio Demo · Juan Pérez'], [false, 'Colegio Demo · Juan Pérez']]);
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
    expect(got[0].from).toMatchObject({ backlog: true, network: 'http', senderName: 'visitor' });
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

  it('structured claims (an array of accounts): kept apart as identity.data, sanitized, and read by the being on the init line', async () => {
    const cuentas = [{ abrin: 'IEV', usuario: 'jperez', tipo: 'P' }, { abrin: 'IEV', usuario: ' jperezr\u0000 ', tipo: 'R', n: 3, x: { y: { z: { w: 'muy hondo' } } } }];
    const r = verifyIdentity(tok({ ...JP, cuentas }), KEY);
    expect(r.identity.claims).not.toHaveProperty('cuentas');
    expect(r.identity.data.cuentas).toEqual([{ abrin: 'IEV', usuario: 'jperez', tipo: 'P' }, { abrin: 'IEV', usuario: 'jperezr', tipo: 'R', n: 3, x: { y: {} } }]);
    expect(verifyIdentity(tok(JP), KEY).identity).not.toHaveProperty('data');
    const { post, got } = await limb('required', {}, { init: true });
    await post({ kind: 'init', identity: tok({ ...JP, cuentas: cuentas.slice(0, 1) }) });
    expect(got[0].text).toBe('(opened the chatbox, signed in as {"abrin":"IEV","user_type":"P","short_name":"Juan Pérez","username":"jperez","cuentas":[{"abrin":"IEV","usuario":"jperez","tipo":"P"}]})');
  });

  // init: prime — "opening the chatbox sends the opening": ONE message, the phrase the widget sends as prime_text, as the
  // visitor's first line through the normal line path. The limb holds no phrase of its own and sends no notice.
  describe("init: prime — the opening phrase is the visitor's first line, one turn", () => {
    const identity = tok({ ...JP, user_id: 4711 });
    const MIN = 60_000;
    const said = async (r, session) => (await (await r.read(session, identity)).json()).messages.map((m) => [m.from, m.text]);
    const rig = async (cfg = {}, extra = {}) => {
      let t = Date.now();
      const r = await limb('required', { now: () => t, ...extra }, { init: 'prime', ...cfg });
      return { ...r, tick: (ms) => { t += ms; } };
    };

    it('open with a phrase: exactly one being turn, whose text is the phrase, a visitor line recorded on the panel, counted once; no notice anywhere', async () => {
      const r = await rig({ rate: { messages: 2, turns_per_identity_per_hour: 2 } });
      const i = await r.post({ kind: 'init', identity, prime_text: 'revisa mis notas' });
      expect(i).toMatchObject({ status: 200, session: expect.any(String) });
      expect(r.got.map((g) => g.text)).toEqual(['revisa mis notas']);
      expect(r.got[0].from).toMatchObject({ backlog: false, replyToBot: true, replyToBeing: 'ed', network: 'http', senderName: 'visitor' });
      expect(await said(r, i.session)).toEqual([['visitor', 'revisa mis notas']]);
      expect(r.hooks).toHaveLength(1);
      expect(r.hooks[0]).toMatchObject({ isNew: true, init: false });
      expect(JSON.stringify([r.got, r.lines])).not.toMatch(/opened the chatbox|nothing to answer yet/);
      // counted once: one of the 2 session messages and one of the 2 turns of the hour; one line is left, then both gates close
      expect((await r.post({ session: i.session, text: 'hola', identity })).status).toBe(200);
      expect((await r.post({ session: i.session, text: 'otra', identity })).status).toBe(429);
    });

    it('open with an empty phrase (none, blank, not a string): no turn, no notice, no panel line; the session is made', async () => {
      for (const prime_text of [undefined, '', '   ', 42, null]) {
        const r = await rig();
        const i = await r.post({ kind: 'init', identity, ...(prime_text !== undefined ? { prime_text } : {}) });
        expect(i).toEqual({ status: 200, session: expect.any(String) });
        expect(r.got).toEqual([]);
        expect(r.hooks).toEqual([]);
        expect(await said(r, i.session)).toEqual([]);
        expect((await r.post({ session: i.session, text: 'hola', identity })).status).toBe(200);   // the first typed line is as ever
        expect(r.got.map((g) => g.text)).toEqual(['hola']);
      }
    });

    it("the limb holds no phrase: a prime_text in the client's block is ignored (the plugin's now) and named at start", async () => {
      const r = await rig({ prime_text: 'hola Edu, ponte al día' });
      const i = await r.post({ kind: 'init', identity });
      expect(r.got).toEqual([]);
      expect(await said(r, i.session)).toEqual([]);
      expect(r.lines.filter((l) => /acme: prime_text — the chatbox UI's now \(its skin, in a ui: folder\); ignored here/.test(l))).toHaveLength(1);
    });

    it('the line gates apply to the opening: 413 over max_chars (never truncated, no turn); 429 by the session rate; 429 by the identity budget', async () => {
      const a = await rig({ max_chars: 20 });
      expect((await a.post({ kind: 'init', identity, prime_text: 'x'.repeat(21) })).status).toBe(413);
      expect(a.got).toEqual([]);
      expect(a.hooks).toEqual([]);
      const b = await rig({ rate: { messages: 1 } });
      const i = await b.post({ kind: 'init', identity, prime_text: 'uno' });
      expect((await b.post({ session: i.session, text: 'dos', identity })).status).toBe(429);   // the opening was the one message
      const c = await rig({ rate: { messages: 1 } });
      const j = await c.post({ text: 'hola', identity });
      await c.end({ session: j.session, identity });               // a fresh thread, the session's window still spent
      const over = await c.post({ kind: 'init', session: j.session, identity, prime_text: 'otra' });
      expect(over).toMatchObject({ status: 429, retry_after_s: expect.any(Number) });
      expect(c.got.map((g) => g.text)).toEqual(['hola']);
      const d = await rig({ rate: { turns_per_identity_per_hour: 1 } });
      await d.post({ text: 'hola', identity });
      const full = await d.post({ kind: 'init', identity, prime_text: 'otra' });
      expect(full).toMatchObject({ status: 429, error: 'too many messages from this identity' });
      expect(d.got.map((g) => g.text)).toEqual(['hola']);
    });

    it('a reload or another tab: the opening is not resent into a conversation that already has lines — within the old 4 min gap or long after', async () => {
      const r = await rig();
      const a = await r.post({ kind: 'init', identity, prime_text: 'revisa mis notas' });
      r.tick(1 * MIN);
      await r.post({ kind: 'init', session: a.session, identity, prime_text: 'revisa mis notas' });
      r.tick(30 * MIN);
      await r.post({ kind: 'init', session: a.session, identity, prime_text: 'revisa mis notas' });
      expect(r.got.map((g) => g.text)).toEqual(['revisa mis notas']);
      expect(await said(r, a.session)).toEqual([['visitor', 'revisa mis notas']]);
    });

    it("conversation_by identity: a second device's init joins the conversation and does not resend the opening", async () => {
      const r = await rig({ conversation_by: 'identity' });
      await r.post({ kind: 'init', identity, prime_text: 'revisa mis notas' });
      const b = await r.post({ kind: 'init', identity, prime_text: 'revisa mis notas' });
      expect(b.status).toBe(200);
      expect(r.got.map((g) => g.text)).toEqual(['revisa mis notas']);
    });

    it('after an end: core replays nothing — not the page phrase, not a configured one; the next open (a fresh thread) sends the opening again', async () => {
      const r = await rig({ prime_text: 'de la config' });
      const a = await r.post({ kind: 'init', identity, prime_text: 'revisa mis notas' });
      await r.post({ session: a.session, text: 'hola', identity });
      expect((await r.end({ session: a.session, identity })).status).toBe(200);
      expect(r.got.map((g) => g.text)).toEqual(['revisa mis notas', 'hola']);
      expect(await said(r, a.session)).toEqual([]);
      await r.post({ kind: 'init', session: a.session, identity, prime_text: 'revisa mis notas' });
      expect(r.got.map((g) => g.text)).toEqual(['revisa mis notas', 'hola', 'revisa mis notas']);
    });

    it('end() delivers nothing after onEnd (no prime, no notice)', async () => {
      const order = [];
      const r = await rig({}, { onEnd: () => { order.push('end'); }, onIncoming: (x, f) => order.push('line') });
      const a = await r.post({ text: 'hola', identity });
      await r.end({ session: a.session, identity });
      expect(order).toEqual(['line', 'end']);
    });

    it('the opening counts in rate.turns_per_identity_per_hour like a line: N in an hour at most; over it the open is a 429, not a silent skip', async () => {
      const r = await rig({ rate: { turns_per_identity_per_hour: 2 } });
      const identity = tok({ ...JP, user_id: 4711 }, { exp: exp(86400) });   // outlives the hour
      await r.post({ kind: 'init', identity, prime_text: 'uno' });
      await r.post({ kind: 'init', identity, prime_text: 'dos' });   // a second session of the identity
      expect((await r.post({ kind: 'init', identity, prime_text: 'tres' })).status).toBe(429);
      expect(r.got.map((g) => g.text)).toEqual(['uno', 'dos']);
      r.tick(61 * MIN);
      expect((await r.post({ kind: 'init', identity, prime_text: 'cuatro' })).status).toBe(200);
    });

    it('init: true is as it was: one recorded line (never a phrase), a resumed session records nothing; no init: end() delivers nothing', async () => {
      const t = await limb('required', {}, { init: true });
      const i = await t.post({ kind: 'init', identity, prime_text: 'revisa' });
      await t.post({ kind: 'init', session: i.session, identity });
      expect(t.got).toHaveLength(1);
      expect(t.got[0].from.backlog).toBe(true);
      expect(t.got[0].text).toMatch(/^\(opened the chatbox, signed in as /);
      const off = await limb('required');
      const b = await off.post({ text: 'hola', identity });
      await off.end({ session: b.session, identity });
      expect(off.got).toHaveLength(1);
    });
  });

  it('init reaches the UI through info (prime and true as given, anything else false)', async () => {
    for (const init of [true, 'prime']) {
      const { url } = await limb('required', {}, { init });
      expect((await (await fetch(`${url}info`)).json()).init).toBe(init);
    }
    const { url } = await limb('required', {}, { init: 'other' });
    expect((await (await fetch(`${url}info`)).json()).init).toBe(false);
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
    const t = await limb('required', {}, { init: true, places });
    await t.post({ kind: 'init', identity: tok(), place: 'espacio' });
    expect(t.got[0].text.startsWith('(opened the chatbox in espacio, signed in as {')).toBe(true);
    const p = await limb('required', {}, { init: 'prime', places });   // the opening phrase is a line: its place prefixes the being's copy only
    await p.post({ kind: 'init', identity: tok(), place: 'espacio', prime_text: 'hola' });
    expect(p.got.map((g) => g.text)).toEqual(['(in espacio) hola']);
  });

  it('places: a list of names, or a map\'s keys (their css and user_strip are the skin\'s); a bad name is none', async () => {
    for (const given of [['espacio', 'Bad Name'], { espacio: { css: 'x' }, 'Bad Name': {} }]) {
      const { post, got, url } = await limb('required', {}, { places: given });
      await post({ text: 'hola', identity: tok(), place: 'espacio' });
      await post({ text: 'hola', identity: tok(), place: 'Bad Name' });
      expect(got.map((g) => g.text)).toEqual(['(in espacio) hola', 'hola']);
      expect((await (await fetch(`${url}info`)).json()).places).toEqual(['espacio']);   // the UI sends only these
    }
  });
});
