// closed-chats.test.mjs — config.yaml `closed_chats` (operator 2026-10-25): a closed chat is 'off' for
// every being (gating resolveMode's top rung), its message is said there once, and again to an
// addressed human line at most once a day. Removing the key reopens it on its conversations.yaml entry.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-closed-chats-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createRouter } from '../src/spine/router.mjs';
import { createGating, resolveMode } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { closedChat, createClosedChats } from '../src/spine/closed-chats.mjs';
import { getBeing } from '../src/conversations-state.mjs';
import { restartKeysChanged, isRestartKey } from '../src/spine/config-swap.mjs';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CLOSED = 'AbCdEfGhIjKlMnOpQrSt';
const OPEN = 'ZyXwVuTsRqPoNmLkJiHg';
const SIDE = 'SiDeGrOuPaLiAs000001';
const MSG = '📢 Este grupo se mudó a Telegram: https://t.me/+x. Aquí los agentes ya no responden.';
const AGENTS = {
  egpt: { configuration: 'egpt', handles: ['e', 'egpt'], voice_handles: ['ene'] },
  wren: { configuration: 'wren', handles: ['wren'] },
};
const SURFACES = ['whatsapp', 'telegram'];
const DAY = 24 * 3600_000;

const entries = () => ({
  [CLOSED]: { slug: 'si', agents: { egpt: { mode: 'on', threadId: 't1' }, wren: { mode: 'mention' } } },
  [OPEN]: { slug: 'other', agents: { egpt: { mode: 'on' } } },
  [SIDE]: { aliasOf: CLOSED, transcript: 'si-side' },
});

// Real router + gating + spine; `config.closed_chats` is edited in place to close/reopen.
function build(surface, { closed = { [CLOSED]: { message: MSG } } } = {}) {
  const state = { contacts: { [surface]: entries() } };
  const config = { agents: AGENTS, dispatch: { auto_default_mode: 'mention' }, closed_chats: { [surface]: closed } };
  let cb = null;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, emit(m) { return cb(m); }, stop() {} };
  const brain = { calls: [], async turn(being) { this.calls.push(being); return { text: 'ok', sessionId: 's', being }; } };
  const transcript = { entries: [], async log(ev, reply) { this.entries.push({ ev, reply }); } };
  const sender = { open() { return { update() {}, fail() {}, async finish() {} }; } };
  const reminded = [];
  const loadState = async () => state;
  const spine = createSpine({
    bridge, brain, sender, transcript,
    router: createRouter({ getAgents: () => AGENTS, getConfig: () => config, loadState }),
    gating: createGating({ getConfig: () => config, loadState }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    remindClosed: async (ev) => { reminded.push(ev.body); },
  });
  spine.start();
  const msg = (body, extra = {}) => ({ surface, chatId: CLOSED, chatName: 'SI+EduWeb', kind: 'text', raw: { chatType: 'group' }, senderId: '+1555', senderName: 'Ana', body, msgId: `m-${Math.random()}`, ts: 1, mention: {}, ...extra });
  const inbound = () => transcript.entries.filter((e) => e.reply == null).map((e) => e.ev.body);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { state, config, bridge, brain, inbound, settle, msg, reminded };
}

