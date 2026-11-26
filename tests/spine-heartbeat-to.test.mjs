// spine-heartbeat-to.test.mjs — a beat's `to: <chat>` says its output into ANOTHER chat (the /msg resolver, the
// same gate), and a `/media` line in a beat's output goes through the reply-action executor, the file confined to
// the BEAT's own folder. Boot seam, like spine-heartbeat-silent.test.mjs. Generic fixtures only.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-heartbeat-to-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
let boot, emptyState, slugDir;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, slugDir } = await import('../src/conversations-state.mjs'));
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
    const spy = { token: opts.beeperToken, sent: [], media: [], resolved: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async sendMedia(room, path, o) { spy.media.push({ chatId: room, path, caption: o?.caption }); return { ok: true }; },
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
  networks: { whatsapp: { chat_ids: [SELF_DM], allowed_users: ['+15550100001'] } },
  beeper: { primary: { account: 'anaprueba42@example.com', token: TOKEN } },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
  ...extra,
});

const OTHER = '!contoso-hq';
const SALES = '!contoso-sales';
const QUIET = '!quiet-room';
const TOPIC = '!primes-room/7';
const VISITOR = 'http:visitor-1';
// own chat: Primes (egpt answers). Its topic Billing (a fork: shares the folder). Elsewhere: Contoso HQ (egpt answers),
// Contoso Sales (idem, so "contoso" is ambiguous), Quiet Room (egpt does not answer), a chatbox visitor named Visitor Dani.
const stateWithChats = () => {
  const s = emptyState();
  s.contacts = {
    whatsapp: {
      [PRIMES_ROOM]: { slug: 'primes', pushedName: 'primes', agents: { egpt: {} } },
      [TOPIC]: { slug: 'primes', pushedName: 'Billing', parent_chat: PRIMES_ROOM, transcript: 'k7', agents: { egpt: {} } },
      [OTHER]: { slug: 'contoso-hq', pushedName: 'Contoso HQ', agents: { egpt: {} } },
      [SALES]: { slug: 'contoso-sales', pushedName: 'Contoso Sales', agents: { egpt: {} } },
      [QUIET]: { slug: 'quiet-room', pushedName: 'Quiet Room', agents: { other: {} } },
    },
    http: { [VISITOR]: { slug: 'visitor-dani', pushedName: 'Visitor Dani', agents: { egpt: {} } } },
  };
  return s;
};
let app = null;
afterEach(() => { try { app?.stop(); } catch {} app = null; });

async function bootWith(cfg, makeSession = REPLY_SESSION) {
  const { start, built } = fakeTransport();
  const lines = [];
  let convState = stateWithChats();
  const io = memIo();
  app = await boot({
    readConfig: () => cfg,
    startBridge: start,
    makeSession,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0,
    spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
    reapPort: () => 0,
    now: () => Date.UTC(2026, 8, 30, 16, 0),
    log: { line: (s) => lines.push(s) },
  });
  const sentTo = (room) => built.flatMap((b) => b.sent).filter((s) => s.chatId === room);
  const mediaTo = (room) => built.flatMap((b) => b.media).filter((s) => s.chatId === room);
  const allSent = () => built.flatMap((b) => [...b.sent, ...b.media]);
  const transcriptOf = (needle) => [...io.files].filter(([p]) => p.includes('transcript') && p.includes(needle)).map(([, t]) => t).join('\n');
  return { app, lines, sentTo, mediaTo, allSent, transcriptOf, io };
}
const post = (t, to, text = 'el primo es 1637') => t.app.dispatchHeartbeatPost({ ns: NS, text, to });
const turn = (t, to) => t.app.dispatchHeartbeatTurn({ being: 'egpt', ns: NS, prompt: 'say a prime', name: `${NS}:prime`, to });

