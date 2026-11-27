// msg-action-boot.test.mjs — a being's "/<handle> msg <chat> <text>" as a REPLY ACTION through a whole boot. The model wrote
// it, so executing it ASKS: the prose is posted in the source chat, a question follows there (✋ being → chat: text), and
// nothing reaches the target until a node owner says yes (a reply to the question or a reaction on it). Yes sends the text
// exactly as written, recorded in the target's transcript as the being's line, its own-line /media files confined to the
// being's own folder; no drops it; the deadline expires it; config msg_approval: false sends at once. A being's node-signed
// "/<handle> msg" line asks the same way; the operator's own typed line still sends at once. Generic fixtures only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-msg-action-boot-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripNodeSignature } from '../src/node-signature.mjs';
import { reactionAction } from '../src/dispatch-line.mjs';

let boot, emptyState, ensureContact, slugDir;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact, slugDir } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_HOME, { recursive: true, force: true }); } catch {}
});
let envToken;
beforeEach(() => { envToken = process.env.BEEPER_ACCESS_TOKEN; delete process.env.BEEPER_ACCESS_TOKEN; });
afterEach(async () => {
  if (envToken !== undefined) process.env.BEEPER_ACCESS_TOKEN = envToken;
  await fs.rm(join(_HOME, 'state'), { recursive: true, force: true });
});