for (const surface of SURFACES) {
  describe(`closed chat on ${surface} — no being answers`, () => {
    // contract 6.2
    it('REPRODUCE-FIRST: no being runs — not by mode on, a handle, a reply to a being or a voice handle; nothing recorded', async () => {
      const t = build(surface);
      await t.bridge.emit(t.msg('buenas'));
      await t.bridge.emit(t.msg('@e hola'));
      await t.bridge.emit(t.msg('wren hola'));
      await t.bridge.emit(t.msg('si', { replyToBeing: 'egpt', mention: { replyToBot: true } }));
      await t.bridge.emit(t.msg('(voice transcription, 3s) ene hola', { voiceLine: 'outcome', isVoice: true }));
      await t.settle();
      expect(t.brain.calls).toEqual([]);
      expect(t.inbound()).toEqual([]);
    });

    it('LOCK: a chat not in closed_chats is unaffected', async () => {
      const t = build(surface);
      await t.bridge.emit(t.msg('buenas', { chatId: OPEN }));
      await t.settle();
      expect(t.brain.calls).toEqual(['egpt']);
    });

    it('closed with no message: silent, still no being', async () => {
      const t = build(surface, { closed: { [CLOSED]: {} } });
      await t.bridge.emit(t.msg('@e hola'));
      await t.settle();
      expect(t.brain.calls).toEqual([]);
    });

    it('removing the key reopens the chat on its conversations.yaml settings, untouched by closing', async () => {
      const t = build(surface);
      const before = structuredClone(t.state);
      await t.bridge.emit(t.msg('buenas'));
      await t.settle();
      expect(t.brain.calls).toEqual([]);
      delete t.config.closed_chats;
      await t.bridge.emit(t.msg('buenas'));
      await t.bridge.emit(t.msg('@wren hola'));
      await t.settle();
      expect(t.brain.calls.sort()).toEqual(['egpt', 'egpt', 'wren']);
      expect(t.state).toEqual(before);
    });

    it('the spine asks for the reminder on an addressed human line only', async () => {
      const t = build(surface);
      await t.bridge.emit(t.msg('buenas'));
      await t.bridge.emit(t.msg('@e hola'));
      await t.bridge.emit(t.msg('si', { replyToBeing: 'egpt', mention: { replyToBot: true } }));
      await t.bridge.emit(t.msg('@e eco', { fromNode: 'do' }));
      await t.settle();
      expect(t.reminded).toEqual(['@e hola', 'si']);
    });
  });
}

describe('the closed rung (gating resolveMode) — by the chat\'s own id', () => {
  const state = { contacts: { whatsapp: entries() } };
  const config = { closed_chats: { whatsapp: { [CLOSED]: { message: MSG } } } };

  // contract 6.2
  it('beats the conversation\'s own mode; other chats keep theirs', () => {
    expect(resolveMode(getBeing(state, 'whatsapp', CLOSED, 'egpt'), 'egpt', config)).toEqual({ mode: 'off', source: 'closed' });
    expect(resolveMode(getBeing(state, 'whatsapp', OPEN, 'egpt'), 'egpt', config)).toEqual({ mode: 'on', source: 'conversation' });
    expect(resolveMode(getBeing(state, 'whatsapp', CLOSED, 'egpt'), 'egpt', {})).toEqual({ mode: 'on', source: 'conversation' });
  });

  it('an alias side group is closed by its own id, not by its origin\'s', () => {
    expect(resolveMode(getBeing(state, 'whatsapp', SIDE, 'egpt'), 'egpt', config).mode).toBe('on');
    const sideClosed = { closed_chats: { whatsapp: { [SIDE]: null } } };
    expect(resolveMode(getBeing(state, 'whatsapp', SIDE, 'egpt'), 'egpt', sideClosed).mode).toBe('off');
    expect(resolveMode(getBeing(state, 'whatsapp', CLOSED, 'egpt'), 'egpt', sideClosed).mode).toBe('on');
  });

  it('closedChat: the entry, {} for a bare key, null when open or on another surface', () => {
    expect(closedChat(config, 'whatsapp', CLOSED)).toEqual({ message: MSG });
    expect(closedChat({ closed_chats: { whatsapp: { [CLOSED]: null } } }, 'whatsapp', CLOSED)).toEqual({});
    expect(closedChat(config, 'whatsapp', OPEN)).toBeNull();
    expect(closedChat(config, 'telegram', CLOSED)).toBeNull();
    expect(closedChat({}, 'whatsapp', CLOSED)).toBeNull();
  });

  it('closed_chats applies live: not a restart key', () => {
    expect(isRestartKey('closed_chats')).toBe(false);
    expect(restartKeysChanged({ node_name: 'kg' }, { node_name: 'kg', closed_chats: config.closed_chats })).toEqual([]);
  });
});

// The notice + the reminder over an in-memory conversations.yaml.
function notices(surface, { message = MSG, clock = { t: Date.UTC(2026, 9, 25, 12) }, state = null, sayOk = true } = {}) {
  const box = { state: state ?? { contacts: { [surface]: entries() } } };
  const config = { closed_chats: { [surface]: { [CLOSED]: message == null ? {} : { message } } } };
  const said = [];
  const logs = [];
  const make = () => createClosedChats({
    getConfig: () => config,
    loadState: async () => box.state,
    writeState: async (s) => { box.state = s; },
    say: async (chatId, text) => { said.push({ chatId, text }); return sayOk; },
    now: () => clock.t,
    onLog: (m) => logs.push(m),
  });
  return { box, config, said, logs, clock, make };
}