describe('a structural beat with to: posts into another topic of its own conversation', () => {
  it('REPRODUCE: the post lands in the topic and its transcript, not in the beat\'s own chat', async () => {
    const t = await bootWith(config());
    await post(t, 'primes/Billing');
    expect(t.sentTo(TOPIC).map((s) => s.text).join('\n')).toContain('el primo es 1637');
    expect(t.sentTo(PRIMES_ROOM)).toHaveLength(0);
    expect(t.transcriptOf('k7')).toContain('el primo es 1637');
    expect(t.transcriptOf('transcript.md')).not.toContain('el primo es 1637');
  });
  it('no to: = today: the own chat', async () => {
    const t = await bootWith(config());
    await post(t, undefined);
    expect(t.sentTo(PRIMES_ROOM)).toHaveLength(1);
    expect(t.allSent()).toHaveLength(1);
  });
  it.each([
    ['another conversation (not its own folder)', 'Contoso HQ', /not in this conversation's own folder/],
    ['an ambiguous name', 'contoso', /matches 2/],
    ['an unknown name', 'Nowhere', /no chat matches/],
    ['a chatbox visitor', 'Visitor Dani', /no chat matches/],
  ])('%s → FAILED, nothing sent', async (_n, to, why) => {
    const t = await bootWith(config());
    await expect(post(t, to)).rejects.toThrow(why);
    expect(t.allSent()).toHaveLength(0);
  });
});

describe('an AI beat with to: says its turn into another chat where the being answers', () => {
  it('the reply goes to the target, not to the beat\'s own chat', async () => {
    const t = await bootWith(config());
    await turn(t, 'Contoso HQ');
    expect(t.sentTo(OTHER).map((s) => s.text).join('\n')).toContain('the beat reply');
    expect(t.sentTo(PRIMES_ROOM)).toHaveLength(0);
    expect(t.transcriptOf('Contoso HQ')).toContain('the beat reply');
    expect(t.transcriptOf('primes')).not.toContain('the beat reply');
  });
  it.each([
    ['a chat the being does not answer in', 'Quiet Room', /egpt does not answer in Quiet Room/],
    ['an ambiguous name', 'contoso', /matches 2/],
    ['an unknown name', 'Nowhere', /no chat matches/],
    ['a chatbox visitor', 'Visitor Dani', /no chat matches/],
  ])('%s → FAILED before the turn is spent, nothing sent', async (_n, to, why) => {
    let turns = 0;
    const t = await bootWith(config(), (o) => ({ sessionId: 's', async turn() { turns++; return { text: 'x', sessionId: 's' }; }, close() {} }));
    await expect(turn(t, to)).rejects.toThrow(why);
    expect(turns).toBe(0);
    expect(t.allSent()).toHaveLength(0);
  });
  it('no to: = today: the own chat', async () => {
    const t = await bootWith(config());
    await turn(t, undefined);
    expect(t.sentTo(PRIMES_ROOM).map((s) => s.text).join('\n')).toContain('the beat reply');
  });
});

describe('/media in a beat\'s output goes through the reply-action executor', () => {
  const dirOf = (slug) => slugDir('whatsapp', slug);
  const seed = async () => {
    await fs.mkdir(join(dirOf('primes'), 'pulso'), { recursive: true });
    await fs.writeFile(join(dirOf('primes'), 'pulso', 'x.jpg'), 'img');
    await fs.mkdir(dirOf('contoso-hq'), { recursive: true });
    await fs.writeFile(join(dirOf('contoso-hq'), 'theirs.jpg'), 'img');
  };
  it('REPRODUCE: a structural /media line is sent as media into its own chat, the text line as text', async () => {
    await seed();
    const t = await bootWith(config());
    await post(t, undefined, 'hello\n/media pulso/x.jpg the caption');
    expect(t.sentTo(PRIMES_ROOM).map((s) => s.text).join('\n')).toContain('hello');
    expect(t.sentTo(PRIMES_ROOM).map((s) => s.text).join('\n')).not.toContain('/media');
    expect(t.mediaTo(PRIMES_ROOM)).toHaveLength(1);
    expect(t.mediaTo(PRIMES_ROOM)[0]).toMatchObject({ path: join(dirOf('primes'), 'pulso', 'x.jpg') });
    expect(t.mediaTo(PRIMES_ROOM)[0].caption).toContain('the caption');   // the executor's stamp (default body emoji) rides along
  });
  it('with to:, the media goes to the target topic, the file still the beat\'s own', async () => {
    await seed();
    const t = await bootWith(config());
    await post(t, 'primes/Billing', '/media pulso/x.jpg');
    expect(t.mediaTo(TOPIC)).toHaveLength(1);
    expect(t.mediaTo(PRIMES_ROOM)).toHaveLength(0);
  });
  it('an AI beat\'s /media goes to its to: chat; the file is the beat\'s folder, not the target\'s', async () => {
    await seed();
    const reply = (text) => (o) => ({ sessionId: 's', async turn() { return { text, sessionId: 's' }; }, close() {} });
    const t = await bootWith(config(), reply('look\n/media pulso/x.jpg'));
    await turn(t, 'Contoso HQ');
    expect(t.mediaTo(OTHER)).toHaveLength(1);
    const u = await bootWith(config(), reply('/media theirs.jpg'));   // exists only in the TARGET's folder
    await expect(turn(u, 'Contoso HQ')).rejects.toThrow(/\/media not sent: theirs\.jpg/);
    expect(u.mediaTo(OTHER)).toHaveLength(0);
  });
  it.each([['../../outside.jpg'], ['/etc/passwd'], ['pulso/missing.jpg']])('a path outside (or absent): %s is refused, the beat FAILED', async (p) => {
    await seed();
    const t = await bootWith(config());
    await expect(post(t, undefined, `/media ${p}`)).rejects.toThrow(/\/media not sent/);
    expect(t.mediaTo(PRIMES_ROOM)).toHaveLength(0);
  });
  it('a /react or /reply line is stripped from the post and not run', async () => {
    const t = await bootWith(config());
    await post(t, undefined, 'hello\n/react #12 👍\n/reply #12 no');
    expect(t.sentTo(PRIMES_ROOM).map((s) => s.text).join('\n')).not.toMatch(/\/react|\/reply/);
    expect(t.sentTo(PRIMES_ROOM).map((s) => s.text).join('\n')).toContain('hello');
  });
});
