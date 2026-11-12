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

  it("init: prime delivers the same line as a wake (not backlog), addressed to the being, once per new session; a reload or another tab primes nothing; the prime is charged to the turn budget and no hook seats a topic", async () => {
    const { post, got, hooks, read } = await limb('required', {}, { init: 'prime', rate: { turns_per_identity_per_hour: 2 } });
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
    // the prime took one of the two turns of the hour; one line is left
    expect((await post({ session: i.session, text: 'hola', identity })).status).toBe(200);
    expect(got[1]).toMatchObject({ text: 'hola', from: { backlog: false } });
    expect((await post({ session: i.session, text: 'otra', identity })).status).toBe(429);
  });

  describe('the prime is kept warm: every init, unless the conversation was warmed within 4 minutes', () => {
    const MIN = 60_000;
    const rig = async (init, extra = {}, cfg = {}) => {
      let t = Date.now();
      const r = await limb('required', { now: () => t, ...extra }, { init, ...cfg });
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

    it('a prime counts in rate.turns_per_identity_per_hour: primes plus lines in an hour never exceed N; an over-budget prime is skipped, no error', async () => {
      const N = 3;
      const { post, end, got, identity, tick, init, lines } = await rig('prime', {}, { rate: { turns_per_identity_per_hour: N } });
      const a = await init();                                          // prime 1
      tick(5 * MIN);
      expect((await init(a.session)).status).toBe(200);                // prime 2
      tick(5 * MIN);
      expect((await post({ session: a.session, text: 'hola', identity })).status).toBe(200);   // line 3
      expect((await post({ session: a.session, text: 'otra', identity })).status).toBe(429);
      expect((await end({ session: a.session, identity })).status).toBe(200);   // its end-prime is over budget: skipped
      tick(5 * MIN);
      expect((await init(a.session)).status).toBe(200);                // skipped too
      expect(got.map((g) => g.from.prime)).toEqual([true, true, false]);
      expect(lines.filter((l) => /acme: a prime skipped — 3 already from one identity in 60 min/.test(l)).length).toBeGreaterThanOrEqual(1);
      tick(60 * MIN);                                                  // the hour passes: primes count again
      expect((await init(a.session)).status).toBe(200);
      expect(got.map((g) => g.from.prime)).toEqual([true, true, false, true]);
    });

    it('no identity budget configured: primes are not limited', async () => {
      const { got, tick, init } = await rig('prime');
      const a = await init();
      for (let i = 0; i < 20; i++) { tick(5 * MIN); await init(a.session); }
      expect(got).toHaveLength(21);
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
    for (const init of [true, 'prime']) {
      const { post, got } = await limb('required', {}, { init, places });
      await post({ kind: 'init', identity: tok(), place: 'espacio' });
      expect(got[0].text.startsWith('(opened the chatbox in espacio, signed in as {')).toBe(true);
    }
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