for (const surface of SURFACES) {
  describe(`closed chat on ${surface} — the notice, once`, () => {
    it('posts once; not again on a config reload or after a restart; again when the message changes', async () => {
      const n = notices(surface);
      const live = n.make();
      await live.announce();
      expect(n.said).toEqual([{ chatId: CLOSED, text: MSG }]);
      await live.announce();                                  // config reload
      await n.make().announce();                              // restart: a fresh instance over the same file
      expect(n.said).toHaveLength(1);
      n.config.closed_chats[surface][CLOSED].message = '📢 nuevo enlace';
      await live.announce();
      expect(n.said.map((s) => s.text)).toEqual([MSG, '📢 nuevo enlace']);
      await n.make().announce();
      expect(n.said).toHaveLength(2);
    });

    it('never posts when no message is set', async () => {
      const n = notices(surface, { message: null });
      await n.make().announce();
      n.config.closed_chats[surface][CLOSED] = { message: '  ' };
      await n.make().announce();
      expect(n.said).toEqual([]);
    });

    it('the marker lands in that chat\'s own entry; nothing else in it changes', async () => {
      const n = notices(surface);
      const before = structuredClone(n.box.state);
      await n.make().announce();
      const entry = n.box.state.contacts[surface][CLOSED];
      expect(entry.closed).toEqual({ notice: expect.stringMatching(/^[0-9a-f]{16}$/), at: '2026-10-25T12:00:00.000Z' });
      const { closed: _m, ...rest } = entry;
      expect(rest).toEqual(before.contacts[surface][CLOSED]);
      expect(n.box.state.contacts[surface][OPEN]).toEqual(before.contacts[surface][OPEN]);
    });

    it('an alias side group keeps its own marker', async () => {
      const n = notices(surface);
      n.config.closed_chats[surface][SIDE] = { message: MSG };
      await n.make().announce();
      expect(n.said.map((s) => s.chatId)).toEqual([CLOSED, SIDE]);
      expect(n.box.state.contacts[surface][SIDE]).toMatchObject({ aliasOf: CLOSED, closed: { at: expect.any(String) } });
    });

    it('not delivered → no marker, so the next boot or reload tries again; a chat not in conversations.yaml is skipped', async () => {
      const n = notices(surface, { sayOk: false });
      await n.make().announce();
      expect(n.box.state.contacts[surface][CLOSED].closed).toBeUndefined();
      const m = notices(surface, { state: { contacts: {} } });
      await m.make().announce();
      expect(m.said).toEqual([]);
      expect(m.logs.some((l) => l.includes('not in conversations.yaml'))).toBe(true);
    });
  });

  describe(`closed chat on ${surface} — the reminder, at most once a day`, () => {
    it('an addressed line gets the message; a second within 24 h nothing; after 24 h again', async () => {
      const n = notices(surface);
      const c = n.make();
      const ev = { surface, chatId: CLOSED, body: '@e hola' };
      await c.remind(ev);
      await c.remind(ev);
      expect(n.said).toEqual([{ chatId: CLOSED, text: MSG }]);
      n.clock.t += DAY - 1;
      await n.make().remind(ev);
      expect(n.said).toHaveLength(1);
      n.clock.t += 2;
      await n.make().remind(ev);
      expect(n.said).toHaveLength(2);
    });

    it('the notice counts as the day\'s post; concurrent lines post once', async () => {
      const n = notices(surface);
      const c = n.make();
      await c.announce();
      await c.remind({ surface, chatId: CLOSED });
      expect(n.said).toHaveLength(1);
      n.clock.t += DAY;
      await Promise.all([c.remind({ surface, chatId: CLOSED }), c.remind({ surface, chatId: CLOSED })]);
      expect(n.said).toHaveLength(2);
    });

    it('nothing without a message, nothing in an open chat', async () => {
      const n = notices(surface, { message: null });
      await n.make().remind({ surface, chatId: CLOSED });
      await n.make().remind({ surface, chatId: OPEN });
      expect(n.said).toEqual([]);
    });
  });
}

// ── boot: the real wiring (config-without-restart's harness) ─────────────────────────────────────
const CHAT = '!room:beeper.com';
const BASE = () => ({
  node_name: 'kg',
  user_name: 'John',
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: { egpt: { configuration: { type: 'ccode', model: 'haiku' }, handles: ['e'], name: 'E' } },
  closed_chats: { whatsapp: { [CHAT]: { message: MSG } } },
});

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

