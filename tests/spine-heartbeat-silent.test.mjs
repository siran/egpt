// spine-heartbeat-silent.test.mjs — a `silent:` heartbeat posts its WHOLE self to eGPT Admin.
//
// Operator, 2026-09-30: "the bridge should announce it is triggering a heartbeat, unless the heartbeat
// is `silent`, in which case it posts in eGPT Admin", clarified: silent means the firing announcement
// AND the beat's output (a command post:'s text, an agent beat's reply) go to eGPT Admin, nothing to
// the beat's own chat. At the BOOT seam this is dispatchHeartbeatPost / dispatchHeartbeatTurn swapping
// the destination chat: not silent → the entity's chat; silent → admin_channel (the SAME resolution
// the compaction notice uses); admin unset/unresolvable → nothing posted, a warning logged, never the
// own chat. Modeled on admin-channel-notice.test.mjs — one Beeper connection, so the assertion is
// simply which room a line was sent to. The announce IS a dispatchHeartbeatPost, so its routing is the
// post routing; the loader wiring (every beat announces, silent threaded) is spine-heartbeat-loader's.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-heartbeat-silent-home`;
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
const PRIMES_ROOM = '!primes-room';
const CHATS_BY_NAME = { 'eGPT Admin': ADMIN_ROOM };
const NS = 'whatsapp/primes';

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { token: opts.beeperToken, sent: [], resolved: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async sendAndGetId(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return 'status-1'; },
      startStreamMessage(init, o) { return { delivered: true, chatId: o?.chatId, update() {}, async finish() {} }; },
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
const REPLY_SESSION = (opts) => ({
  sessionId: opts.sessionId ?? 'sess-1',
  async turn() { return { text: 'the beat reply', sessionId: 'sess-1' }; },
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
// A resolved conversation for NS, so chatIdForEntity(state, NS) → PRIMES_ROOM (egpt is resident).
const stateWithPrimes = () => {
  const s = emptyState();
  s.contacts = { ...(s.contacts ?? {}), whatsapp: { ...((s.contacts ?? {}).whatsapp ?? {}), [PRIMES_ROOM]: { slug: 'primes', agents: { egpt: {} } } } };
  return s;
};

let app = null;
afterEach(() => { try { app?.stop(); } catch {} app = null; });

async function bootWith(cfg) {
  const { start, built } = fakeTransport();
  const lines = [];
  let convState = stateWithPrimes();
  app = await boot({
    readConfig: () => cfg,
    startBridge: start,
    makeSession: REPLY_SESSION,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
    reapPort: () => 0,
    now: () => Date.UTC(2026, 8, 30, 16, 0),
    log: { line: (s) => lines.push(s) },
  });
  const sentTo = (room) => built.flatMap((b) => b.sent).filter((s) => s.chatId === room);
  const allSent = () => built.flatMap((b) => b.sent);
  return { app, built, lines, sentTo, allSent };
}

describe('a silent: heartbeat posts its whole self to eGPT Admin', () => {
  it('REPRODUCE: a silent post: (or announce) lands in eGPT Admin, NOTHING in the beat\'s own chat', async () => {
    const t = await bootWith(config({ admin_channel: 'eGPT Admin' }));
    await t.app.dispatchHeartbeatPost({ ns: NS, text: '🫀 prime', silent: true });   // the announce carries the beat's short name
    await t.app.dispatchHeartbeatPost({ ns: NS, text: 'el primo es 1637', silent: true });
    const admin = t.sentTo(ADMIN_ROOM);   // the node stamps an invisible signature onto every send, so match on contain
    expect(admin).toHaveLength(2);
    expect(admin[0].text).toContain('🫀 prime');
    expect(admin[1].text).toContain('el primo es 1637');
    expect(t.sentTo(PRIMES_ROOM)).toHaveLength(0);   // nothing in the own chat
  });

  it('a NON-silent post: lands in the beat\'s own chat, NOTHING in eGPT Admin (regression lock)', async () => {
    const t = await bootWith(config({ admin_channel: 'eGPT Admin' }));
    await t.app.dispatchHeartbeatPost({ ns: NS, text: 'el primo es 1637' });        // silent undefined
    await t.app.dispatchHeartbeatPost({ ns: NS, text: 'el primo es 1637', silent: false });
    expect(t.sentTo(PRIMES_ROOM)).toHaveLength(2);
    expect(t.sentTo(ADMIN_ROOM)).toHaveLength(0);
  });

  it('a silent agent turn: the reply lands in eGPT Admin, NOTHING in the beat\'s own chat', async () => {
    const t = await bootWith(config({ admin_channel: 'eGPT Admin' }));
    await t.app.dispatchHeartbeatTurn({ being: 'egpt', ns: NS, prompt: 'say a prime', name: `${NS}:prime` });
    const baseline = t.sentTo(PRIMES_ROOM).length;   // where a non-silent reply would have gone
    await t.app.dispatchHeartbeatTurn({ being: 'egpt', ns: NS, prompt: 'say a prime', name: `${NS}:prime`, silent: true });
    expect(t.sentTo(ADMIN_ROOM)).toHaveLength(1);
    expect(t.sentTo(ADMIN_ROOM)[0].text).toContain('the beat reply');
    expect(t.sentTo(PRIMES_ROOM)).toHaveLength(baseline);   // the silent turn added NOTHING to the own chat
  });

  it('FAIL-CLOSED: silent but admin_channel unset → nothing posted anywhere, a warning logged', async () => {
    const t = await bootWith(config());   // no admin_channel
    await t.app.dispatchHeartbeatPost({ ns: NS, text: '🫀 prime', silent: true });
    await t.app.dispatchHeartbeatTurn({ being: 'egpt', ns: NS, prompt: 'say a prime', name: `${NS}:prime`, silent: true });
    expect(t.allSent()).toHaveLength(0);                     // nothing to the own chat, nothing to admin
    expect(t.lines.join('\n')).toMatch(/silent beat, but admin_channel is not set in config\.yaml — nothing posted/);
  });

  it('FAIL-CLOSED: silent but admin_channel names no chat → nothing posted, a warning logged', async () => {
    const t = await bootWith(config({ admin_channel: 'No Such Group' }));
    await t.app.dispatchHeartbeatPost({ ns: NS, text: 'el primo es 1637', silent: true });
    expect(t.allSent()).toHaveLength(0);
    expect(t.lines.join('\n')).toMatch(/silent beat, but admin_channel is set but names no chat on this node/);
  });

  it('the compaction notice still routes to admin_channel with its own wording (resolveAdminChat shared, not re-implemented)', async () => {
    const t = await bootWith(config({ admin_channel: 'eGPT Admin' }));
    await t.app.noticeToAdmin('🗜️ compacted', 'egpt');
    expect(t.sentTo(ADMIN_ROOM)).toHaveLength(1);
  });
});
