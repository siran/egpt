// admin-channel-notice.test.mjs — the compaction notice is said in config.yaml's admin_channel.
//
// Operator, 2026-09-24: "make it's posted on admin channel, eGPT Admin. BTW the 'admin channel'
// must be defined in config.yaml." boot's noticeToAdmin reads `admin_channel` exactly as the advice
// channel is read (trimmed, empty => unset), turns a NAME into its room with the bridge's own
// resolveChatId, and says the line through sayOnce. Unset, or a name that names no chat: nothing is
// posted and the log says why. One Beeper connection here, so there is no mouth to route through
// and the assertion is simply which room the line was sent to.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
// A PRIVATE profile - egpt-home.mjs freezes EGPT_HOME at module load, so it is set before the
// imports below (the same reason tests/advice-and-peer-mouth-follow-the-chat.test.mjs gives).
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-admin-channel-notice-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
let boot, emptyState;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const TOKEN = 'TOK-primary';
const SELF_DM = '!self-dm';
const ADMIN_ROOM = '!egpt-admin-room';
const CHATS_BY_NAME = { 'eGPT Admin': ADMIN_ROOM };
const NOTICE = '🗜️ kg · E in Favel Konefka compacted its context (was 480k tokens). The full history stays in its transcript.md.';

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { token: opts.beeperToken, sent: [], resolved: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async sendAndGetId(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return 'status-1'; },
      startStreamMessage(init, o) { return { delivered: true, chatId: o?.chatId, update() {}, async finish() {} }; },
      // The bridge's own resolver, as src/bridges/beeper.mjs exports it: a room id is itself, a
      // name is looked up among the account's chats, and no match is null.
      async resolveChatId(nameOrId) {
        spy.resolved.push(nameOrId);
        const s = String(nameOrId);
        return s.startsWith('!') ? s : (CHATS_BY_NAME[s] ?? null);
      },
      async chatHasParticipant() { return null; },
      async chatRaw() { return null; },
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
const QUIET_SESSION = (opts) => ({
  sessionId: opts.sessionId ?? 'sess-1',
  async turn(m) { return { text: `↩ ${m}`, sessionId: 'sess-1' }; },
  close() {},
});
const config = (extra = {}) => ({
  node_name: 'kg',
  user_name: 'An',
  networks: { whatsapp: { chat_ids: [SELF_DM], allowed_users: ['+16468217865'] } },
  beeper: { primary: { account: 'anrodz42@example.com', token: TOKEN } },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
  ...extra,
});

let app = null;
afterEach(() => { try { app?.stop(); } catch {} app = null; });

async function bootWith(cfg) {
  const { start, built } = fakeTransport();
  const lines = [];
  let convState = emptyState();
  app = await boot({
    readConfig: () => cfg,
    startBridge: start,
    makeSession: QUIET_SESSION,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
    reapPort: () => 0,
    now: () => Date.UTC(2026, 8, 24, 16, 0),
    log: { line: (s) => lines.push(s) },
  });
  const sentTo = (room) => built.flatMap((b) => b.sent).filter((s) => s.chatId === room);
  return { app, built, lines, sentTo };
}

describe('the compaction notice goes to config.yaml\'s admin_channel', () => {
  it('REPRODUCE: a NAME is resolved to its room and the line is said there', async () => {
    const t = await bootWith(config({ admin_channel: 'eGPT Admin' }));
    expect(typeof t.app.noticeToAdmin).toBe('function');
    await t.app.noticeToAdmin(NOTICE, 'egpt');
    const hits = t.sentTo(ADMIN_ROOM);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain(NOTICE);
    expect(t.built.flatMap((b) => b.resolved)).toContain('eGPT Admin');
  });

  it('a raw room id works as it is, like advice_channel', async () => {
    const t = await bootWith(config({ admin_channel: ADMIN_ROOM }));
    await t.app.noticeToAdmin(NOTICE, 'egpt');
    expect(t.sentTo(ADMIN_ROOM)).toHaveLength(1);
  });

  it('unset: nothing is posted anywhere, and the log says the notice stays there', async () => {
    const t = await bootWith(config());
    const before = t.built.flatMap((b) => b.sent).length;
    await t.app.noticeToAdmin(NOTICE, 'egpt');
    expect(t.built.flatMap((b) => b.sent).length).toBe(before);
    expect(t.lines.join('\n')).toContain(NOTICE);
    expect(t.lines.join('\n')).toMatch(/admin_channel is not set in config\.yaml/);
  });

  it('blank is unset, read the same way as advice_channel', async () => {
    const t = await bootWith(config({ admin_channel: '   ' }));
    const before = t.built.flatMap((b) => b.sent).length;
    await t.app.noticeToAdmin(NOTICE, 'egpt');
    expect(t.built.flatMap((b) => b.sent).length).toBe(before);
    expect(t.lines.join('\n')).toMatch(/admin_channel is not set/);
  });

  it('a name that names no chat on this node: nothing is posted, and the log names it', async () => {
    const t = await bootWith(config({ admin_channel: 'No Such Group' }));
    const before = t.built.flatMap((b) => b.sent).length;
    await t.app.noticeToAdmin(NOTICE, 'egpt');
    expect(t.built.flatMap((b) => b.sent).length).toBe(before);
    expect(t.lines.join('\n')).toMatch(/admin_channel "No Such Group" names no chat on this node - notice not sent/);
  });
});
