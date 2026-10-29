// http-boot.test.mjs — limbs.http through a real boot and a real loopback server: each visitor
// session is its own conversation (folder + transcript), a stranger wakes the client's being while
// the node answers only its owners, and the reply leaves through the one sender over SSE and JSON.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-http-boot-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

let boot, emptyState, getContact, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, getContact, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_HOME, { recursive: true, force: true }); } catch {}
});

let envToken;
beforeEach(() => { envToken = process.env.BEEPER_ACCESS_TOKEN; delete process.env.BEEPER_ACCESS_TOKEN; });
afterEach(async () => {
  if (envToken !== undefined) process.env.BEEPER_ACCESS_TOKEN = envToken;
  await fs.rm(join(_HOME, 'state'), { recursive: true, force: true, maxRetries: 10 });   // the limb may still be writing a session's history
});

const AGENTS = {
  ed: { configuration: 'egpt', handles: ['ed'], body_emoji: '🦉' },
  egpt: { configuration: 'egpt', handles: ['e', 'egpt'], body_emoji: '🐶' },
};
// Owner-only: nobody but owner-1 may wake a being that has no list of its own.
const config = (port) => ({
  node_name: 'EDW', user_name: 'John',
  conversation_defaults: { allowed_users: ['owner-1'] },
  limbs: { http: { port, clients: { eduweb: { being: 'ed', title: 'EduWeb' } } } },
  agents: AGENTS,
});

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files, dirs,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}
// The brain: answers with what it was asked, and notes which conversation folder it ran in and
// whether the seeded desk was already there.
function brain(turns) {
  return (opts) => ({
    sessionId: 'sess-1',
    async turn(m, onUpdate) { turns.push({ cwd: opts.cwd, m, desk: existsSync(join(opts.cwd ?? '', 'identidad.md')) }); onUpdate?.('pensando'); return { text: `respuesta a ${m.split('\n').at(-1)}`, sessionId: 'sess-1' }; },
    close() {},
  });
}