const ORIGIN = '!fam:beeper.com';        // where the being writes it: egpt answers here
const TARGET = '!contoso-hq';            // egpt answers here
const QUIET = '!quiet-room';             // egpt does not answer here
const FORK = '!side:beeper.com';         // a /split fork of ORIGIN: parent_chat + transcript + conversation_path, no slug of its own (as a topic's entry)
const AGENTS = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], name: 'E' }, other: { configuration: 'egpt', handles: ['o'], name: 'O' } };
const CONFIG = (extra = {}) => ({ node_name: 'kg', user_name: 'An', limbs: { beeper: { main: { account: 'you@example.com', token: 'TOK-b' } } }, agents: AGENTS, ...extra });

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
    copyFile: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); },
  };
}
function fakeTransport() {
  const built = [];
  let n = 0;
  const start = async (opts) => {
    const spy = { opts, sent: [], streams: [], media: [], edits: [] };
    built.push(spy);
    return {
      async editMessage(chatId, id, text) { spy.edits.push({ chatId, id, text }); return true; },
      async send(text, o) { const id = `m${++n}`; spy.sent.push({ text, chatId: o?.chatId, id }); return { ok: true, confirmedId: id }; },
      async sendMedia(chatId, path, o) { const id = `m${++n}`; spy.media.push({ chatId, path, caption: o?.caption ?? null, id }); return { ok: true, confirmedId: id }; },
      async sendReaction() { return true; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      wasSentByUs: (chatId, id) => spy.sent.some((m) => m.id === id) || spy.media.some((m) => m.id === id),
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

const T0 = Date.UTC(2026, 10, 27, 14, 5);
const MIN = 60_000;
let app = null;
afterEach(() => { try { app?.stop(); } catch {} app = null; });

const stateWithChats = () => {
  let st = emptyState();
  for (const [jid, name, being] of [[ORIGIN, 'fam', 'egpt'], [TARGET, 'Contoso HQ', 'egpt'], [QUIET, 'Quiet Room', 'other']]) {
    st = ensureContact(st, 'whatsapp', jid, { pushedName: name, slugHint: name.toLowerCase().replace(/\W+/g, '-') }).state;
    st.contacts.whatsapp[jid].agents = { [being]: { mode: 'on' } };
  }
  st.contacts.whatsapp[FORK] = { conversation_path: st.contacts.whatsapp[ORIGIN].conversation_path ?? `whatsapp/${st.contacts.whatsapp[ORIGIN].slug}`, pushedName: 'Side', parent_chat: ORIGIN, transcript: 'side', agents: { egpt: { mode: 'on' } } };
  return st;
};

// `reply`: what the being answers with, whatever it is asked.
// `bareFork`: every read of the state shows the fork's entry without a slug, as a live node's topic entries are (arrival would otherwise heal one in).
async function bootWith(config, { reply = '', io = memIo(), bareFork = false } = {}) {
  const beeper = fakeTransport();
  const lines = [];
  let clock = T0;
  let convState = stateWithChats();
  app = await boot({
    readConfig: () => config,
    startBridge: beeper.start,
    makeSession: (opts) => ({ sessionId: opts.sessionId ?? 'sess-1', async turn() { return { text: reply, sessionId: 'sess-1' }; }, close() {} }),
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => {
      const e = convState.contacts?.whatsapp?.[FORK];
      if (!bareFork || !e?.slug) return convState;
      const { slug, ...bare } = e;
      return { ...convState, contacts: { ...convState.contacts, whatsapp: { ...convState.contacts.whatsapp, [FORK]: bare } } };
    },
    writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0, exit: () => {},
    now: () => clock, log: { line: (s) => lines.push(s) },
  });
  const spy = beeper.built[0];
  let seq = 0;
  const human = (body, over = {}) => app.spine.handleInbound({ body, from: { chatId: ORIGIN, chatName: 'fam', network: 'whatsapp', userId: 'an', senderName: 'An', isSender: true, authorized: true, msgKey: `in${++seq}`, ...over } });
  // The owner's (or a stranger's) answer: a reply to the question post, or a reaction on it.
  const answer = (id, body, { owner = true } = {}) => human(body, { replyToId: id, ...(owner ? {} : { userId: 'pepe', senderName: 'Pepe', isSender: false, authorized: false }) });
  const react = (id, emoji, { owner = true } = {}) => app.spine.handleInbound({ body: reactionAction({ emoji, targetId: id, snippet: '✋' }), from: { chatId: ORIGIN, chatName: 'fam', network: 'whatsapp', userId: owner ? 'an' : 'pepe', senderName: owner ? 'An' : 'Pepe', isSender: false, authorized: owner, isReaction: true, msgKey: id } });
  const sentTo = (room) => spy.sent.filter((s) => s.chatId === room).map((s) => ({ ...s, text: stripNodeSignature(s.text) }));
  const finalsIn = (room) => spy.streams.filter((s) => s.chatId === room).flatMap((s) => s.finals).map((t) => stripNodeSignature(String(t)));
  const quiet = (room) => sentTo(room).length + spy.media.filter((m) => m.chatId === room).length + spy.streams.filter((s) => s.chatId === room).length;
  const question = () => sentTo(ORIGIN).find((s) => s.text.startsWith('✋'));
  const transcriptOf = (needle) => [...io.files].filter(([p]) => /transcript/.test(p) && p.includes(needle)).map(([, t]) => t).join('\n');
  const pulse = async () => { await app.asksIdle(); app.spine.tick(); await app.asksIdle(); };
  return { app, spy, lines, io, human, answer, react, sentTo, finalsIn, quiet, question, transcriptOf, pulse, advance: (ms) => { clock += ms; } };
}
const settle = async (t) => { await vi.waitFor(() => expect(t.question() ?? t.sentTo(ORIGIN).find((s) => /^\/msg:/.test(s.text))).toBeTruthy()); };
const DRAFT = 'Sure.\n/e msg "Contoso HQ" hola\nsegunda línea';

describe('a being\'s /msg action asks first', () => {
  it('REPRODUCE: the prose is posted in the source chat, the question follows there, the target hears nothing', async () => {
    const t = await bootWith(CONFIG(), { reply: DRAFT });
    await t.human('hello');
    await settle(t);
    expect(t.finalsIn(ORIGIN).join('\n')).toContain('Sure.');
    expect(t.finalsIn(ORIGIN).join('\n')).not.toContain('msg');            // the command is not posted as prose
    expect(t.question().text).toMatch(/^✋ E → Contoso HQ:\nhola\nsegunda línea\n\nsend it\? reply yes \/ no · ⏳ 10 min$/);
    expect(t.quiet(TARGET)).toBe(0);
  });

  it('an owner\'s "yes" reply: the text lands in the target exactly as written, recorded as the being\'s line, and the source is told', async () => {
    const t = await bootWith(CONFIG(), { reply: DRAFT });
    await t.human('hello'); await settle(t);
    await t.answer(t.question().id, 'yes');
    await vi.waitFor(() => expect(t.sentTo(TARGET)).toHaveLength(1));
    expect(t.spy.sent.find((s) => s.chatId === TARGET).text).toBe('hola\nsegunda línea');   // not even a signature
    expect(t.transcriptOf('Contoso HQ')).toContain('E@[Contoso HQ].wa');
    expect(t.transcriptOf('Contoso HQ')).toContain('hola\nsegunda línea');
    await vi.waitFor(() => expect(t.sentTo(ORIGIN).map((s) => s.text)).toContain('✅ sent to Contoso HQ'));
    // answered once: a second yes is ordinary chat
    await t.answer(t.question().id, 'yes');
    expect(t.sentTo(TARGET)).toHaveLength(1);
  });

  it('an owner\'s 👍 reaction on the question sends it; a 👎 drops it', async () => {
    const a = await bootWith(CONFIG(), { reply: DRAFT });
    await a.human('hello'); await settle(a);
    await a.react(a.question().id, '👍');
    await vi.waitFor(() => expect(a.sentTo(TARGET)).toHaveLength(1));
    a.app.stop();

    const b = await bootWith(CONFIG(), { reply: DRAFT });
    await b.human('hello'); await settle(b);
    await b.react(b.question().id, '👎');
    await vi.waitFor(() => expect(b.sentTo(ORIGIN).map((s) => s.text)).toContain('🚫 dropped'));
    expect(b.quiet(TARGET)).toBe(0);
  });

  it('"no" drops it: nothing in the target', async () => {
    const t = await bootWith(CONFIG(), { reply: DRAFT });
    await t.human('hello'); await settle(t);
    await t.answer(t.question().id, 'no');
    await vi.waitFor(() => expect(t.sentTo(ORIGIN).map((s) => s.text)).toContain('🚫 dropped'));
    expect(t.quiet(TARGET)).toBe(0);
    await t.answer(t.question().id, 'yes');       // too late: the question is gone
    expect(t.quiet(TARGET)).toBe(0);
  });

  it('a non-owner\'s yes does nothing', async () => {
    const t = await bootWith(CONFIG(), { reply: DRAFT });
    await t.human('hello'); await settle(t);
    await t.answer(t.question().id, 'yes', { owner: false });
    await t.react(t.question().id, '👍', { owner: false });
    expect(t.quiet(TARGET)).toBe(0);
    await t.answer(t.question().id, 'yes');       // the owner still can
    await vi.waitFor(() => expect(t.sentTo(TARGET)).toHaveLength(1));
  });

  it('unanswered it expires: the post says so, nothing is sent, and a late yes is ordinary chat', async () => {
    const t = await bootWith(CONFIG(), { reply: DRAFT });
    await t.human('hello'); await settle(t);
    const id = t.question().id;
    t.advance(10 * MIN); await t.pulse();
    expect(t.spy.edits.map((e) => stripNodeSignature(e.text)).at(-1)).toBe('⌛ E → Contoso HQ:\nhola\nsegunda línea\n\nexpired, not sent');
    expect(t.lines.some((l) => /\[ingest\] \/msg !fam:beeper\.com: expired .* egpt's message not sent$/.test(l))).toBe(true);
    await t.answer(id, 'yes');
    expect(t.quiet(TARGET)).toBe(0);
  });

  it('a long text is cut in the question, whole in the delivery', async () => {
    const long = 'palabra '.repeat(200).trim();
    const t = await bootWith(CONFIG(), { reply: `ok\n/e msg "Contoso HQ" ${long}` });
    await t.human('hello'); await settle(t);
    expect(t.question().text).toContain(`${'palabra '.repeat(75).slice(0, 600)}…`);
    expect(t.question().text.length).toBeLessThan(700);
    await t.answer(t.question().id, 'yes');
    await vi.waitFor(() => expect(t.sentTo(TARGET)).toHaveLength(1));
    expect(t.sentTo(TARGET)[0].text).toBe(long);
  });

  it('several msg lines are several questions, each its own', async () => {
    const t = await bootWith(CONFIG(), { reply: 'ok\n/e msg "Contoso HQ" uno\n/e msg "Quiet Room" dos' });
    await t.human('hello');
    await vi.waitFor(() => expect(t.sentTo(ORIGIN).filter((s) => s.text.startsWith('✋') || /^\/msg:/.test(s.text)).length).toBe(2));
    expect(t.sentTo(ORIGIN).some((s) => /^\/msg: e does not answer in Quiet Room|^\/msg: egpt does not answer in Quiet Room/.test(s.text))).toBe(true);
  });
});

describe('msg_approval and refusals', () => {
  it('msg_approval: false sends at once, no question', async () => {
    const t = await bootWith(CONFIG({ msg_approval: false }), { reply: DRAFT });
    await t.human('hello');
    await vi.waitFor(() => expect(t.sentTo(TARGET)).toHaveLength(1));
    expect(t.sentTo(TARGET)[0].text).toBe('hola\nsegunda línea');
    expect(t.question()).toBeUndefined();
    await vi.waitFor(() => expect(t.sentTo(ORIGIN).map((s) => s.text)).toContain('✅ sent to Contoso HQ'));
  });

  it('a chat the being does not answer in: a /msg: line in the source, recorded, no question, nothing sent', async () => {
    const t = await bootWith(CONFIG(), { reply: 'ok\n/e msg "Quiet Room" hola' });
    await t.human('hello'); await settle(t);
    expect(t.sentTo(ORIGIN).map((s) => s.text)).toContain('/msg: egpt does not answer in Quiet Room');
    expect(t.question()).toBeUndefined();
    expect(t.quiet(QUIET)).toBe(0);
    expect(t.transcriptOf('fam')).toContain('/msg: egpt does not answer in Quiet Room');
  });

  it('unknown chat, this chat, and msg: false are refused the same way', async () => {
    for (const [cfg, line, why] of [[CONFIG(), '/e msg Nowhere hola', /^\/msg: no chat matches "Nowhere"/], [CONFIG(), '/e msg fam hola', /^\/msg: that is this chat$/], [CONFIG({ msg: false }), '/e msg "Contoso HQ" hola', /^\/msg: off on this node/]]) {
      const t = await bootWith(cfg, { reply: `ok\n${line}` });
      await t.human('hello'); await settle(t);
      expect(t.sentTo(ORIGIN).some((s) => why.test(s.text)), line).toBe(true);
      expect(t.question()).toBeUndefined();
      app.stop();
    }
  });

  it('another being\'s handle is not this being\'s msg: it stays in the post as prose, nothing asked', async () => {
    const t = await bootWith(CONFIG(), { reply: 'ok\n/o msg "Contoso HQ" hola' });
    await t.human('hello');
    await vi.waitFor(() => expect(t.finalsIn(ORIGIN).join('\n')).toContain('/o msg "Contoso HQ" hola'));
    expect(t.question()).toBeUndefined();
    expect(t.quiet(TARGET)).toBe(0);
  });
});

describe('/media inside an approved msg', () => {
  const dirOf = (slug) => slugDir('whatsapp', slug);
  beforeEach(async () => {
    await fs.mkdir(join(dirOf('fam'), 'out'), { recursive: true });
    await fs.writeFile(join(dirOf('fam'), 'out', 'a.png'), 'img');
    await fs.mkdir(dirOf('contoso-hq'), { recursive: true });
    await fs.writeFile(join(dirOf('contoso-hq'), 'theirs.png'), 'img');
  });

  it("the file from the being's own folder goes to the target, with the prose", async () => {
    const t = await bootWith(CONFIG(), { reply: 'ok\n/e msg "Contoso HQ" mira\n/media out/a.png' });
    await t.human('hello'); await settle(t);
    expect(t.question().text).toContain('/media out/a.png');
    await t.answer(t.question().id, 'yes');
    await vi.waitFor(() => expect(t.spy.media.filter((m) => m.chatId === TARGET)).toHaveLength(1));
    expect(t.spy.media.find((m) => m.chatId === TARGET).path).toBe(join(dirOf('fam'), 'out', 'a.png'));
    expect(t.sentTo(TARGET).map((s) => s.text)).toEqual(['mira']);
    await vi.waitFor(() => expect(t.sentTo(ORIGIN).map((s) => s.text)).toContain('✅ sent to Contoso HQ'));
  });

  it("REPRODUCE: written in a fork or topic (no slug of its own), the text AND the parent's file reach the target", async () => {
    const t = await bootWith(CONFIG(), { reply: 'ok\n/e msg "Contoso HQ" mira\n/media out/a.png', bareFork: true });
    const inFork = (body, over = {}) => t.human(body, { chatId: FORK, chatName: 'Side', ...over });
    await inFork('hello');
    await vi.waitFor(() => expect(t.sentTo(FORK).some((s) => s.text.startsWith('✋') || s.text.startsWith('/msg:'))).toBe(true));
    const q = t.sentTo(FORK).find((s) => s.text.startsWith('✋'));
    expect(q, t.sentTo(FORK).map((s) => s.text).join(' | ')).toBeTruthy();
    expect(t.quiet(TARGET)).toBe(0);
    await inFork('yes', { replyToId: q.id });
    await vi.waitFor(() => expect(t.spy.media.filter((m) => m.chatId === TARGET)).toHaveLength(1));
    expect(t.spy.media.find((m) => m.chatId === TARGET).path).toBe(join(dirOf('fam'), 'out', 'a.png'));
    expect(t.sentTo(TARGET).map((s) => s.text)).toEqual(['mira']);
    await vi.waitFor(() => expect(t.sentTo(FORK).map((s) => s.text)).toContain('✅ sent to Contoso HQ'));
  });

  it("a file outside the being's folder (the target's own, a traversal) is refused: not sent, the source is told", async () => {
    for (const path of ['theirs.png', '../contoso-hq/theirs.png']) {
      const t = await bootWith(CONFIG(), { reply: `ok\n/e msg "Contoso HQ" mira\n/media ${path}` });
      await t.human('hello'); await settle(t);
      await t.answer(t.question().id, 'yes');
      await vi.waitFor(() => expect(t.sentTo(ORIGIN).some((s) => s.text.startsWith('⚠️ /msg not delivered to Contoso HQ: /media not sent'))).toBe(true));
      expect(t.spy.media.filter((m) => m.chatId === TARGET)).toHaveLength(0);
      app.stop();
    }
  });
});

describe('a being\'s node-signed line, and the operator\'s own', () => {
  const beingLine = (t, body, over = {}) => t.app.spine.handleInbound({ body, from: { chatId: ORIGIN, chatName: 'fam', network: 'whatsapp', userId: 'self', senderName: 'E', isSender: true, authorized: true, msgKey: `b${Math.random()}`, fromNode: 'kg', fromBeing: 'egpt', ...over } });

  it("a being's line starting with /<handle> msg asks instead of sending", async () => {
    const t = await bootWith(CONFIG(), { reply: '…' });
    await beingLine(t, '/e msg "Contoso HQ" hola');
    await settle(t);
    expect(t.question().text).toMatch(/^✋ E → Contoso HQ:\nhola\n/);
    expect(t.quiet(TARGET)).toBe(0);
    await t.answer(t.question().id, 'yes');
    await vi.waitFor(() => expect(t.sentTo(TARGET).map((s) => s.text)).toEqual(['hola']));
  });

  it('...and with msg_approval: false it sends at once', async () => {
    const t = await bootWith(CONFIG({ msg_approval: false }), { reply: '…' });
    await beingLine(t, '/e msg "Contoso HQ" hola');
    await vi.waitFor(() => expect(t.sentTo(TARGET).map((s) => s.text)).toEqual(['hola']));
    expect(t.question()).toBeUndefined();
  });

  it("the operator's own typed line still sends at once, no question", async () => {
    const t = await bootWith(CONFIG(), { reply: '…' });
    await t.human('/e msg "Contoso HQ" hola\nsegunda');
    await vi.waitFor(() => expect(t.sentTo(TARGET).map((s) => s.text)).toEqual(['hola\nsegunda']));
    expect(t.question()).toBeUndefined();
  });
});
