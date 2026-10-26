// stranger-dm-agent.test.mjs — dispatch.stranger_agent: a NEW 1:1 from a stranger, arriving on a
// named connection, is answered by that connection's agent (operator 2026-10-15, edw-marketer).
//
// The live shape: kg holds `primary` (An, the ear) and `secondary` (Rodz, a per-chat ear that wakes
// only where An is absent). A visitor from the EduWeb site DMs Rodz. Before this rule the DM fell to
// the persona in `accum`, which answers only when named, so "Hola" got nothing.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-stranger-dm-agent-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { strangerAgentFor } from '../src/spine/router.mjs';

let boot, emptyState, ensureContact, getContact, patchBeing;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact, getContact, patchBeing } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const PRIMARY = 'TOK-primary';
const SECONDARY = 'TOK-secondary';
const NAME_OF = { [PRIMARY]: 'primary', [SECONDARY]: 'secondary' };

const AN = '+16468217865';
const RODZ = '+13472576794';
const VISITOR = '+584141234567';
const FRIEND = '+15551230000';

const self = (id) => ({ id });
const member = (id, phoneNumber) => ({ id, phoneNumber });

const NEW_DM = '!visitor-dm-on-secondary';
const OLD_DM = '!older-dm-on-secondary';
const FRIEND_DM = '!friend-dm-on-secondary';
const GROUP = '!group-on-secondary';
const AN_DM = '!stranger-dm-on-primary';

const DESKTOPS = {
  [PRIMARY]: {
    [AN_DM]: [self('an@beeper.local'), member('v@beeper.local', VISITOR)],
  },
  [SECONDARY]: {
    [NEW_DM]: [self('rodz@dolly.local'), member('v@dolly.local', VISITOR)],
    [OLD_DM]: [self('rodz@dolly.local'), member('v@dolly.local', VISITOR)],
    [FRIEND_DM]: [self('rodz@dolly.local'), member('f@dolly.local', FRIEND)],
    [GROUP]: [self('rodz@dolly.local'), member('v@dolly.local', VISITOR), member('f@dolly.local', FRIEND)],
  },
};
const SELF_IDENTITY = { [PRIMARY]: [AN, '@anrodriguez:beeper.com'], [SECONDARY]: [RODZ, '@dolly-egpt:beeper.com'] };
const digits = (v) => String(v ?? '').replace(/\D/g, '');

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const token = opts.beeperToken;
    const world = DESKTOPS[token] ?? {};
    const spy = { connection: NAME_OF[token] ?? token, onIncoming: opts.onIncoming, sent: [], streams: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async editMessage() { return true; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async chatHasParticipant(chat, identity) {
        const roster = world[chat];
        if (!roster) return null;
        return roster.some((p) => (p.phoneNumber && digits(p.phoneNumber) === digits(identity)) || p.id === identity);
      },
      async selfIdentities() { return SELF_IDENTITY[token] ?? []; },
      async chatRaw(chat) { return world[chat] ? { id: chat, type: chat === GROUP ? 'group' : 'single', participants: { items: world[chat] } } : null; },
      async listChatsRaw() { return []; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`ok ${m}`); return { text: 'ok', sessionId: this.sessionId }; }, close() {} };
}

const MARKETER = () => ({
  configuration: 'egpt', personality: 'edw-marketer', handles: [], name: 'EduWeb', body_emoji: '🎓',
  conversation_defaults: { access_level: 'regular', sandboxed: false, allowed_users: ['*'] },   // it answers strangers
});

// kg: An's account is the ear, Rodz's a per-chat ear; the persona in accum, as live.
const KG = ({ rule = true } = {}) => ({
  node_name: 'kg',
  user_name: 'An',
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY },
    secondary: { account: 'dolly.egpt@example.com', token: SECONDARY },
  },
  networks: { whatsapp: { allowed_users: [AN, '@anrodriguez:beeper.com'] } },
  dispatch: { auto_default_mode: 'accum', ...(rule ? { stranger_agent: { secondary: 'edw-marketer' } } : {}) },
  agents: {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt', 'rodz'], name: 'E', body_emoji: '🐶', conversation_defaults: { allowed_users: ['*'] } },   // kg after 0050
    ken: { configuration: 'egpt', handles: ['k', 'ken'], name: 'K', body_emoji: '🤴', conversation_defaults: { allowed_users: [FRIEND] } },
    'edw-marketer': MARKETER(),
  },
});