function node() {
  const clock = { t: Date.UTC(2026, 9, 25, 12) };
  let config = BASE();
  let hash = 'h0';
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'SI+EduWeb', slugHint: 'si' });
  ens.state.contacts.whatsapp[CHAT].agents = { egpt: { mode: 'on' } };
  const box = { state: ens.state };
  const sent = [];
  const made = [];
  const start = async (opts) => ({
    async send(text, o) { sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
    async resolveChatId() { return null; },
    startStreamMessage(init, o) { return { init, chatId: o?.chatId, update() {}, async finish() {} }; },
    isAlive: () => true, stop() {}, onIncoming: opts.onIncoming, opts,
  });
  const bootOnce = async () => {
    const built = [];
    const app = await boot({
      readConfig: () => structuredClone(config),
      readConfigHash: () => hash,
      startBridge: async (opts) => { const b = await start(opts); built.push(opts); return b; },
      makeSession: (opts) => { const s = { opts, turns: [], background: 0, sessionId: 's', async turn(m) { this.turns.push(m); return { text: 'ok', sessionId: 's' }; }, close() {} }; made.push(s); return s; },
      probeEndpoint: async () => ({ ok: false, status: 0 }),
      loadState: async () => box.state,
      writeState: async (s) => { box.state = s; },
      io: memIo(), ingest: false, tickMs: 0,
      exit: () => {},
      now: () => clock.t,
      log: { line: () => {} },
    });
    const say = (body, msgKey) => built[0].onIncoming(body, { chatId: CHAT, chatName: 'SI+EduWeb', network: 'whatsapp', userId: 'u-1', senderName: 'Ana', authorized: true, msgKey });
    return { app, say };
  };
  const save = (edit) => { config = edit(structuredClone(config)); hash = `h${Number(hash.slice(1)) + 1}`; };
  const posts = () => sent.filter((s) => s.chatId === CHAT).map((s) => s.text);
  return { clock, box, sent, made, bootOnce, save, posts };
}

describe('boot — closed_chats wired', () => {
  it('the notice posts at boot, not again on a reload or a reboot, again when the message changes; no being runs', async () => {
    const n = node();
    const a = await n.bootOnce();
    await vi.waitFor(() => expect(n.posts()).toHaveLength(1));
    expect(n.posts()[0]).toContain(MSG);
    await a.say('@e hola', 'm1');
    await new Promise((r) => setTimeout(r, 50));
    expect(n.made).toHaveLength(0);
    expect(n.posts()).toHaveLength(1);                     // the notice was today's post

    n.save((c) => ({ ...c, liveness: { every_ms: 60_000 } }));
    a.app.spine.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(n.posts()).toHaveLength(1);

    n.save((c) => { c.closed_chats.whatsapp[CHAT].message = '📢 nuevo enlace'; return c; });
    a.app.spine.tick();
    await vi.waitFor(() => expect(n.posts()).toHaveLength(2));
    expect(n.posts()[1]).toContain('📢 nuevo enlace');
    a.app.stop();

    const b = await n.bootOnce();
    await new Promise((r) => setTimeout(r, 50));
    expect(n.posts()).toHaveLength(2);
    b.app.stop();
  });

  it('the reminder: an addressed line a day later gets the message once; an unaddressed one nothing; reopening answers again', async () => {
    const n = node();
    const a = await n.bootOnce();
    await vi.waitFor(() => expect(n.posts()).toHaveLength(1));
    n.clock.t += DAY + 1;
    await a.say('buenas', 'm1');
    await new Promise((r) => setTimeout(r, 50));
    expect(n.posts()).toHaveLength(1);
    await a.say('@e hola', 'm2');
    await vi.waitFor(() => expect(n.posts()).toHaveLength(2));
    await a.say('@e otra vez', 'm3');
    await new Promise((r) => setTimeout(r, 50));
    expect(n.posts()).toHaveLength(2);
    expect(n.made).toHaveLength(0);

    n.save((c) => { delete c.closed_chats; return c; });
    a.app.spine.tick();
    await a.say('buenas', 'm4');
    await vi.waitFor(() => expect(n.made).toHaveLength(1));   // mode on, from its conversations.yaml entry
    a.app.stop();
  });
});