// withBeeper: a fake Beeper transport beside the chatbox, recording every chat it is asked to post in.
// edit(cfg): the config's last change before boot; id: the client the helpers' url names.
async function bootChatbox({ withBeeper = false, client = {}, agents = AGENTS, ayde = null, registry = null, edit = null, id = 'eduweb' } = {}) {
  const port = await freeSafeHttpPort();
  const io = memIo();
  const turns = [];
  const lines = [];
  const beeper = { posted: [], onIncoming: null };
  const startBridge = async (opts) => {
    beeper.onIncoming = opts.onIncoming;
    return {
      async send(text, o) { beeper.posted.push(o?.chatId); return { ok: true }; },
      startStreamMessage(init, o) { beeper.posted.push(o?.chatId); return { delivered: true, update() {}, async finish() {} }; },
      wasSentByUs: () => false, isAlive: () => true, stop() {},
    };
  };
  const cfg = config(port);
  Object.assign(cfg.limbs.http.clients.eduweb, client);
  cfg.agents = agents;
  if (ayde) cfg.limbs.http.ayde = ayde;
  if (withBeeper) cfg.limbs.beeper = { main: { account: 'x@example.com', token: 'TOK' } };
  edit?.(cfg);
  let convState = registry ?? emptyState();
  const app = await boot({
    readConfig: () => cfg,
    startBridge,
    makeSession: brain(turns),
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  const url = `http://127.0.0.1:${port}/chat/${id}/`;
  const post = (body) => fetch(`${url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const messages = (session, since = 0) => fetch(`${url}messages?session=${encodeURIComponent(session)}&since=${since}`).then((r) => r.json());
  return { app, io, turns, lines, port, url, post, messages, beeper, state: () => convState };
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
  return { events, close: () => { ac.abort(); return done; } };
}

const settled = (msgs) => msgs.find((m) => m.from === 'being' && m.done && /respuesta a/.test(m.text));
const convDir = (slug) => join(_HOME, 'conversations', 'http', slug);

describe('limbs.http on a node with no Beeper', () => {
  it('boots with the chatbox as its only limb', async () => {
    const { app, lines } = await bootChatbox();
    expect(app.httpPort.owns('http:eduweb-0123456789abcdef')).toBe(true);
    expect(app.telegramPort).toBeNull();
    expect(lines.some((l) => l.startsWith('[http] listening on'))).toBe(true);
    app.stop();
  });

  it('a stranger wakes the client\'s being (owner-only default in force), and only that being', async () => {
    const { app, post, messages, turns, state } = await bootChatbox();
    const j = await post({ text: 'hola, quiero una demo' });
    await vi.waitFor(async () => expect(settled((await messages(j.session)).messages)).toBeTruthy(), { timeout: 5000 });
    const reply = settled((await messages(j.session)).messages);
    expect(reply.text).toMatch(/^🦉 /);
    expect(reply.text).toContain('hola, quiero una demo');
    expect(turns).toHaveLength(1);
    const chatId = `http:${turns[0].cwd.split(/[\\/]/).at(-1)}`;
    const entry = getContact(state(), 'http', chatId)?.entry;
    expect(Object.keys(entry.agents)).toEqual(['ed']);
    expect(entry.agents.ed).toMatchObject({ default: true, mode: 'on', allowed_users: ['*'] });
    // the second line is admitted by the stored entry itself, not the seed
    await post({ session: j.session, text: 'somos un colegio' });
    await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 5000 });
    expect(turns[1].cwd).toBe(turns[0].cwd);
    app.stop();
  });

  it('two sessions → two conversation folders, two transcripts, each the brain\'s cwd', async () => {
    const { app, io, post, messages, turns } = await bootChatbox();
    const a = await post({ text: 'soy A' });
    const b = await post({ text: 'soy B' });
    for (const s of [a, b]) await vi.waitFor(async () => expect(settled((await messages(s.session)).messages)).toBeTruthy(), { timeout: 5000 });
    const cwds = [...new Set(turns.map((t) => t.cwd))];
    expect(cwds).toHaveLength(2);
    for (const cwd of cwds) expect(dirname(cwd)).toBe(join(_HOME, 'conversations', 'http'));
    const slugs = cwds.map((c) => c.split(/[\\/]/).at(-1));
    for (const slug of slugs) expect(slug).toMatch(/^eduweb-[0-9a-f]{16}$/);
    const [ta, tb] = slugs.map((slug) => io.files.get(join(convDir(slug), 'transcript.md')) ?? '');
    const byA = [ta, tb].find((t) => t.includes('soy A'));
    const byB = [ta, tb].find((t) => t.includes('soy B'));
    expect(byA).toBeTruthy();
    expect(byB).toBeTruthy();
    expect(byA).not.toContain('soy B');
    expect(byB).not.toContain('soy A');
    // the being's reply is recorded beside the visitor's line
    expect(byA).toMatch(/respuesta a/);
    app.stop();
  });

  it('the reply streams over SSE (placeholder, frames, final) and the JSON fetch has it too', async () => {
    const { app, post, messages, url } = await bootChatbox();
    const j = await post({ text: 'hola' });
    const stream = sse(`${url}events?session=${encodeURIComponent(j.session)}`);
    await vi.waitFor(() => expect(settled(stream.events)).toBeTruthy(), { timeout: 5000 });
    await stream.close();
    const reply = settled(stream.events);
    const frames = stream.events.filter((m) => m.id === reply.id);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0].done).toBe(false);
    expect(frames[0].text).toMatch(/⏳/);
    expect(frames.at(-1)).toEqual(reply);
    expect(stream.events.some((m) => m.from === 'visitor' && m.text === 'hola')).toBe(true);
    const viaJson = (await messages(j.session)).messages;
    expect(viaJson.find((m) => m.id === reply.id)).toEqual(reply);
    expect(reply.text).not.toMatch(/[​-‏\u{E0000}-\u{E007F}]/u);
    app.stop();
  });
});

describe('what the widget shows', () => {
  it('a public being (agents.<name>.public: true): only its text, posted once when the turn ends (no stamp, no ⏳ frames)', async () => {
    const { app, post, url, turns } = await bootChatbox({ agents: { ...AGENTS, ed: { ...AGENTS.ed, public: true } } });
    const j = await post({ text: 'hola' });
    const stream = sse(`${url}events?session=${encodeURIComponent(j.session)}`);
    await vi.waitFor(() => expect(settled(stream.events)).toBeTruthy(), { timeout: 5000 });
    await stream.close();
    const being = stream.events.filter((m) => m.from === 'being');
    expect(being).toHaveLength(1);
    expect(being[0].text).toBe(`respuesta a ${turns[0].m.split('\n').at(-1)}`);
    app.stop();
  });

  it('a stamped being, every signature slot empty: its stamp still leads, and what streamed stays above the seam', async () => {
    const { app, post, messages } = await bootChatbox();
    const j = await post({ text: 'hola' });
    await vi.waitFor(async () => expect(settled((await messages(j.session)).messages)).toBeTruthy(), { timeout: 5000 });
    expect(settled((await messages(j.session)).messages).text).toMatch(/^🦉 pensando\n\n— ↓ reply —\n\nrespuesta a /);
    app.stop();
  });
});

describe('the seeded desk', () => {
  it('a new session\'s folder holds the client\'s seed before the being\'s first turn; a later seed edit never touches it', async () => {
    const seedDir = join(_HOME, 'seeds', 'eduweb');
    await fs.mkdir(join(seedDir, 'drawer'), { recursive: true });
    await fs.writeFile(join(seedDir, 'identidad.md'), 'v1');
    await fs.writeFile(join(seedDir, 'drawer', 'db.txt'), 'solo lectura');
    try {
      const { app, post, turns, lines } = await bootChatbox({ client: { seed: 'seeds/eduweb' } });
      const a = await post({ text: 'hola' });
      await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000 });
      const dirA = turns[0].cwd;
      expect(turns[0].desk).toBe(true);
      expect(await fs.readFile(join(dirA, 'identidad.md'), 'utf8')).toBe('v1');
      expect(await fs.readFile(join(dirA, 'drawer', 'db.txt'), 'utf8')).toBe('solo lectura');
      expect(lines.some((l) => /^\[http\] http:eduweb-[0-9a-f]{16}: its desk is seeded from .* \(2 files\)$/.test(l))).toBe(true);

      await fs.writeFile(join(seedDir, 'identidad.md'), 'v2');
      await fs.writeFile(join(seedDir, 'nuevo.md'), 'nuevo');
      await post({ session: a.session, text: 'sigo' });
      await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 5000 });
      expect(await fs.readFile(join(dirA, 'identidad.md'), 'utf8')).toBe('v1');
      expect(existsSync(join(dirA, 'nuevo.md'))).toBe(false);

      await post({ text: 'otra visita' });
      await vi.waitFor(() => expect(turns).toHaveLength(3), { timeout: 5000 });
      const dirB = turns[2].cwd;
      expect(dirB).not.toBe(dirA);
      expect(await fs.readFile(join(dirB, 'identidad.md'), 'utf8')).toBe('v2');
      expect(existsSync(join(dirB, 'nuevo.md'))).toBe(true);
      app.stop();
    } finally { await fs.rm(join(_HOME, 'seeds'), { recursive: true, force: true }); }
  });
});

describe('no public commands in a chatbox conversation', () => {
  it('a visitor\'s /ed split and /ed end are plain text for the being — its first line included', async () => {
    const { app, post, turns, state } = await bootChatbox();
    const j = await post({ text: '/ed split ventas' });
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000 });
    expect(turns[0].m).toContain('split ventas');
    await post({ session: j.session, text: '/ed end' });
    await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 5000 });
    expect(turns[1].m).toContain('end');
    const entry = getContact(state(), 'http', `http:${turns[0].cwd.split(/[\\/]/).at(-1)}`)?.entry;
    expect(entry.public_commands).toEqual([]);
    app.stop();
  });
});

describe('limbs.http beside Beeper', () => {
  it('the owner-only default holds on Beeper while a chatbox stranger wakes the client being; the reply leaves through the chatbox only', async () => {
    const { app, post, messages, turns, beeper, lines } = await bootChatbox({ withBeeper: true });
    await beeper.onIncoming('ed hola', { chatId: '!dm:beeper.local', chatName: 'S', chatType: 'private', network: 'whatsapp', userId: '+580000', senderName: 'S', authorized: false, msgKey: 'm1' });
    expect(turns).toHaveLength(0);
    const j = await post({ text: 'hola' });
    await vi.waitFor(async () => expect(settled((await messages(j.session)).messages)).toBeTruthy(), { timeout: 5000 });
    expect(turns).toHaveLength(1);
    expect(beeper.posted).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/not a local agent/);
    app.stop();
  });
});

describe('limbs.http.ayde through boot', () => {
  it('rooted at EGPT_HOME, users in secrets/ayde.users; no users file: a boot line and 404', async () => {
    const { app, lines } = await bootChatbox({ ayde: { on: true } });
    const root = lines.find((l) => l.startsWith('[http] listening on'));
    expect(root).toMatch(/; ayde at \/ayde\/$/);
    expect(lines.some((l) => /^\[http\] limbs\.http\.ayde is on but .*ayde\.users is missing — \/ayde answers 404 \(node setup\/ayde-user\.mjs add <user> <level>\)$/.test(l))).toBe(true);
    const port = /:(\d+)\//.exec(root)[1];
    expect((await fetch(`http://127.0.0.1:${port}/ayde/`)).status).toBe(404);
    app.stop();
  });

  it('HTTP Basic by level, the users file read on each request; the scope by the registry boot reads; the escritorio route is gone', async () => {
    const { userLine } = await import('../src/bridges/http-ayde.mjs');
    const usersFile = join(_HOME, 'secrets', 'ayde.users');
    const id = 'eduweb-00000000000000aa';
    const basic = (user, pass) => ({ headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } });
    await fs.mkdir(dirname(usersFile), { recursive: true });
    await fs.writeFile(usersFile, `${await userLine('ana', 'team', 'clave-de-ana-1')}\n${await userLine('rob', 'root', 'clave-de-rob-1')}\n`);
    await fs.mkdir(convDir(id), { recursive: true });
    await fs.writeFile(join(convDir(id), 'usuario.json'), JSON.stringify({ abrin: 'IEV', username: 'mlopez' }));
    try {
      const other = 'eduweb-00000000000000bb';
      let registry = ensureContact(emptyState(), 'http', `http:${id}`).state;
      registry = ensureContact(registry, 'http', `http:${other}`).state;
      await fs.mkdir(convDir(other), { recursive: true });
      const { app, url, lines } = await bootChatbox({ ayde: { on: true, scope: [`http:${id}`] }, registry });
      const ayde = url.replace('/chat/eduweb/', '/ayde/');
      expect(lines.some((l) => /scope is empty/.test(l))).toBe(false);
      expect(lines.some((l) => /ayde is on but/.test(l))).toBe(false);
      const none = await fetch(ayde);
      expect(none.status).toBe(401);
      expect(none.headers.get('www-authenticate')).toBe('Basic realm="ayde team", charset="UTF-8"');
      const ana = basic('ana', 'clave-de-ana-1');
      expect((await fetch(ayde, ana)).status).toBe(200);
      expect((await fetch(`${ayde}tree`, ana).then((r) => r.json())).entries.map((e) => [e.path, e.chats])).toEqual([[`conversations/http/${id}`, [`http:${id}`]]]);
      const top = await fetch(`${ayde}tree`, ana).then((r) => r.json());
      expect(top.sections).toEqual([{ id: 'chatbox:eduweb', kind: 'chatbox', label: 'EduWeb' }]);
      expect(top.entries[0]).toMatchObject({ section: 'chatbox:eduweb', title: 'mlopez', usuario: { abrin: 'IEV', username: 'mlopez' }, preview: null });
      expect((await fetch(`${ayde}tree?p=conversations/http/${other}`, ana)).headers.get('www-authenticate')).toBe('Basic realm="ayde root", charset="UTF-8"');
      expect((await fetch(`${ayde}tree?p=`, ana)).headers.get('www-authenticate')).toBe('Basic realm="ayde root", charset="UTF-8"');
      expect((await fetch(`${ayde}tree?p=secrets`, basic('rob', 'clave-de-rob-1')).then((r) => r.json())).entries.map((e) => e.name)).toContain('ayde.users');
      expect((await fetch(`${url}escritorio/`, ana)).status).toBe(404);

      await fs.writeFile(usersFile, `${await userLine('luis', 'devs', 'clave-de-luis-1')}\n`);
      expect((await fetch(`${ayde}tree`, ana)).status).toBe(401);
      expect((await fetch(`${ayde}tree`, basic('luis', 'clave-de-luis-1')).then((r) => r.json())).level).toBe('devs');
      app.stop();
    } finally {
      await fs.rm(usersFile, { force: true });
      await fs.rm(convDir(id), { recursive: true, force: true });
      await fs.rm(convDir('eduweb-00000000000000bb'), { recursive: true, force: true });
    }
  });

  it('an anonymous session in the list: its first line from its history under EGPT_HOME/state, else from its transcript as the spine writes it', async () => {
    const { userLine } = await import('../src/bridges/http-ayde.mjs');
    const usersFile = join(_HOME, 'secrets', 'ayde.users');
    await fs.mkdir(dirname(usersFile), { recursive: true });
    await fs.writeFile(usersFile, `${await userLine('ana', 'team', 'clave-de-ana-1')}\n`);
    let slug = null;
    try {
      const { app, url, io, post, messages, turns } = await bootChatbox({ ayde: { on: true, scope: ['http:eduweb-'] } });
      const ana = { headers: { Authorization: `Basic ${Buffer.from('ana:clave-de-ana-1').toString('base64')}` } };
      const list = () => fetch(`${url.replace('/chat/eduweb/', '/ayde/')}tree`, ana).then((r) => r.json());
      const j = await post({ text: 'hola, quiero una demo' });
      await vi.waitFor(async () => expect(settled((await messages(j.session)).messages)).toBeTruthy(), { timeout: 5000 });
      slug = turns[0].cwd.split(/[\\/]/).at(-1);
      await fs.mkdir(convDir(slug), { recursive: true });   // the test's io keeps the folder in memory
      const saved = join(_HOME, 'state', 'http-messages', `${slug.split('-').at(-1)}.json`);
      await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(saved, 'utf8')).some((m) => m.from === 'being' && m.done && /respuesta a/.test(m.text))).toBe(true), { timeout: 5000 });
      expect((await list()).entries).toEqual([expect.objectContaining({ name: slug, section: 'chatbox:eduweb', title: 'Visitor', usuario: null, preview: 'hola, quiero una demo' })]);
      await fs.writeFile(join(convDir(slug), 'transcript.md'), io.files.get(join(convDir(slug), 'transcript.md')));
      await fs.rm(saved);
      expect((await list()).entries[0].preview).toBe('hola, quiero una demo');
      app.stop();
    } finally {
      await fs.rm(usersFile, { force: true });
      if (slug) await fs.rm(convDir(slug), { recursive: true, force: true });
    }
  });
});