// do: An's account claimed by do, Rodz's undeclared — so do ALSO hears a DM to Rodz. No rule.
const DO = () => ({
  node_name: 'do',
  user_name: 'An',
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY, owner_node: 'do' },
    secondary: { account: 'dolly.egpt@example.com', token: SECONDARY },
  },
  networks: { whatsapp: { allowed_users: [AN, '@anrodriguez:beeper.com'] } },
  dispatch: { auto_default_mode: 'mention' },
  agents: {
    don: { configuration: 'egpt', handles: ['d', 'don', 'rodz'], name: 'D', body_emoji: '🤝', mode: 'accum' },
  },
});

async function bootWith(config, { state: seedState } = {}) {
  const { start, built } = fakeTransport();
  let convState = seedState ?? emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: start,
    makeSession: fakeSession,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    now: () => Date.UTC(2026, 9, 15, 23, 0),
    log: { line: () => {} },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  const replies = () => built.flatMap((s) => [
    ...s.streams.map((h) => ({ connection: s.connection, chatId: h.chatId, text: h.finals[0] ?? '' })),
    ...s.sent.map((m) => ({ connection: s.connection, chatId: m.chatId, text: m.text })),
  ]);
  return { app, byConnection, replies, state: () => convState };
}

let seq = 0;
// atE is the BRIDGE's own persona-wake finding (its wake words are the persona's handles), stated here.
const deliver = (spy, chatId, body, { from = VISITOR, chatType = 'private', authorized = false, isSender = false, atE = false } = {}) => spy.onIncoming(body, {
  chatId, chatName: chatId.replace(/^!/, ''), chatType, network: 'whatsapp',
  userId: from, senderName: 'Visitor', authorized, isSender, msgKey: `m-${chatId}-${++seq}`,
  atEStart: atE, atEAnywhere: atE,
});

async function waitFor(check, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, stepMs)); }
  return check();
}
const quiet = (replies) => waitFor(() => replies().length > 0, { timeoutMs: 250 });

describe('a stranger\'s new 1:1 on the configured connection is answered by the stranger agent', () => {
  it('REPRODUCE: "Hola" in a new 1:1 to Rodz gets a reply, from edw-marketer, on secondary', async () => {
    const { app, byConnection, replies } = await bootWith(KG());
    await deliver(byConnection.secondary, NEW_DM, 'Hola');
    await waitFor(() => replies().length > 0);
    expect(replies().map(({ connection, chatId }) => ({ connection, chatId }))).toEqual([{ connection: 'secondary', chatId: NEW_DM }]);
    expect(replies()[0].text).toContain('🎓 EduWeb:');
    app.stop();
  });

  it('the conversation is seeded with the agent as its default, and the next line still reaches it', async () => {
    const { app, byConnection, replies, state } = await bootWith(KG());
    await deliver(byConnection.secondary, NEW_DM, 'Hola');
    await waitFor(() => replies().length > 0);
    expect(getContact(state(), 'whatsapp', NEW_DM)?.entry?.agents?.['edw-marketer']?.default).toBe(true);
    await deliver(byConnection.secondary, NEW_DM, '¿Qué es EduWeb?');
    await waitFor(() => replies().length > 1);
    expect(replies()).toHaveLength(2);
    expect(replies()[1].text).toContain('🎓 EduWeb:');
    app.stop();
  });

  it('naming another agent\'s handle does not reach it: "Rodz, hola" and "k hola" go to edw-marketer', async () => {
    const { app, byConnection, replies } = await bootWith(KG());
    await deliver(byConnection.secondary, NEW_DM, 'Rodz, hola', { atE: true });
    await waitFor(() => replies().length > 0);
    await deliver(byConnection.secondary, NEW_DM, 'k hola');
    await waitFor(() => replies().length > 1);
    await waitFor(() => replies().length > 2, { timeoutMs: 200 });
    expect(replies()).toHaveLength(2);
    for (const r of replies()) expect(r.text).toContain('🎓 EduWeb:');
    app.stop();
  });

  it('without the rule (today\'s config) the same "Hola" gets no reply — the persona is in accum', async () => {
    const { app, byConnection, replies, state } = await bootWith(KG({ rule: false }));
    await deliver(byConnection.secondary, NEW_DM, 'Hola');
    await quiet(replies);
    expect(replies()).toEqual([]);
    expect(getContact(state(), 'whatsapp', NEW_DM)?.entry).toBeTruthy();
    expect(getContact(state(), 'whatsapp', NEW_DM)?.entry?.agents).toBeUndefined();
    app.stop();
  });
});

