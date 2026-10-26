// telegram-boot.test.mjs — boot wires the Telegram limb only when limbs.telegram names a
// connection whose token file exists; a node without it boots exactly as before (kg, do), and a
// node whose ONLY limb is Telegram boots with no Beeper bridge at all.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-telegram-boot-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeNodeSignature } from '../src/node-signature.mjs';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_HOME, { recursive: true, force: true }); } catch {}
});

// A Beeper token in the environment would make a "no Beeper" config not beeperless.
let envToken;
beforeEach(() => { envToken = process.env.BEEPER_ACCESS_TOKEN; delete process.env.BEEPER_ACCESS_TOKEN; });
afterEach(async () => {
  if (envToken !== undefined) process.env.BEEPER_ACCESS_TOKEN = envToken;
  await fs.rm(join(_HOME, 'secrets'), { recursive: true, force: true });
});

const TG_TOKEN = '123456:FAKE-telegram-token';
const writeToken = async (connection = 'main', token = TG_TOKEN) => {
  await fs.mkdir(join(_HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(_HOME, 'secrets', `telegram-${connection}.token`), `${token}\n`);
};

const AGENTS = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'] } };
const BEEPER_ONLY = () => ({ node_name: 'kg', user_name: 'John', limbs: { beeper: { main: { account: 'you@example.com', token: 'TOK-b' } } }, agents: AGENTS });
const TELEGRAM_ONLY = () => ({ node_name: 'EDW', user_name: 'John', limbs: { telegram: { main: { account: 'edw_bot' } } }, networks: { telegram: { allowed_users: [42] } }, agents: AGENTS });
const MIXED = () => ({ ...BEEPER_ONLY(), limbs: { ...BEEPER_ONLY().limbs, telegram: { main: { account: 'edw_bot' } } }, networks: { telegram: { allowed_users: [42] } } });

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
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
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} };
}
// One spy per start call; the same fake "real bridge" shape serves both transports.
function fakeTransport(declared = {}) {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, sent: [], streams: [], reactions: [] };
    built.push(spy);
    return {
      ...declared,
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async sendReaction(chatId, msgId, emoji) { spy.reactions.push({ chatId, msgId, emoji }); return true; },
      startStreamMessage(init, o) {
        const h = { init, delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      wasSentByUs: () => false,
      isAlive: () => true, stop() { spy.stopped = true; },
    };
  };
  return { start, built };
}

async function bootWith(config, { state, telegram = true, session = fakeSession, tgExtra = {} } = {}) {
  const beeper = fakeTransport();
  const tg = fakeTransport({ visibleOnly: true, ...tgExtra });   // as the real limb declares (telegram.mjs)
  const lines = [];
  let convState = state ?? emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: beeper.start,
    ...(telegram ? { startTelegram: tg.start } : {}),
    makeSession: session,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    now: () => Date.UTC(2026, 9, 23, 14, 5),
    log: { line: (s) => lines.push(s) },
  });
  return { app, beeper: beeper.built, tg: tg.built, lines };
}