describe('limbs.http.chatboxes: each chatbox named under limbs.http, configured in its own top-level block', () => {
  // EDW's shape: no clients:, the chatbox's keys and UI strings flat in its block.
  const blocks = (more = {}) => (cfg) => {
    cfg.limbs.http = { port: cfg.limbs.http.port, chatboxes: ['eduweb_marketer'] };
    cfg.eduweb_marketer = { url: 'eduweb', being: 'ed', title: 'Agente EduWeb', intro: '¡Hola, soy Edu!', ...more };
  };
  const widget = (url) => fetch(`${url}widget.js`).then((r) => r.text());
  const slugOf = (turn) => turn.cwd.split(/[\\/]/).at(-1);

  it('chatboxes alone: /chat/<url>/widget.js has the block\'s title and intro; a visitor reaches its being as http:<url>-<sid>, its desk from the block\'s seed', async () => {
    const seedDir = join(_HOME, 'seeds', 'eduweb');
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(join(seedDir, 'identidad.md'), 'v1');
    try {
      const { app, url, post, messages, turns, state, lines } = await bootChatbox({ edit: blocks({ seed: 'seeds/eduweb' }) });
      const js = await widget(url);
      expect(js).toContain('"client":"eduweb"');
      expect(js).toContain('"title":"Agente EduWeb"');
      expect(js).toContain('"intro":"¡Hola, soy Edu!"');
      const j = await post({ text: 'hola' });
      await vi.waitFor(async () => expect(settled((await messages(j.session)).messages)).toBeTruthy(), { timeout: 5000 });
      expect(settled((await messages(j.session)).messages).text).toMatch(/^🦉 /);
      const slug = slugOf(turns[0]);
      expect(slug).toMatch(/^eduweb-[0-9a-f]{16}$/);
      expect(turns[0].desk).toBe(true);
      expect(getContact(state(), 'http', `http:${slug}`).entry.agents).toEqual({ ed: expect.objectContaining({ default: true, mode: 'on', allowed_users: ['*'] }) });
      expect(lines.find((l) => l.startsWith('[http] listening on'))).toMatch(/clients: eduweb$/);
      expect(lines.join('\n')).not.toMatch(/not a local agent|skipped/);
      app.stop();
    } finally { await fs.rm(join(_HOME, 'seeds'), { recursive: true, force: true }); }
  });

  it('url defaults to the block\'s name', async () => {
    const { app, url, post, messages, turns } = await bootChatbox({ id: 'demoiev', edit: (cfg) => {
      cfg.limbs.http = { port: cfg.limbs.http.port, chatboxes: ['demoiev'] };
      cfg.demoiev = { being: 'ed', title: 'Soporte' };
    } });
    expect(await widget(url)).toContain('"client":"demoiev"');
    const j = await post({ text: 'hola' });
    await vi.waitFor(async () => expect(settled((await messages(j.session)).messages)).toBeTruthy(), { timeout: 5000 });
    expect(slugOf(turns[0])).toMatch(/^demoiev-[0-9a-f]{16}$/);
    app.stop();
  });

  it('a flat string beats the block\'s strings: map; `identity` stays the mode, its text in strings:', async () => {
    const { app, url } = await bootChatbox({ edit: blocks({ send: 'Mandar', identity: 'required', strings: { send: 'Enviar ya', placeholder: 'Pregunta', identity: 'Inicia sesión' } }) });
    const js = await widget(url);
    expect(js).toContain('"send":"Mandar"');
    expect(js).toContain('"placeholder":"Pregunta"');
    expect(js).toContain('"intro":"¡Hola, soy Edu!"');
    const r = await fetch(`${url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola' }) });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'identity required', message: 'Inicia sesión' });
    app.stop();
  });

  it('clients: still serves beside them; the same url in both: the block wins, logged; a name with no block, or not a map, is logged and skipped', async () => {
    const { app, url, port, post, messages, lines } = await bootChatbox({ edit: (cfg) => {
      cfg.limbs.http = { port: cfg.limbs.http.port, chatboxes: ['ghost', 'eduweb_marketer', 'flat'], clients: { eduweb: { being: 'egpt', title: 'Viejo' }, acme: { being: 'ed', title: 'Acme' } } };
      cfg.eduweb_marketer = { url: 'eduweb', being: 'ed', title: 'Agente EduWeb' };
      cfg.flat = 'not a block';
    } });
    const js = await widget(url);
    expect(js).toContain('"title":"Agente EduWeb"');
    expect(js).not.toContain('Viejo');
    expect(await widget(`http://127.0.0.1:${port}/chat/acme/`)).toContain('"title":"Acme"');
    const j = await post({ text: 'hola' });
    await vi.waitFor(async () => expect(settled((await messages(j.session)).messages)).toBeTruthy(), { timeout: 5000 });
    expect(settled((await messages(j.session)).messages).text).toMatch(/^🦉 /);
    expect(lines.some((l) => /^\[http\] .*limbs\.http\.clients\.eduweb.*eduweb_marketer.*the block wins/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[http\] .*\bghost\b.*skipped/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[http\] .*\bflat\b.*skipped/.test(l))).toBe(true);
    expect(lines.find((l) => l.startsWith('[http] listening on'))).toMatch(/clients: eduweb, acme$/);
    app.stop();
  });
});