describe('everything else is untouched', () => {
  it('an EXISTING conversation stays the persona\'s: "Hola" is silent, "e hola" reaches E', async () => {
    const seeded = ensureContact(emptyState(), 'whatsapp', OLD_DM, { pushedName: 'older-dm' }).state;
    const { app, byConnection, replies, state } = await bootWith(KG(), { state: seeded });
    await deliver(byConnection.secondary, OLD_DM, 'Hola');
    await quiet(replies);
    expect(replies()).toEqual([]);
    await deliver(byConnection.secondary, OLD_DM, 'e hola', { atE: true });
    await waitFor(() => replies().length > 0);
    expect(replies()[0].text).toContain('🐶 E:');
    expect(getContact(state(), 'whatsapp', OLD_DM)?.entry?.agents?.['edw-marketer']).toBeUndefined();
    app.stop();
  });

  it('a GROUP on secondary is not adopted', async () => {
    const { app, byConnection, replies, state } = await bootWith(KG());
    await deliver(byConnection.secondary, GROUP, 'Hola', { chatType: 'group' });
    await quiet(replies);
    expect(replies()).toEqual([]);
    expect(getContact(state(), 'whatsapp', GROUP)?.entry).toBeTruthy();
    expect(getContact(state(), 'whatsapp', GROUP)?.entry?.agents).toBeUndefined();
    app.stop();
  });

  it('a sender on an allowed_users list is not a stranger: no adoption, persona in accum', async () => {
    const { app, byConnection, replies, state } = await bootWith(KG());
    await deliver(byConnection.secondary, FRIEND_DM, 'Hola', { from: FRIEND });
    await quiet(replies);
    expect(replies()).toEqual([]);
    expect(getContact(state(), 'whatsapp', FRIEND_DM)?.entry).toBeTruthy();
    expect(getContact(state(), 'whatsapp', FRIEND_DM)?.entry?.agents).toBeUndefined();
    app.stop();
  });

  it('a stranger\'s new 1:1 on a connection the rule does not name (primary) is not adopted', async () => {
    const { app, byConnection, replies, state } = await bootWith(KG());
    await deliver(byConnection.primary, AN_DM, 'Hola');
    await quiet(replies);
    expect(replies()).toEqual([]);
    expect(getContact(state(), 'whatsapp', AN_DM)?.entry).toBeTruthy();
    expect(getContact(state(), 'whatsapp', AN_DM)?.entry?.agents).toBeUndefined();
    app.stop();
  });

  it('a conversation whose marked agent is gone from config falls back to the persona', async () => {
    let s = ensureContact(emptyState(), 'whatsapp', NEW_DM, { pushedName: 'visitor-dm' }).state;
    s = patchBeing(s, 'whatsapp', NEW_DM, 'edw-marketer', { default: true });
    const cfg = KG();
    delete cfg.agents['edw-marketer'];
    delete cfg.dispatch.stranger_agent;
    const { app, byConnection, replies } = await bootWith(cfg, { state: s });
    await deliver(byConnection.secondary, NEW_DM, 'Hola');
    await quiet(replies);
    expect(replies()).toEqual([]);
    app.stop();
  });
});

describe('node do does not answer these chats', () => {
  it('do (no rule): a stranger\'s "Hola" to Rodz gets no reply from do', async () => {
    const { app, byConnection, replies } = await bootWith(DO());
    await deliver(byConnection.secondary, NEW_DM, 'Hola');
    await quiet(replies);
    expect(replies()).toEqual([]);
    app.stop();
  });
});