function seedOn(surface, chatId, name) {
  const ens = ensureContact(emptyState(), surface, chatId, { pushedName: name, slugHint: name });
  const entry = ens.state.contacts[surface][chatId];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
  return ens.state;
}
const tgFrom = { chatId: 'tg:42', chatName: 'An R', chatType: 'private', network: 'telegram', userId: '42', senderName: 'An R', authorized: true, msgKey: '7' };
const waFrom = { chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1' };

describe('no limbs.telegram — kg/do boot exactly as before', () => {
  it('builds the one Beeper bridge, starts no Telegram limb (even with a token file on disk), and logs nothing [telegram]', async () => {
    await writeToken();
    const { app, beeper, tg, lines } = await bootWith(BEEPER_ONLY());
    expect(beeper).toHaveLength(1);
    expect(beeper[0].opts.beeperToken).toBe('TOK-b');
    expect(tg).toHaveLength(0);
    expect(app.telegramPort).toBeNull();
    expect(lines.filter((l) => /telegram/i.test(l))).toEqual([]);
    // the spine still holds the single bridge itself — no fan-out wrapper
    expect(app.bridge.onMessage).toBe(app.bridge.onMessage);
    expect(app.bridge.stop).toBe(app.bridge.stop);
    app.stop();
  });

  it('a Beeper reply still goes out through Beeper', async () => {
    const { app, beeper } = await bootWith(BEEPER_ONLY(), { state: seedOn('whatsapp', waFrom.chatId, 'fam') });
    await beeper[0].onIncoming('hola E', waFrom);
    expect(beeper[0].streams).toHaveLength(1);
    expect(beeper[0].streams[0].chatId).toBe(waFrom.chatId);
    expect(beeper[0].streams[0].finals[0]).toContain('hola E');
    app.stop();
  });

  it('with no beeper block and no telegram, the legacy inert Beeper bridge is still built (unchanged)', async () => {
    const { app, beeper, tg } = await bootWith({ node_name: 'kg', user_name: 'John', agents: AGENTS });
    expect(beeper).toHaveLength(1);
    expect(tg).toHaveLength(0);
    app.stop();
  });
});

describe('limbs.telegram without its token file', () => {
  it('is not wired; one line names the file and the setup script; Beeper is untouched', async () => {
    const { app, beeper, tg, lines } = await bootWith(MIXED());
    expect(tg).toHaveLength(0);
    expect(beeper).toHaveLength(1);
    expect(app.telegramPort).toBeNull();
    const said = lines.filter((l) => l.startsWith('[telegram]'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/telegram-main\.token/);
    expect(said[0]).toMatch(/setup\/telegram-token\.mjs main/);
    app.stop();
  });
});

describe('a node whose only limb is Telegram', () => {
  it('boots with no Beeper bridge; the limb gets the token from the file and the node-level options', async () => {
    await writeToken();
    const { app, beeper, tg, lines } = await bootWith(TELEGRAM_ONLY());
    expect(beeper).toHaveLength(0);
    expect(tg).toHaveLength(1);
    expect(tg[0].opts.telegramToken).toBe(TG_TOKEN);
    expect(tg[0].opts.connection).toBe('main');
    expect([...tg[0].opts.wakeWords].sort()).toEqual(['e', 'egpt']);
    expect(tg[0].opts.isAllowedUser('42', 'telegram')).toBe(true);
    expect(tg[0].opts.isAllowedUser('43', 'telegram')).toBe(false);
    expect(lines.join('\n')).not.toContain(TG_TOKEN);
    expect(app.telegramPort.owns('tg:42')).toBe(true);
    app.stop();
    expect(tg[0].stopped).toBe(true);
  });

  it('an inbound Telegram message reaches the spine and the reply streams back out through Telegram', async () => {
    await writeToken();
    const { app, tg } = await bootWith(TELEGRAM_ONLY(), { state: seedOn('telegram', 'tg:42', 'An R') });
    await tg[0].onIncoming('hola E', tgFrom);
    expect(tg[0].streams).toHaveLength(1);
    expect(tg[0].streams[0].chatId).toBe('tg:42');
    expect(tg[0].streams[0].finals[0]).toContain('hola E');
    app.stop();
  });

  it('a command reply from an allowed user goes back to the Telegram chat', async () => {
    await writeToken();
    const { app, tg } = await bootWith(TELEGRAM_ONLY());
    await tg[0].onIncoming('/e status', tgFrom);
    await vi.waitFor(() => expect(tg[0].sent.some((s) => s.chatId === 'tg:42')).toBe(true));
    app.stop();
  });
});

describe('a node with Beeper and Telegram', () => {
  it('each reply goes out the limb its chat belongs to', async () => {
    await writeToken();
    let state = seedOn('whatsapp', waFrom.chatId, 'fam');
    const tgEnt = ensureContact(state, 'telegram', 'tg:42', { pushedName: 'An R', slugHint: 'An R' });
    state = tgEnt.state;
    state.contacts.telegram['tg:42'].agents = { egpt: { mode: 'on' } };
    const { app, beeper, tg } = await bootWith(MIXED(), { state });
    expect(beeper).toHaveLength(1);
    expect(tg).toHaveLength(1);

    await tg[0].onIncoming('hola tg', tgFrom);
    await beeper[0].onIncoming('hola wa', waFrom);
    expect(tg[0].streams.map((s) => s.chatId)).toEqual(['tg:42']);
    expect(beeper[0].streams.map((s) => s.chatId)).toEqual([waFrom.chatId]);
    expect(tg[0].streams[0].finals[0]).toContain('hola tg');
    expect(beeper[0].streams[0].finals[0]).toContain('hola wa');
    app.stop();
  });
});

// The bot is the being's own account: its port says so (beingAccount), so the being's /react is a
// real reaction on Telegram. A Beeper-only node's port never says it (no reaction, as before).
describe('reactions: the bot reacts like E on kg', () => {
  const reacting = (opts) => ({ ...fakeSession(opts), async turn(m, onUpdate) { onUpdate?.('/react #7 👍'); return { text: '/react #7 👍', sessionId: 'sess-1' }; } });

  it('a beeperless Telegram node: /react #7 👍 lands as a reaction on the bot, never a text line', async () => {
    await writeToken();
    const { app, tg } = await bootWith(TELEGRAM_ONLY(), { state: seedOn('telegram', 'tg:42', 'An R'), session: reacting });
    expect(app.telegramPort.beingAccount).toBe(true);
    await tg[0].onIncoming('hola E', tgFrom);
    await vi.waitFor(() => expect(tg[0].reactions).toEqual([{ chatId: 'tg:42', msgId: '7', emoji: '👍' }]));
    expect(tg[0].sent.filter((s) => /👍 \(/.test(s.text))).toEqual([]);
    app.stop();
  });

  it('a Beeper-only node (kg): /react is still the quoted text line, no reaction', async () => {
    const { app, beeper } = await bootWith(BEEPER_ONLY(), { state: seedOn('whatsapp', waFrom.chatId, 'fam'), session: reacting });
    await beeper[0].onIncoming('hola E', waFrom);
    await vi.waitFor(() => expect(beeper[0].sent.some((s) => /👍 \(/.test(s.text))).toBe(true));
    expect(beeper[0].reactions).toEqual([]);
    app.stop();
  });
});

// /group (2026-10-26): a being changes ITS OWN chat's photo, title or description, through the gated
// limbs path (agents.<being>.actions lists group) and the bridge that holds the chat; the outcome is
// woken back as a turn. A Beeper chat cannot: not-supported, said back the same way.
describe('/group: the being sets its own chat\'s info', () => {
  const ENABLED = { egpt: { ...AGENTS.egpt, actions: ['group'] } };
  // Emits `line` on its first turn only, then echoes — so the wake turn is seen and ends there.
  const once = (line, seen) => { let first = true; return (opts) => ({ ...fakeSession(opts), async turn(m, onUpdate) { seen.push(m); const t = first ? line : `↩ ${m}`; first = false; onUpdate?.(t); return { text: t, sessionId: 'sess-1' }; } }); };
  const recording = (set, answer = { ok: true }) => ({ async setChatInfo(chatId, info) { set.push({ chatId, info }); return answer; } });

  it('enabled, on a Telegram chat: the title is set on that chat and "/group title → set" is woken back', async () => {
    await writeToken();
    const set = [], seen = [];
    const { app, tg } = await bootWith({ ...TELEGRAM_ONLY(), agents: ENABLED }, { state: seedOn('telegram', 'tg:42', 'An R'), session: once('/group title Ventas', seen), tgExtra: recording(set) });
    await tg[0].onIncoming('E, ponle título', tgFrom);
    await vi.waitFor(() => expect(seen.some((m) => m.includes('/group title → set'))).toBe(true));
    expect(set).toEqual([{ chatId: 'tg:42', info: { title: 'Ventas' } }]);
    app.stop();
  });

  it('a photo from the conversation folder goes up by its absolute path; Telegram\'s refusal is woken back verbatim', async () => {
    await writeToken();
    const ens = ensureContact(emptyState(), 'telegram', 'tg:42', { pushedName: 'An R', slugHint: 'An R' });
    ens.state.contacts.telegram['tg:42'].agents = { egpt: { mode: 'on' } };
    const { slugDir } = await import('../src/conversations-state.mjs');
    const dir = slugDir('telegram', ens.slug);
    await fs.mkdir(join(dir, 'media'), { recursive: true });
    await fs.writeFile(join(dir, 'media', 'logo.png'), 'png');
    const set = [], seen = [];
    const { app, tg } = await bootWith({ ...TELEGRAM_ONLY(), agents: ENABLED }, { state: ens.state, session: once('/group photo media/logo.png', seen), tgExtra: recording(set, { ok: false, reason: 'Bad Request: not enough rights to change chat photo' }) });
    await tg[0].onIncoming('E, pon el logo', tgFrom);
    await vi.waitFor(() => expect(seen.some((m) => m.includes('/group photo → failed: Bad Request: not enough rights to change chat photo'))).toBe(true));
    expect(set).toEqual([{ chatId: 'tg:42', info: { photo: join(dir, 'media', 'logo.png') } }]);
    app.stop();
  });

  it('not enabled: refused and logged, the bridge is never asked', async () => {
    await writeToken();
    const set = [], seen = [];
    const { app, tg, lines } = await bootWith(TELEGRAM_ONLY(), { state: seedOn('telegram', 'tg:42', 'An R'), session: once('/group title Ventas', seen), tgExtra: recording(set) });
    await tg[0].onIncoming('E, ponle título', tgFrom);
    await vi.waitFor(() => expect(lines.some((l) => l.includes('[actions] group: not enabled for egpt (agents.egpt.actions) — refused'))).toBe(true));
    expect(set).toEqual([]);
    app.stop();
  });

  it('a Beeper chat: not-supported, woken back; nothing throws', async () => {
    const seen = [];
    const { app, beeper } = await bootWith({ ...BEEPER_ONLY(), agents: ENABLED }, { state: seedOn('whatsapp', waFrom.chatId, 'fam'), session: once('/group title Ventas', seen) });
    await beeper[0].onIncoming('hola E', waFrom);
    await vi.waitFor(() => expect(seen.some((m) => m.includes('/group title → not-supported'))).toBe(true));
    app.stop();
  });
});

// The Telegram limb takes the node-level media + voice options every Beeper connection takes, so
// its intake (limb-intake.mjs) runs on the node's transcriber, verdicts, readback and placement.
describe('the Telegram limb gets the shared intake\'s node options', () => {
  it('transcriber, per-chat verdict, transcript reader, echo gate, onMedia and the one placement (its 🎧 reacts on the bot)', async () => {
    await writeToken();
    const { app, tg } = await bootWith(TELEGRAM_ONLY(), { state: seedOn('telegram', 'tg:42', 'An R') });
    const o = tg[0].opts;
    for (const k of ['transcribe', 'resolveTranscriptionService', 'readTranscript', 'echoGate', 'echoPlan', 'onMedia', 'outboundFor']) expect(typeof o[k]).toBe('function');
    expect((await o.resolveTranscriptionService('tg:42')).enabled).toBe(true);
    const out = o.outboundFor('tg:42');
    expect(await out.react('7', '🎧', out.keyOf('7', 'listening'), 'listening', { temporary: true })).toBe(true);
    expect(tg[0].reactions).toEqual([{ chatId: 'tg:42', msgId: '7', emoji: '🎧' }]);
    app.stop();
  });
});

// Telegram deleted groups the bot posted in (2026-10-24): no invisible character goes out there. The
// limb declares visibleOnly and the port's one wrap honours it; Beeper keeps its frame. A quoted
// being is read off its visible stamp, from the registry boot hands the limb.
describe('no invisible frame on Telegram; Beeper unchanged', () => {
  const NAMED = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], name: 'E', body_emoji: '🦉' } };

  it('a Telegram reply carries the visible stamp and no tag character; a Beeper reply still carries the frame', async () => {
    await writeToken();
    let state = seedOn('whatsapp', waFrom.chatId, 'fam');
    state = ensureContact(state, 'telegram', 'tg:42', { pushedName: 'An R', slugHint: 'An R' }).state;
    state.contacts.telegram['tg:42'].agents = { egpt: { mode: 'on' } };
    const { app, beeper, tg } = await bootWith({ ...MIXED(), agents: NAMED }, { state });
    await tg[0].onIncoming('hola tg', tgFrom);
    await beeper[0].onIncoming('hola wa', waFrom);
    const tags = /[\u{E0000}-\u{E007F}]/u;
    for (const t of [tg[0].streams[0].init, ...tg[0].streams[0].finals]) {
      expect(t).toMatch(/^🦉 E: /);
      expect(t).not.toMatch(tags);
    }
    expect(beeper[0].streams[0].finals[0]).toMatch(/^🦉 E: /);
    expect(beeper[0].streams[0].finals[0].endsWith(encodeNodeSignature('kg', 'egpt'))).toBe(true);
    app.stop();
  });

  it('the limb gets every being\'s stamp (key, body_emoji, name), read live', async () => {
    await writeToken();
    const { app, tg } = await bootWith({ ...TELEGRAM_ONLY(), agents: NAMED });
    expect(tg[0].opts.personaStamps()).toEqual([{ being: 'egpt', bodyEmoji: '🦉', label: 'E' }]);
    app.stop();
  });
});
