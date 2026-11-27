// msg-command-boot.test.mjs — /<handle> msg through a whole boot: the text lands in the target chat EXACTLY as written
// (no persona stamp, no visible bridge signature, no node frame — so a bot that answers only lines starting with its
// name sees the name first), recorded in that chat's transcript as the being's line; the operator's own line reaches any
// chat or Telegram topic of the node, anyone else's only where the being answers. /send (unsigned relay) is untouched
// (fork-command.test.mjs). Boot seam like telegram-boot.test.mjs. Generic fixtures only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-msg-command-boot-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_HOME, { recursive: true, force: true }); } catch {}
});

const AGENTS = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], name: 'E' }, other: { configuration: 'egpt', handles: ['o'], name: 'O' } };
const CONFIG = () => ({
  node_name: 'kg', user_name: 'John', bridge_signature_close: '🏰',
  limbs: { beeper: { main: { account: 'you@example.com', token: 'TOK-b' } }, telegram: { main: { account: 'edw_bot' } } },
  networks: { telegram: { allowed_users: [42] } },
  agents: AGENTS,
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
const fakeSession = (opts) => ({ sessionId: opts.sessionId ?? 'sess-1', async turn(m) { return { text: `↩ ${m}`, sessionId: 'sess-1' }; }, close() {} });
// One spy per start call; send() sees the bytes the port finally posts. Telegram declares visibleOnly, as the real limb does.
function fakeTransport(declared = {}) {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, sent: [], streams: [] };
    built.push(spy);
    return {
      ...declared,
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) { const h = { delivered: false, chatId: o?.chatId, update() {}, async finish() { this.delivered = true; } }; spy.streams.push(h); return h; },
      wasSentByUs: () => false,
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

const ORIGIN = '!room:beeper.com';      // WhatsApp: where the command is typed
const ANSWERED = '!contoso-hq';         // WhatsApp: egpt answers here
const QUIET = '!quiet-room';            // WhatsApp: egpt does not answer here
const GUILD = 'tg:-100';                // Telegram group and its topic, egpt does not answer in either
const TOPIC = 'tg:-100/7';
const stateWithChats = () => {
  let st = emptyState();
  for (const [surface, jid, name, being] of [
    ['whatsapp', ORIGIN, 'fam', 'egpt'], ['whatsapp', ANSWERED, 'Contoso HQ', 'egpt'], ['whatsapp', QUIET, 'Quiet Room', 'other'],
    ['telegram', GUILD, 'Guild', 'other'], ['telegram', TOPIC, 'Billing', 'other'],
  ]) {
    st = ensureContact(st, surface, jid, { pushedName: name, slugHint: name.toLowerCase().replace(/\W+/g, '-') }).state;
    st.contacts[surface][jid].agents = { [being]: { mode: 'on' } };
  }
  return st;
};
async function bootWith() {
  await fs.mkdir(`${_HOME}/secrets`, { recursive: true });
  await fs.writeFile(`${_HOME}/secrets/telegram-main.token`, '123456:FAKE-telegram-token\n');
  const beeper = fakeTransport();
  const tg = fakeTransport({ visibleOnly: true });
  const io = memIo();
  let convState = stateWithChats();
  const app = await boot({
    readConfig: CONFIG, startBridge: beeper.start, startTelegram: tg.start, makeSession: fakeSession,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState, writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0, exit: () => {}, now: () => Date.UTC(2026, 10, 25, 14, 5), log: { line: () => {} },
  });
  const say = (body, over = {}) => beeper.built[0].onIncoming(body, { chatId: ORIGIN, chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, isSender: true, msgKey: `m-${Math.random()}`, ...over });
  const transcriptOf = (needle) => [...io.files].filter(([p]) => p.includes('transcript') && p.includes(needle)).map(([, t]) => t).join('\n');
  return { app, say, io, wa: beeper.built[0], tg: tg.built[0], transcriptOf };
}

describe('/msg through a whole boot', () => {
  it('REPRODUCE: the text lands exactly as written — no stamp, no signature, no node frame — and in the target transcript', async () => {
    const t = await bootWith();
    await t.say('/e msg "Contoso HQ" sol hola\nsegunda línea');
    await vi.waitFor(() => expect(t.wa.sent.some((s) => s.chatId === ANSWERED)).toBe(true));
    expect(t.wa.sent.filter((s) => s.chatId === ANSWERED).map((s) => s.text)).toEqual(['sol hola\nsegunda línea']);
    expect(t.transcriptOf('Contoso HQ')).toContain('E@[Contoso HQ].wa');   // the being's own line, there
    expect(t.transcriptOf('Contoso HQ')).toContain('sol hola\nsegunda línea');
    t.app.stop();
  });
  it("the operator's line reaches a chat and a Telegram topic where the being does not answer, the topic by Group/topic", async () => {
    const t = await bootWith();
    await t.say('/e msg "Quiet Room" uno');
    await t.say('/e msg "guild/billing" dos');
    await vi.waitFor(() => expect(t.tg.sent.some((s) => s.chatId === TOPIC)).toBe(true));
    expect(t.wa.sent.filter((s) => s.chatId === QUIET).map((s) => s.text)).toEqual(['uno']);
    expect(t.tg.sent.filter((s) => s.chatId === TOPIC).map((s) => s.text)).toEqual(['dos']);
    t.app.stop();
  });
  it('a member (not the operator) is refused where the being does not answer, nothing posted there', async () => {
    const t = await bootWith();
    await t.say('/e msg "Quiet Room" uno', { chatType: 'group', authorized: false, isSender: false, userId: 'stranger', senderName: 'Stranger' });
    await vi.waitFor(() => expect(t.wa.sent.some((s) => /does not answer in Quiet Room/.test(s.text))).toBe(true));
    expect(t.wa.sent.filter((s) => s.chatId === QUIET)).toHaveLength(0);
    t.app.stop();
  });
});