describe('strangerAgentFor — the rule, pure', () => {
  const cfg = KG();
  const ev = (over = {}) => ({ connection: 'secondary', isSender: false, senderId: VISITOR, raw: { chatType: 'private' }, ...over });

  it('names the configured agent for a stranger\'s 1:1 on the configured connection', () => {
    expect(strangerAgentFor(ev(), cfg)).toBe('edw-marketer');
  });
  it('null for: another connection, a group, our own send, an allowed sender, no connection', () => {
    expect(strangerAgentFor(ev({ connection: 'primary' }), cfg)).toBeNull();
    expect(strangerAgentFor(ev({ raw: { chatType: 'group' } }), cfg)).toBeNull();
    expect(strangerAgentFor(ev({ isSender: true }), cfg)).toBeNull();
    expect(strangerAgentFor(ev({ senderId: AN }), cfg)).toBeNull();
    expect(strangerAgentFor(ev({ senderId: FRIEND }), cfg)).toBeNull();
    expect(strangerAgentFor(ev({ connection: null }), cfg)).toBeNull();
  });
  it('null when the named agent is not a local agent here', () => {
    expect(strangerAgentFor(ev(), { ...cfg, agents: { egpt: cfg.agents.egpt } })).toBeNull();
    expect(strangerAgentFor(ev(), { ...cfg, agents: { ...cfg.agents, 'edw-marketer': { relay_channel: 'x' } } })).toBeNull();
  });
  it('a "*" allowed_users entry names nobody — it does not make every sender known', () => {
    const star = { ...cfg, agents: { ...cfg.agents, ken: { ...cfg.agents.ken, conversation_defaults: { allowed_users: ['*'] } } } };
    expect(strangerAgentFor(ev(), star)).toBe('edw-marketer');
  });
});

describe('heartbeats are off in a conversation whose own agent says `heartbeats: false`', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function load({ off }) {
    const { createConfigResolver, readHeartbeatFiles } = await import('../src/spine/config-resolver.mjs');
    const { createHeartbeatLoader } = await import('../src/spine/heartbeat-loader.mjs');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'egpt-stranger-beats-'));
    const slug = 'visitor-2610152300';
    const dir = join(home, 'conversations', 'whatsapp', slug);
    mkdirSync(join(dir, 'heartbeats'), { recursive: true });
    writeFileSync(join(dir, 'heartbeats', 'escape.yaml'), 'frequency: 1m\ncommand: whoami\n');
    writeFileSync(join(dir, 'heartbeats', 'wake.yaml'), 'frequency: 1m\nagent: e\nprompt: hi\n');
    const config = { agents: { egpt: { handles: ['e'] }, 'edw-marketer': { ...MARKETER(), ...(off ? { heartbeats: false } : {}) } } };
    const registry = { contacts: { whatsapp: { [NEW_DM]: { slug, agents: { 'edw-marketer': { default: true } } } } } };
    const read = [];
    const resolver = createConfigResolver({
      getConfig: () => config, loadRegistry: async () => registry,
      listEntityDirs: async () => [{ dir, ns: `whatsapp/${slug}` }],
      readEntityBeats: (d, o) => { read.push(d); return readHeartbeatFiles(d, o); },
      egptHome: home, io: { writeFile: async () => {}, mkdir: async () => {} },
    });
    const fired = [];
    const registered = [];
    const loader = createHeartbeatLoader({
      resolver, aliveMs: 0, egptHome: home, platform: 'linux',
      spawn: () => { fired.push('spawn'); return { on() {}, stdout: { on() {}, setEncoding() {} } }; },
      spawnBoxed: async () => { fired.push('boxed'); return { on() {} }; },
      dispatchTurn: async () => { fired.push('turn'); return { text: 'ok' }; },
      io: { writeFile: async () => {}, mkdir: async () => {}, readFile: async () => '{}' },
    });
    loader.wrapRegistry({ register: (name, everyMs, fn) => registered.push({ name, fn }), clear: () => { registered.length = 0; }, runDue: () => {} });
    const { entries } = await loader.collect();
    await loader.activate({ stats: () => ({}) });
    for (const r of registered) r.fn();
    await flush();
    return { entries, registered, fired, read };
  }

  it('heartbeats/*.yaml in that conversation is never read, registered or fired', async () => {
    const { entries, registered, fired, read } = await load({ off: true });
    expect(read).toEqual([]);
    expect(entries).toEqual([]);
    expect(registered).toEqual([]);
    expect(fired).toEqual([]);
  });

  it('control: without the key the same files load and fire', async () => {
    const { entries, fired } = await load({ off: false });
    expect(entries.map((e) => e.shortName).sort()).toEqual(['escape', 'wake']);
    expect(fired.sort()).toEqual(['boxed', 'turn']);
  });
});
