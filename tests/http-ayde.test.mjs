// http-ayde.test.mjs — /ayde: the EduWeb team's read-only browser of EGPT_HOME on the chatbox limb
// (limbs.http.ayde). HTTP Basic against secrets/ayde.users, each user with a level: team < devs < admin
// < root. Below root a user reads only the scope's conversations (limbs.http.ayde.scope: chat ids, their
// folders by conversations.yaml); a path above the user's level, or outside the scope, is 401 in that
// level's realm; nothing outside EGPT_HOME, nothing written but the audit.
import { describe, it, expect, afterEach, beforeEach, beforeAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, utimes, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge } from '../src/bridges/http.mjs';
import { userLine, LEVELS, levelOf } from '../src/bridges/http-ayde.mjs';
import { readState } from '../src/conversations-state.mjs';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

const USERS = { tina: 'team', dev: 'devs', ada: 'admin', rob: 'root' };
const pw = (user) => `${user}-password-1`;
const basic = (user, pass = pw(user)) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const realm = (level) => `Basic realm="ayde ${level}", charset="UTF-8"`;
const rank = (level) => LEVELS.indexOf(level);
let USERS_TEXT;
beforeAll(async () => { USERS_TEXT = (await Promise.all(Object.entries(USERS).map(([u, l]) => userLine(u, l, pw(u))))).join('\n'); });

const SECRETS = ['dummy-beeper-token-AAAA1111', 'dummy-shell-token-BBBB2222', 'dummy-flow-token-CCCC3333', 'dummy-quoted-token-DDDD4444',
  'dummy-block-token-EEEE5555', 'second-line-FFFF6666', 'dummy-list-key-GGGG7777', 'dummy-list-key-HHHH8888', 'dummy-anchored-IIII9999',
  'dummy-commented-JJJJ0000', 'dummy-json-key-KKKK1111', 'dummy-json-hash-LLLL2222', 'dummy-readonly-token-MMMM3333'];
const CONFIG = `# eGPT node config
node_name: EDW            # the node
beeper_token: "dummy-beeper-token-AAAA1111"
shell:
  token: dummy-shell-token-BBBB2222
limbs:
  beeper:
    main: { account: x@example.com, token: "dummy-flow-token-CCCC3333" }
transcription_service:
  server: { token: 'dummy-quoted-token-DDDD4444' }
sandbox_oauth_token: |
  dummy-block-token-EEEE5555
  second-line-FFFF6666
api_keys:
  - dummy-list-key-GGGG7777
  - dummy-list-key-HHHH8888
anchored: &tok dummy-anchored-IIII9999
password: *tok
# old_token: dummy-commented-JJJJ0000
user_name: John
`;
const TELEGRAM = '123456789:dummy-telegram-token-not-a-secret';

const A = 'acme-00000000000000a1', B = 'acme-00000000000000b2', C = 'acme-00000000000000c3', D = 'zeta-00000000000000d4';
// Telegram: the EduWeb group (its /split fork in its folder), a topic in a folder of its own, and an
// unscoped group whose folder is only named like EduWeb's.
const TG = 'tg:-1004408163350', OTHER = 'tg:-1009999999999';
const G = 'eduweb-2610010101', T = 'eduweb-soporte-2610020202', U = 'eduweb-marketer-2610030303';
const SCOPE = ['http:acme-', TG];
const httpRows = [A, B, C, D].map((id) => `    "http:${id}":
      conversation_path: .egpt/conversations/http/${id}`).join('\n');
const registry = ({ g = G } = {}) => `contacts:
  http:
${httpRows}
  telegram:
    "${TG}": # EduWeb
      conversation_path: .egpt/conversations/telegram/${g}
    "${TG}/42": # SI+EduWeb-an
      conversation_path: .egpt/conversations/telegram/${g}
      parent_chat: "${TG}"
      transcript: SI+EduWeb-an
    "${TG}/7": # Soporte
      conversation_path: .egpt/conversations/telegram/${T}
    "${OTHER}": # Marketer?
      conversation_path: .egpt/conversations/telegram/${U}
  whatsapp:
    "58000@s.whatsapp.net": # Familia
      conversation_path: .egpt/conversations/whatsapp/familia
`;
let home, outside;
const at = (...p) => join(home, ...p);
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'egpt-ayde-'));
  outside = await mkdtemp(join(tmpdir(), 'egpt-ayde-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'outside EGPT_HOME', 'utf8');
  const put = async (path, text) => { await mkdir(join(at(path), '..'), { recursive: true }); await writeFile(at(path), text); };
  await put('config/config.yaml', CONFIG);
  await put('config/agents/ed.json', JSON.stringify({ name: 'ed', apiKey: 'dummy-json-key-KKKK1111', nested: { hash: 'dummy-json-hash-LLLL2222' }, model: 'opus' }, null, 2));
  await put('config.readonly.yaml', 'beeper_token: dummy-readonly-token-MMMM3333\n');
  await put('state/alive.txt', 'alive\n');
  await put('secrets/telegram-main.token', `${TELEGRAM}\n`);
  await put('chrome/profiles/brain/Default/Cookies', 'sqlite');
  const conv = async (id, usuario, files, t) => {
    const dir = `conversations/http/${id}`;
    if (usuario) await put(`${dir}/usuario.json`, JSON.stringify(usuario));
    for (const [f, text] of Object.entries(files)) await put(`${dir}/${f}`, text);
    await put(`${dir}/transcript.md`, `transcript of ${id}\n`);
    await utimes(at(dir, 'transcript.md'), new Date(t), new Date(t));
  };
  await conv(A, { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' },
    { 'gavetas/notas.md': 'notas de María\n', 'gavetas/foto.bin': Buffer.from([0x89, 0x50, 0, 1, 2, 0]), '.secrets/db.env': 'PGUSER=dummy\n', '.ssh/id_rsa': 'dummy private key\n', '.tools/run.sh': 'echo dev tool\n' }, '2026-10-26T10:00:00Z');
  await conv(B, { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' }, {}, '2026-10-20T10:00:00Z');
  await conv(C, { abrin: 'CSJ', user_type: 'P', short_name: 'Juan Pérez', username: 'jperez' }, {}, '2026-10-25T10:00:00Z');
  await conv(D, null, {}, '2026-10-24T10:00:00Z');
  await put('conversations/whatsapp/familia/transcript.md', 'familia\n');
  await put('conversations/whatsapp/familia/.notes.md', 'hidden notes\n');
  await put(`conversations/telegram/${G}/transcript.md`, 'EduWeb\n');
  await put(`conversations/telegram/${G}/transcript-SI+EduWeb-an.md`, 'the fork\n');
  await put(`conversations/telegram/${G}/.notes.md`, 'hidden notes\n');
  await put(`conversations/telegram/${T}/transcript.md`, 'Soporte\n');
  await put(`conversations/telegram/${U}/transcript.md`, 'not EduWeb\n');
  await put('config/conversations.yaml', registry());
});

const live = [];
afterEach(async () => {
  while (live.length) await live.pop()();
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// user: one of USERS (its right password), a "Basic …" header, or null for none.
async function limb({ ayde = { on: true, scope: SCOPE }, users = () => USERS_TEXT, ...opts } = {}) {
  const port = await freeSafeHttpPort();
  const lines = [];
  const b = await startHttpBridge({
    port, clients: { acme: { being: 'ed' } }, ayde, aydeRoot: home, aydeUsers: () => users?.() ?? null,
    aydeRegistry: () => readState(at('config', 'conversations.yaml')), onLog: (m) => lines.push(m), ...opts,
  });
  live.push(() => b.stop());
  const root = `http://127.0.0.1:${port}`;
  const base = `${root}/ayde/`;
  const auth = (user) => (user ? { Authorization: user.startsWith('Basic ') ? user : basic(user) } : {});
  const api = (sub, params = {}, user = 'rob', init = {}) => fetch(`${base}${sub}?${new URLSearchParams(params)}`, { ...init, headers: { ...auth(user), ...init.headers } });
  const get = async (sub, params, user, init) => {
    const r = await api(sub, params, user, init);
    return { status: r.status, realm: r.headers.get('www-authenticate'), body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
  };
  const page = (user, init = {}) => fetch(base, { ...init, headers: { ...auth(user), ...init.headers } });
  return { root, base, api, get, page, lines };
}

describe('limbs.http.ayde — the levels', () => {
  it('levelOf: inside a scoped folder a .secrets segment is root, another dot segment (.ssh too) devs, the rest team; outside every scoped folder root', () => {
    const homes = [['conversations', 'http', A], ['conversations', 'telegram', G]];
    const of = (p) => levelOf(p.split('/').filter(Boolean), homes);
    expect(of(`conversations/http/${A}/.secrets/y`)).toBe('root');
    expect(of(`conversations/http/${A}/.secrets`)).toBe('root');
    expect(of(`conversations/http/${A}/sub/.secrets`)).toBe('root');
    expect(of(`conversations/telegram/${G}/.ssh/id_ed25519`)).toBe('devs');
    expect(of(`conversations/http/${A}/.tools/a`)).toBe('devs');
    expect(of(`conversations/http/${A}/.secrets.bak/a`)).toBe('devs');
    expect(of(`conversations/telegram/${G}/.notes.md`)).toBe('devs');
    expect(of(`conversations/telegram/${G}/transcript.md`)).toBe('team');
    expect(of(`conversations/http/${A}`)).toBe('team');
    expect(of(`conversations/http/${A}/gavetas/notas.md`)).toBe('team');
    for (const p of [`conversations/http/${D}/transcript.md`, `conversations/http/${A}x`, 'conversations/http', 'conversations', '', 'config/x.yaml', 'state/x', 'secrets/x', 'chrome/x']) {
      expect(of(p), p).toBe('root');
    }
    expect(levelOf(['conversations', 'http', A], [])).toBe('root');
  });

  it('each level reads its paths and the lower levels\' paths; above it or outside the scope: 401 in the realm of the level it needs', async () => {
    const { get } = await limb();
    const cases = [
      ['tree', `conversations/http/${A}`, 'team'], ['file', `conversations/http/${A}/gavetas/notas.md`, 'team'],
      ['tree', `conversations/telegram/${G}`, 'team'], ['file', `conversations/telegram/${G}/transcript-SI+EduWeb-an.md`, 'team'],
      ['file', `conversations/telegram/${T}/transcript.md`, 'team'],
      ['tree', `conversations/http/${A}/.tools`, 'devs'], ['file', `conversations/http/${A}/.tools/run.sh`, 'devs'],
      ['tree', `conversations/http/${A}/.ssh`, 'devs'], ['file', `conversations/http/${A}/.ssh/id_rsa`, 'devs'],
      ['file', `conversations/telegram/${G}/.notes.md`, 'devs'],
      ['tree', `conversations/http/${A}/.secrets`, 'root'], ['file', `conversations/http/${A}/.secrets/db.env`, 'root'],
      ['tree', `conversations/http/${D}`, 'root'], ['file', `conversations/http/${D}/transcript.md`, 'root'],
      ['tree', `conversations/telegram/${U}`, 'root'], ['file', 'conversations/whatsapp/familia/transcript.md', 'root'],
      ['tree', 'conversations', 'root'], ['tree', 'conversations/http', 'root'], ['tree', '', 'root'],
      ['tree', 'config', 'root'], ['file', 'config/config.yaml', 'root'], ['file', 'config.readonly.yaml', 'root'], ['file', 'state/alive.txt', 'root'],
      ['tree', 'secrets', 'root'], ['file', 'secrets/telegram-main.token', 'root'],
      ['tree', 'chrome', 'root'], ['file', 'chrome/profiles/brain/Default/Cookies', 'root'],
    ];
    for (const [user, level] of Object.entries(USERS)) {
      for (const [call, p, need] of cases) {
        const r = await get(call, { p }, user);
        const what = `${user} (${level}) ${call} ${p}`;
        if (rank(level) >= rank(need)) expect(r.status, what).toBe(200);
        else {
          expect(r.status, what).toBe(401);
          expect(r.realm, what).toBe(realm(need));
          expect(r.body.message, what).toMatch(new RegExp(`needs the ${need} level`));
        }
      }
    }
  }, 60_000);

  it('below root the top is the scope: each folder by name with the chat ids it serves (the fork in its parent\'s, every acme- session); never conversations/ nor an unscoped name', async () => {
    const { get, lines } = await limb();
    for (const user of ['tina', 'dev', 'ada']) {
      const r = await get('tree', {}, user);
      expect(r.body, user).toMatchObject({ user, level: USERS[user], path: '', scope: true });
      expect(r.body.entries.map((e) => [e.name, e.path, e.chats, e.dir, e.level]), user).toEqual([
        [A, `conversations/http/${A}`, [`http:${A}`], true, 'team'],
        [B, `conversations/http/${B}`, [`http:${B}`], true, 'team'],
        [C, `conversations/http/${C}`, [`http:${C}`], true, 'team'],
        [G, `conversations/telegram/${G}`, [TG, `${TG}/42`], true, 'team'],
        [T, `conversations/telegram/${T}`, [`${TG}/7`], true, 'team'],
      ]);
      const text = JSON.stringify(r.body);
      for (const hidden of [D, U, OTHER, 'familia', 'whatsapp']) expect(text, `${user} ${hidden}`).not.toContain(hidden);
      for (const p of ['conversations', 'conversations/http', 'conversations/telegram']) {
        const up = await get('tree', { p }, user);
        expect(up.realm, `${user} ${p}`).toBe(realm('root'));
        expect(JSON.stringify(up.body), `${user} ${p}`).not.toMatch(/zeta|marketer|familia/);
      }
    }
    expect(lines.some((l) => /scope is empty/.test(l))).toBe(false);
    const top = (await get('tree', {}, 'rob')).body;
    expect(top).toMatchObject({ path: '', level: 'root' });
    expect(top.scope).toBeUndefined();
    expect(top.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['config', 'conversations', 'secrets', 'state']));
    expect((await get('tree', { p: 'conversations/telegram' }, 'rob')).body.entries.map((e) => e.name)).toEqual([G, U, T]);
  });

  it('team never sees a dot entry; devs and admin do; root lists EGPT_HOME', async () => {
    const { get } = await limb();
    const names = async (user, p) => (await get('tree', { p }, user)).body.entries.map((e) => e.name);
    expect(await names('tina', `conversations/http/${A}`)).toEqual(['admin-access.log', 'gavetas', 'transcript.md', 'usuario.json']);
    for (const user of ['dev', 'ada']) expect(await names(user, `conversations/http/${A}`), user).toEqual(['.secrets', '.ssh', '.tools', 'admin-access.log', 'gavetas', 'transcript.md', 'usuario.json']);
    expect(await names('tina', `conversations/telegram/${G}`)).toEqual(['admin-access.log', 'transcript-SI+EduWeb-an.md', 'transcript.md']);
    expect(await names('ada', `conversations/telegram/${G}`)).toEqual(['.notes.md', 'admin-access.log', 'transcript-SI+EduWeb-an.md', 'transcript.md']);
    const top = (await get('tree', { p: '' }, 'rob')).body;
    expect(top).toMatchObject({ user: 'rob', level: 'root', path: '' });
    expect(top.entries.find((e) => e.name === 'secrets')).toMatchObject({ dir: true, level: 'root' });
    expect(top.entries.find((e) => e.name === 'conversations')).toMatchObject({ dir: true, level: 'root' });
    const levels = Object.fromEntries((await get('tree', { p: 'conversations/http' }, 'rob')).body.entries.map((e) => [e.name, e.level]));
    expect(levels).toEqual({ [A]: 'team', [B]: 'team', [C]: 'team', [D]: 'root' });
  });

  it('a conversation\'s .secrets/ is root\'s: below root, 401 in the root realm by its path, by a link into it, or as a download; devs sees it listed as root', async () => {
    await symlink(at('conversations', 'http', A, '.secrets'), at('conversations', 'telegram', G, 'llaves'), 'junction');
    const { get, api } = await limb();
    const sec = `conversations/http/${A}/.secrets`, link = `conversations/telegram/${G}/llaves`;
    for (const user of ['tina', 'dev', 'ada']) {
      for (const [call, p] of [['tree', sec], ['file', `${sec}/db.env`], ['tree', link], ['file', `${link}/db.env`]]) {
        const r = await get(call, { p }, user);
        expect(r.status, `${user} ${call} ${p}`).toBe(401);
        expect(r.realm, `${user} ${call} ${p}`).toBe(realm('root'));
      }
      const dl = await api('file', { p: `${link}/db.env`, download: '1' }, user);
      expect(dl.status, user).toBe(401);
      expect(await dl.text(), user).not.toContain('PGUSER');
    }
    expect((await get('file', { p: `${link}/db.env` }, 'rob')).body).toMatchObject({ path: `${sec}/db.env`, text: 'PGUSER=dummy\n' });
    expect((await get('file', { p: `conversations/http/${A}/.ssh/id_rsa` }, 'dev')).body.text).toBe('dummy private key\n');
    const levels = Object.fromEntries((await get('tree', { p: `conversations/http/${A}` }, 'dev')).body.entries.map((e) => [e.name, e.level]));
    expect(levels).toMatchObject({ '.secrets': 'root', '.ssh': 'devs', '.tools': 'devs', gavetas: 'team', 'transcript.md': 'team' });
  });

  it('a conversation\'s .credentials/ (the being\'s scoped temporary DB login) is devs\' and above; its .secrets/ stays root\'s', async () => {
    await mkdir(at('conversations', 'http', A, '.credentials'), { recursive: true });
    await writeFile(at('conversations', 'http', A, '.credentials', 'db.env'), 'PGUSER=scoped_tmp\n');
    const { get, api } = await limb();
    const cred = `conversations/http/${A}/.credentials`, sec = `conversations/http/${A}/.secrets`;
    expect(levelOf(`${cred}/db.env`.split('/'), [['conversations', 'http', A]])).toBe('devs');
    for (const [call, p] of [['tree', cred], ['file', `${cred}/db.env`]]) {
      const r = await get(call, { p }, 'tina');
      expect(r.status, `${call} ${p}`).toBe(401);
      expect(r.realm, `${call} ${p}`).toBe(realm('devs'));
      expect(JSON.stringify(r.body)).not.toContain('scoped_tmp');
    }
    const dl = await api('file', { p: `${cred}/db.env`, download: '1' }, 'tina');
    expect(dl.status).toBe(401);
    expect(await dl.text()).not.toContain('scoped_tmp');
    expect((await get('tree', { p: `conversations/http/${A}` }, 'tina')).body.entries.map((e) => e.name)).not.toContain('.credentials');
    for (const user of ['dev', 'ada', 'rob']) {
      expect((await get('tree', { p: `conversations/http/${A}` }, user)).body.entries.find((e) => e.name === '.credentials'), user).toMatchObject({ dir: true, level: 'devs' });
      expect((await get('tree', { p: cred }, user)).body.entries.map((e) => e.name), user).toEqual(['db.env']);
      expect((await get('file', { p: `${cred}/db.env` }, user)).body.text, user).toBe('PGUSER=scoped_tmp\n');
    }
    for (const user of ['tina', 'dev', 'ada']) {
      for (const [call, p] of [['tree', sec], ['file', `${sec}/db.env`]]) expect((await get(call, { p }, user)).realm, `${user} ${call} ${p}`).toBe(realm('root'));
    }
    expect((await get('file', { p: `${sec}/db.env` }, 'rob')).body.text).toBe('PGUSER=dummy\n');
  });

  it('config, state and the rest of EGPT_HOME are root\'s: below root 401 in the root realm, nothing of them in the answer or a download; root reads them as they are', async () => {
    const { get, api } = await limb();
    for (const user of ['tina', 'dev', 'ada']) {
      for (const p of ['config/config.yaml', 'config/agents/ed.json', 'config.readonly.yaml', 'state/alive.txt']) {
        const r = await get('file', { p }, user);
        expect(r.status, `${user} ${p}`).toBe(401);
        expect(r.realm, `${user} ${p}`).toBe(realm('root'));
        const dl = await api('file', { p, download: '1' }, user);
        expect(dl.status, `${user} ${p}`).toBe(401);
        const text = `${JSON.stringify(r.body)}${await dl.text()}`;
        for (const s of SECRETS) expect(text, `${user} ${p}`).not.toContain(s);
      }
    }
    expect((await get('file', { p: 'config/config.yaml' }, 'rob')).body).toEqual({ path: 'config/config.yaml', size: Buffer.byteLength(CONFIG), text: CONFIG, truncated: false });
    expect(JSON.parse((await get('file', { p: 'config/agents/ed.json' }, 'rob')).body.text).apiKey).toBe('dummy-json-key-KKKK1111');
    expect(await (await api('file', { p: 'config.readonly.yaml', download: '1' }, 'rob')).text()).toBe('beeper_token: dummy-readonly-token-MMMM3333\n');
  });

  it('root reads secrets/ as it is', async () => {
    const { get, api } = await limb();
    expect((await get('file', { p: 'secrets/telegram-main.token' }, 'rob')).body.text).toBe(`${TELEGRAM}\n`);
    expect(await (await api('file', { p: 'secrets/telegram-main.token', download: '1' }, 'rob')).text()).toBe(`${TELEGRAM}\n`);
    expect((await get('tree', { p: 'secrets' }, 'rob')).body.entries.map((e) => e.name)).toEqual(['telegram-main.token']);
  });
});

describe('limbs.http.ayde — the scope', () => {
  it('no scope (the default) or an empty one: a boot line; below root nothing, an empty list, every conversation root\'s; root reads all', async () => {
    for (const ayde of [{ on: true }, { on: true, scope: [] }]) {
      const { get, lines } = await limb({ ayde });
      expect(lines).toContain('ayde: limbs.http.ayde.scope is empty — below root, nobody sees a conversation');
      for (const user of ['tina', 'dev', 'ada']) {
        expect((await get('tree', {}, user)).body, user).toMatchObject({ path: '', scope: true, sections: [], entries: [] });
        for (const p of [`conversations/http/${A}`, `conversations/telegram/${G}`]) expect((await get('tree', { p }, user)).realm, `${user} ${p}`).toBe(realm('root'));
      }
      expect((await get('tree', { scope: '1' }, 'rob')).body).toMatchObject({ scope: true, sections: [], entries: [] });
      expect((await get('tree', { p: `conversations/http/${A}` }, 'rob')).status).toBe(200);
    }
  });

  it('a scope entry covers its chat id and that chat\'s topics (<id>/<n>); one ending in "-" is a prefix; anything else that id only', async () => {
    const { get } = await limb({ ayde: { on: true, scope: [`${TG}/7`, 'tg:-100440816335', `http:${C}`, 'http:zeta', 'http:acme-00000000000000b'] } });
    expect((await get('tree', {}, 'tina')).body.entries.map((e) => [e.name, e.chats])).toEqual([[C, [`http:${C}`]], [T, [`${TG}/7`]]]);
    expect((await get('tree', { p: `conversations/telegram/${G}` }, 'tina')).realm).toBe(realm('root'));
    expect((await get('tree', { p: `conversations/http/${B}` }, 'tina')).realm).toBe(realm('root'));
  });

  it('by chat id, never by folder name: a renamed folder keeps its access, a folder named like a scoped one has none', async () => {
    const { get } = await limb();
    expect((await get('file', { p: `conversations/telegram/${G}/transcript.md` }, 'tina')).body.text).toBe('EduWeb\n');
    const R = 'renamed-2610010101';
    await rename(at('conversations', 'telegram', G), at('conversations', 'telegram', R));
    await writeFile(at('config', 'conversations.yaml'), registry({ g: R }));
    const top = (await get('tree', {}, 'tina')).body.entries;
    expect(top.find((e) => e.name === R)).toMatchObject({ path: `conversations/telegram/${R}`, chats: [TG, `${TG}/42`] });
    expect(top.map((e) => e.name)).not.toContain(G);
    expect((await get('file', { p: `conversations/telegram/${R}/transcript.md` }, 'tina')).body.text).toBe('EduWeb\n');
    expect((await get('tree', { p: `conversations/telegram/${G}` }, 'tina')).realm).toBe(realm('root'));
    expect((await get('tree', { p: `conversations/telegram/${U}` }, 'tina')).realm).toBe(realm('root'));
  });
});

// The page's one list (tree?scope=1; below root also tree with no p): a section per chatbox client, then
// the Telegram groups, then the rest; each row a person or a group, not an id.
describe('limbs.http.ayde — the conversation list', () => {
  const E = 'acme-00000000000000e5';   // an anonymous acme session
  const withE = () => registry().replace('  telegram:\n', `    "http:${E}":\n      conversation_path: .egpt/conversations/http/${E}\n  telegram:\n`);
  const transcript = (id, ...lines) => `---\nname: ${id}\nsurface: http\nslug: ${id}\n---\n\n${lines.join('\n\n')}\n\n`;
  const said = (who, id, hhmm, n, text) => `${who}@[${id}].http (${hhmm}) #${n}: ${text}`;
  // a session's history (state/http-messages/<sid>.json), kept by the limb because http-sessions.json lists it
  const history = async (sessions, logs) => {
    await mkdir(at('state', 'http-messages'), { recursive: true });
    await writeFile(at('state', 'http-sessions.json'), JSON.stringify(Object.fromEntries(Object.entries(sessions).map(([sid, client]) => [sid, { client, lastAt: Date.now() }]))));
    for (const [sid, log] of Object.entries(logs)) await writeFile(at('state', 'http-messages', `${sid}.json`), JSON.stringify(log));
  };
  const visitor = (text, seq) => ({ id: String(seq), from: 'visitor', text, done: true, seq });
  const being = (text, seq) => ({ id: String(seq), from: 'being', text, done: true, seq });

  it('one section per kind in the scope, in order: each chatbox client (limbs.http.clients\' order), Telegram, Other; entries by path with section, label, kind, title, last', async () => {
    const clients = { zeta: { being: 'ed', label: 'Zeta — support' }, acme: { being: 'ed', title: 'Acme chat' }, beta: { being: 'ed' } };
    const { get } = await limb({ clients, ayde: { on: true, scope: ['http:acme-', 'http:zeta-', 'http:beta-', TG, '58000@s.whatsapp.net'] } });
    const b = (await get('tree', {}, 'tina')).body;
    expect(b).toMatchObject({ user: 'tina', level: 'team', path: '', scope: true });
    expect(b.sections).toEqual([
      { id: 'chatbox:zeta', kind: 'chatbox', label: 'Zeta — support' },
      { id: 'chatbox:acme', kind: 'chatbox', label: 'Acme chat' },
      { id: 'chatbox:beta', kind: 'chatbox', label: 'beta' },
      { id: 'telegram', kind: 'telegram', label: 'Team groups (Telegram)' },
      { id: 'other', kind: 'other', label: 'Other' },
    ]);
    expect(b.entries.map((e) => [e.path, e.section, e.label, e.kind, e.title])).toEqual([
      [`conversations/http/${A}`, 'chatbox:acme', 'Acme chat', 'chatbox', 'María López'],
      [`conversations/http/${B}`, 'chatbox:acme', 'Acme chat', 'chatbox', 'María López'],
      [`conversations/http/${C}`, 'chatbox:acme', 'Acme chat', 'chatbox', 'Juan Pérez'],
      [`conversations/http/${D}`, 'chatbox:zeta', 'Zeta — support', 'chatbox', 'Visitor'],
      [`conversations/telegram/${G}`, 'telegram', 'Team groups (Telegram)', 'telegram', 'EduWeb'],
      [`conversations/telegram/${T}`, 'telegram', 'Team groups (Telegram)', 'telegram', 'Soporte'],
      ['conversations/whatsapp/familia', 'other', 'Other', 'other', 'Familia'],
    ]);
    expect(b.entries.find((e) => e.name === A).last).toBe(Date.parse('2026-10-26T10:00:00Z'));
    expect(b.entries.find((e) => e.name === G).chats).toEqual([TG, `${TG}/42`]);
  });

  it('a client section\'s label: its label, else its title, else its name; a client in the scope with no session yet: an empty section; a session of an unconfigured client: its name, last', async () => {
    const clients = { acme: { being: 'ed', title: 'Acme chat', label: 'Acme — website' }, beta: { being: 'ed', title: 'Beta', label: ' ' }, gamma: { being: 'ed' } };
    const { get } = await limb({ clients, ayde: { on: true, scope: ['http:zeta-', 'http:acme-', 'http:beta-', 'http:gamma-00000000000000ff', 'http:delta'] } });
    const b = (await get('tree', {}, 'ada')).body;
    expect(b.sections.map((s) => [s.id, s.label])).toEqual([['chatbox:acme', 'Acme — website'], ['chatbox:beta', 'Beta'], ['chatbox:gamma', 'gamma'], ['chatbox:zeta', 'zeta']]);
    expect(b.entries.filter((e) => e.section === 'chatbox:beta')).toEqual([]);
  });

  it('a Telegram row\'s title: its chat\'s name in conversations.yaml (never a /split fork\'s), else the folder\'s without its -<datestamp>', async () => {
    await writeFile(at('config', 'conversations.yaml'), registry().replace(' # Soporte', '').replace(' # EduWeb\n', '\n'));
    const { get } = await limb();
    const titles = Object.fromEntries((await get('tree', {}, 'tina')).body.entries.filter((e) => e.kind === 'telegram').map((e) => [e.name, e.title]));
    expect(titles).toEqual({ [G]: 'eduweb', [T]: 'eduweb-soporte' });
  });

  it('a signed session\'s row: its usuario.json (short_name, username, school, user type), no preview', async () => {
    await writeFile(at('conversations', 'http', C, 'usuario.json'), JSON.stringify({ abrin: 'CSJ', user_type: 'P', short_name: '', username: 'jperez', verified_at: '2026-10-25T10:00:00Z', token: 'never' }));
    const { get } = await limb();
    const rows = Object.fromEntries((await get('tree', {}, 'tina')).body.entries.map((e) => [e.name, e]));
    expect(rows[A]).toMatchObject({ kind: 'chatbox', title: 'María López', usuario: { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' }, preview: null });
    expect(rows[C]).toMatchObject({ title: 'jperez', usuario: { abrin: 'CSJ', user_type: 'P', short_name: '', username: 'jperez' }, preview: null });
    expect(JSON.stringify(rows[C])).not.toMatch(/never|verified_at/);
  });

  it('an anonymous row: "Visitor" and its first visitor line, one line, clipped at 80, text as it is (the page shows it as text): from its history, else its transcript; never logged', async () => {
    await writeFile(at('config', 'conversations.yaml'), withE());
    await mkdir(at('conversations', 'http', E), { recursive: true });
    await writeFile(at('conversations', 'http', E, 'transcript.md'), transcript(E,
      said('ed', E, '09:53', 1, '¡Hola! ¿En qué te ayudo?'),
      `${said('visitor', E, '09:54', 2, 'Hola <img src=x onerror=alert(1)> quiero\u0007 información​ sobre la plataforma para mi colegio, somos 300 alumnos y')}\nnecesitamos un demo`,
      said('visitor', E, '09:56', 3, 'otra cosa')));
    await writeFile(at('conversations', 'http', D, 'transcript.md'), transcript(D, said('visitor', D, '10:00', 1, 'del transcript')));
    await history({ '00000000000000d4': 'zeta' }, { '00000000000000d4': [being('¡Hola!', 1), visitor('  desde el\nhistorial  ', 2), visitor('después', 3)] });
    const { get, lines } = await limb({ clients: { acme: { being: 'ed' }, zeta: { being: 'ed' } }, stateDir: at('state'), ayde: { on: true, scope: ['http:acme-', 'http:zeta-'] } });
    const rows = Object.fromEntries((await get('tree', {}, 'tina')).body.entries.map((e) => [e.name, e]));
    expect(rows[E]).toMatchObject({ kind: 'chatbox', section: 'chatbox:acme', title: 'Visitor', usuario: null, preview: 'Hola <img src=x onerror=alert(1)> quiero información sobre la plataforma para m…' });
    expect([...rows[E].preview]).toHaveLength(80);
    expect(rows[D]).toMatchObject({ title: 'Visitor', usuario: null, preview: 'desde el historial' });
    expect(lines.join('\n')).not.toMatch(/plataforma|historial|del transcript/);
    await writeFile(at('conversations', 'http', E, 'transcript.md'), transcript(E, said('ed', E, '09:53', 1, '¡Hola!')));
    expect((await get('tree', {}, 'tina')).body.entries.find((e) => e.name === E).preview).toBeNull();
  });

  it('previews never come from outside the scope: not an unscoped session\'s, not through a link to one (transcript or history)', async () => {
    await writeFile(at('config', 'conversations.yaml'), withE());
    await writeFile(at('conversations', 'http', D, 'transcript.md'), transcript(D, said('visitor', D, '10:00', 1, 'SECRETO-D del transcript')));
    await history({ '00000000000000d4': 'zeta', '00000000000000e5': 'acme' }, { '00000000000000d4': [visitor('SECRETO-D del historial', 1)] });
    await mkdir(at('conversations', 'http', E), { recursive: true });
    const linked = await symlink(at('conversations', 'http', D, 'transcript.md'), at('conversations', 'http', E, 'transcript.md'), 'file')
      .then(() => symlink(at('state', 'http-messages', '00000000000000d4.json'), at('state', 'http-messages', '00000000000000e5.json'), 'file')).then(() => true, () => false);
    const { get, lines } = await limb({ clients: { acme: { being: 'ed' }, zeta: { being: 'ed' } }, stateDir: at('state') });
    for (const user of Object.keys(USERS)) {
      const b = (await get('tree', { scope: '1' }, user)).body;
      expect(JSON.stringify(b), user).not.toContain('SECRETO');
      expect(b.entries.map((e) => e.name), user).not.toContain(D);
      expect(b.entries.find((e) => e.name === E), user).toMatchObject({ title: 'Visitor', preview: null });
    }
    expect(lines.join('\n')).not.toContain('SECRETO');
    if (!linked) console.warn('symlinks unavailable: the link half of this test did not run');
  });

  it('root: tree?scope=1 is the same list as admin\'s, logged the same; tree with no p (or p="") is still EGPT_HOME (the page\'s "Everything else"); below root scope=1 is the same as no p', async () => {
    const { get, lines } = await limb();
    const ada = (await get('tree', {}, 'ada')).body, rob = (await get('tree', { scope: '1' }, 'rob')).body;
    expect(rob).toMatchObject({ user: 'rob', level: 'root', path: '', scope: true, truncated: false });
    expect(rob.sections).toEqual(ada.sections);
    expect(rob.entries).toEqual(ada.entries);
    expect(lines).toContain('ayde: rob (root) listed the scope');
    for (const params of [{}, { p: '' }]) {
      const raw = (await get('tree', params, 'rob')).body;
      expect(raw.scope).toBeUndefined();
      expect(raw.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['config', 'conversations', 'secrets', 'state']));
    }
    expect((await get('tree', { scope: '1' }, 'tina')).body).toEqual((await get('tree', {}, 'tina')).body);
    expect((await get('tree', { scope: '1', p: 'secrets' }, 'tina')).realm).toBe(realm('root'));
  });
});

describe('limbs.http.ayde — paths stay inside EGPT_HOME', () => {
  it('../, backslashes, a drive or stream colon, absolute, unknown: 404, even for root', async () => {
    const { get } = await limb();
    for (const p of ['..', '../x', 'conversations/../secrets', 'conversations\\..\\secrets', 'C:/Windows/win.ini', join(outside, 'secret.txt'),
      'config/config.yaml:stream', 'nope', `conversations/http/${A}/nope.md`]) {
      for (const call of ['tree', 'file']) expect((await get(call, { p }, 'rob')).status, `${call} ${p}`).toBe(404);
    }
    expect((await get('file', { p: 'config' }, 'rob')).status).toBe(404);
    expect((await get('tree', { p: 'config/config.yaml' }, 'rob')).status).toBe(404);
  });

  it('a link out of EGPT_HOME is refused for everyone; a link to a higher path, or out of the scope, needs that path\'s level', async () => {
    await symlink(outside, at('conversations', 'http', A, 'gavetas', 'fuera'), 'junction');
    await symlink(at('secrets'), at('conversations', 'http', A, 'gavetas', 'llaves'), 'junction');
    await symlink(at('conversations', 'http', D), at('conversations', 'http', A, 'gavetas', 'otra'), 'junction');
    await symlink(at('conversations', 'http', A, '.tools'), at('conversations', 'telegram', G, 'escondido'), 'junction');
    const { get } = await limb();
    for (const user of Object.keys(USERS)) {
      expect((await get('tree', { p: `conversations/http/${A}/gavetas/fuera` }, user)).status, user).toBe(404);
      expect((await get('file', { p: `conversations/http/${A}/gavetas/fuera/secret.txt` }, user)).status, user).toBe(404);
    }
    for (const user of ['tina', 'dev', 'ada']) {
      for (const p of [`conversations/http/${A}/gavetas/llaves/telegram-main.token`, `conversations/http/${A}/gavetas/otra/transcript.md`]) {
        const r = await get('file', { p }, user);
        expect(r.status, `${user} ${p}`).toBe(401);
        expect(r.realm, `${user} ${p}`).toBe(realm('root'));
      }
    }
    expect((await get('file', { p: `conversations/http/${A}/gavetas/llaves/telegram-main.token` }, 'rob')).body).toMatchObject({ path: 'secrets/telegram-main.token', text: `${TELEGRAM}\n` });
    expect((await get('file', { p: `conversations/http/${A}/gavetas/otra/transcript.md` }, 'rob')).body).toMatchObject({ path: `conversations/http/${D}/transcript.md` });
    expect((await get('file', { p: `conversations/telegram/${G}/escondido/run.sh` }, 'tina')).realm).toBe(realm('devs'));
    expect((await get('file', { p: `conversations/telegram/${G}/escondido/run.sh` }, 'dev')).body.text).toBe('echo dev tool\n');
    const entries = (await get('tree', { p: `conversations/http/${A}/gavetas` }, 'tina')).body.entries;
    expect(entries.find((e) => e.name === 'llaves')).toMatchObject({ link: true, dir: true });
  });

  it('another spelling of secrets/ (case, on Windows) is still root\'s', async () => {
    const { get } = await limb();
    const r = await get('file', { p: 'SECRETS/telegram-main.token' }, 'ada');
    expect(r.status).not.toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('dummy-telegram-token');
    const c = await get('file', { p: `conversations/http/${A}/.SECRETS/db.env` }, 'ada');
    expect(c.status).not.toBe(200);
    expect(JSON.stringify(c.body)).not.toContain('PGUSER');
  });
});

describe('limbs.http.ayde — the login', () => {
  it('off (default), on with no users file, or a path that overlaps the chatbox: 404', async () => {
    for (const opts of [{ ayde: null }, { ayde: { on: false } }, { users: null }]) {
      const { base, api } = await limb(opts);
      expect((await fetch(base, { headers: { Authorization: basic('rob') } })).status).toBe(404);
      expect((await api('tree', {}, 'rob')).status).toBe(404);
    }
    const { root, lines } = await limb({ ayde: { on: 'on', path: '/chat' } });
    expect((await fetch(`${root}/chat/`, { headers: { Authorization: basic('rob') } })).status).toBe(404);
    expect(lines).toContain('ayde off — its path /chat/ overlaps the chatbox\'s /chat/');
  });

  it('the escritorio and admin routes are gone: 404', async () => {
    const { root } = await limb();
    for (const p of ['/chat/acme/escritorio/', '/chat/acme/escritorio/search?q=', '/chat/acme/admin', '/chat/acme/admin/search?q=']) {
      expect((await fetch(`${root}${p}`, { headers: { Authorization: basic('rob') } })).status, p).toBe(404);
    }
  });

  it('ayde without its slash: 308 to ayde/, the query kept; another path works too', async () => {
    const { root } = await limb();
    const r = await fetch(`${root}/ayde?x=1`, { redirect: 'manual' });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('ayde/?x=1');
    const other = await limb({ ayde: { on: true, path: '/eduweb/ayde' } });
    expect((await fetch(`${other.root}/eduweb/ayde/`, { headers: { Authorization: basic('tina') } })).status).toBe(200);
  });

  it('no login: 401 in the team realm, whatever the path (nothing about the scope before a login)', async () => {
    const { page, get } = await limb();
    const p = await page(null);
    expect(p.status).toBe(401);
    expect(p.headers.get('www-authenticate')).toBe(realm('team'));
    expect(await p.text()).toMatch(/Sign in with your ayde user/);
    for (const sub of ['search', 'tree']) expect((await get(sub, {}, null)).realm).toBe(realm('team'));
    for (const path of ['secrets/telegram-main.token', 'config', `conversations/http/${A}`, `conversations/http/${D}`]) {
      for (const call of ['tree', 'file']) expect((await get(call, { p: path }, null)).realm, `${call} ${path}`).toBe(realm('team'));
    }
  });

  it('a wrong password or unknown user is 401; the right one opens the page, in English, with its level', async () => {
    const { page, get, lines } = await limb();
    for (const t of [basic('tina', 'wrong-password-x'), basic('nadie'), basic('tina', ''), basic('', 'x'), 'Basic ###']) {
      const r = await page(t);
      expect(r.status, t).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe(realm('team'));
    }
    const r = await page('tina');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toMatch(/lang="en"/);
    expect(html).toContain('Read-only');
    expect((await get('tree', {}, 'tina')).body).toMatchObject({ user: 'tina', level: 'team' });
    expect(lines.join('\n')).not.toMatch(/password-1|wrong-password/);
  });

  it('the users file is read on each request: a user added, re-levelled or removed applies without a restart', async () => {
    let text = USERS_TEXT;
    const { get } = await limb({ users: () => text });
    const tools = `conversations/http/${A}/.tools`;
    expect((await get('tree', { p: tools }, 'tina')).status).toBe(401);
    text = `${await userLine('tina', 'devs', pw('tina'))}\n${await userLine('rob', 'root', pw('rob'))}`;
    expect((await get('tree', { p: tools }, 'tina')).body.level).toBe('devs');
    expect((await get('tree', {}, 'dev')).status).toBe(401);
  });

  it('10 failed logins from one address in 15 min: 429 for 15 min, the right password too; another address still gets in; no password in the log', async () => {
    let t = Date.now();
    const { get, lines } = await limb({ trustProxy: true, now: () => t });
    const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
    const wrong = basic('tina', 'wrong-password-x');
    for (let i = 0; i < 10; i++) expect((await get('tree', {}, wrong, from('203.0.113.5'))).status, `try ${i + 1}`).toBe(401);
    const locked = await get('tree', {}, 'tina', from('203.0.113.5'));
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ retry_after_s: 900, message: 'Too many failed logins. Wait 15 minutes.' });
    expect((await get('tree', {}, null, from('203.0.113.5'))).status).toBe(429);
    expect((await get('tree', {}, 'tina', from('203.0.113.6'))).status).toBe(200);
    t += 15 * 60_000;
    expect((await get('tree', {}, 'tina', from('203.0.113.5'))).status).toBe(200);
    expect(lines.filter((l) => /^ayde: login refused for "tina" from 203\.0\.113\.5/.test(l))).toHaveLength(10);
    expect(lines).toContain('ayde: 203.0.113.5 locked out for 15 min');
    expect(lines.join('\n')).not.toMatch(/password-1|wrong-password/);
  });

  it('tries sent in parallel count too: of 15 at once, at most 10 reach the password check', async () => {
    const { get, lines } = await limb();
    const all = await Promise.all(Array.from({ length: 15 }, () => get('tree', {}, basic('tina', 'wrong-password-x'))));
    expect(all.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(5);
    expect(lines.filter((l) => /login refused/.test(l)).length).toBeLessThanOrEqual(10);
  });

  it('a right login at a level too low is not a failed login', async () => {
    const { get } = await limb();
    for (let i = 0; i < 12; i++) expect((await get('file', { p: 'secrets/telegram-main.token' }, 'tina')).status).toBe(401);
    expect((await get('tree', {}, 'tina')).status).toBe(200);
  });
});

// Log out: a 401 with no challenge makes the browser drop the login it cached for <ayde path>/ and show
// the page instead of a prompt.
describe('limbs.http.ayde — log out', () => {
  const out = async (base, user, init = {}) => {
    const r = await fetch(`${base}logout`, { ...init, headers: { ...(user ? { Authorization: user.startsWith('Basic ') ? user : basic(user) } : {}), ...init.headers } });
    return { status: r.status, realm: r.headers.get('www-authenticate'), type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), body: await r.text() };
  };

  const strip = (body) => body.replace(/ nonce="[^"]+"/g, '');
  // The realm-overwrite request (reserved 'logout' user + ?realm): the browser replaces the credential it
  // cached there. Any name may precede the colon; 'logout' is what the page sends.
  const over = (base, realm, user = 'logout') => fetch(`${base}logout?realm=${realm}`, { headers: { Authorization: basic(user, 'x') } });

  it('logout: 401 with the signed-out page (its overwrite script), no WWW-Authenticate, with or without a login; a line names the user, never the password', async () => {
    const { base, lines } = await limb();
    const none = await out(base, null);
    for (const r of [none, await out(base, 'tina'), await out(base, 'rob'), await out(base, basic('tina', 'wrong-password-x'))]) {
      expect(r.status).toBe(401);
      expect(r.realm).toBeNull();
      expect(r.type).toBe('text/html; charset=utf-8');
      expect(strip(r.body)).toBe(strip(none.body));
    }
    expect(none.body).toMatch(/lang="en"/);
    expect(none.body).toContain('<h1 id="h">Signed out</h1>');
    expect(none.body).toContain('<a href="./">Sign in again</a>');
    expect(none.body).toMatch(/sign in as another user/);
    // the overwrite script: one XHR per realm with the reserved user, then a check of the return path
    expect(none.body).toContain("'logout?realm=' + realm");
    expect(none.body).toContain("fetch('./'");
    expect(none.body).toContain(`<style nonce="${/'nonce-([^']+)'/.exec(none.csp)[1]}">`);
    expect(none.body).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
    expect(lines.filter((l) => /signed out/.test(l))).toEqual(['ayde: tina signed out', 'ayde: rob signed out', 'ayde: tina signed out']);
    expect(lines.join('\n')).not.toMatch(/password-1|wrong-password/);
  });

  it('the overwrite (reserved logout user, ?realm): 401 in that realm so the browser replaces its cached login; grants nothing; an unknown realm is team; never counted or logged', async () => {
    const { base, get, lines } = await limb({ trustProxy: true });
    for (const level of LEVELS) {
      const r = await over(base, level);
      expect(r.status, level).toBe(401);
      expect(r.headers.get('www-authenticate'), level).toBe(realm(level));
      expect(await r.text(), level).not.toMatch(/dummy-|PGUSER|private key/);   // nothing from EGPT_HOME
    }
    expect((await over(base, 'god')).headers.get('www-authenticate')).toBe(realm('team'));
    const from = { headers: { 'X-Forwarded-For': '203.0.113.9' } };
    for (let i = 0; i < 15; i++) expect((await fetch(`${base}logout?realm=root`, { headers: { Authorization: basic('logout', 'x'), ...from.headers } })).status).toBe(401);
    expect((await get('tree', {}, 'tina', from)).status).toBe(200);   // no lockout
    expect(lines.filter((l) => /login refused|logout/.test(l))).toEqual([]);
  });

  it('the reserved logout user is never a real login: on any path 401 (the signed-out page), never granted, never counted', async () => {
    const { get, base } = await limb();
    for (const call of ['tree', 'file', 'search']) {
      const r = await get(call, { p: 'state/alive.txt' }, basic('logout', 'x'));
      expect(r.status, call).toBe(401);
      expect(String(r.body), call).toContain('Signed out');   // the page, not data
    }
    const { lines } = await limb();
    for (let i = 0; i < 15; i++) await fetch(`${base}tree`, { headers: { Authorization: basic('logout', 'x') } });
    expect((await get('tree', {}, 'tina')).status).toBe(200);
    expect(lines.filter((l) => /login refused/.test(l))).toEqual([]);
  });

  it('never a failed login: 15 logouts lock nobody out; a locked-out address still gets the page', async () => {
    const { base, get, lines } = await limb({ trustProxy: true });
    const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
    for (let i = 0; i < 15; i++) expect((await out(base, basic('tina', 'wrong-password-x'), from('203.0.113.5'))).status).toBe(401);
    expect((await get('tree', {}, 'tina', from('203.0.113.5'))).status).toBe(200);
    expect(lines.filter((l) => /login refused/.test(l))).toEqual([]);
    for (let i = 0; i < 10; i++) await get('tree', {}, basic('tina', 'wrong-password-x'), from('203.0.113.6'));
    expect((await get('tree', {}, 'tina', from('203.0.113.6'))).status).toBe(429);
    const locked = await out(base, 'tina', from('203.0.113.6'));
    expect(locked.status).toBe(401);
    expect(locked.body).toContain('Signed out');
  });

  it('a right login keeps working after a logout (the server holds no session); logout/x is 404, POST 405, off 404, another path works', async () => {
    const { base, get, root } = await limb();
    await out(base, 'tina');
    expect((await get('tree', {}, 'tina')).status).toBe(200);
    expect((await fetch(`${base}logout/x`)).status).toBe(404);
    expect((await fetch(`${base}logout`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${root}/ayde/logout/`)).status).toBe(404);
    for (const opts of [{ ayde: null }, { users: null }]) expect((await out((await limb(opts)).base, 'rob')).status).toBe(404);
    const other = await limb({ ayde: { on: true, path: '/eduweb/ayde' } });
    expect((await out(`${other.root}/eduweb/ayde/`, 'tina')).status).toBe(401);
  });
});

// Through the site's proxy (it always adds X-Forwarded-For) a request is public: a right login above
// limbs.http.ayde.public_max_level (default team) is 403, not 401 (a 401 would re-prompt forever).
describe('limbs.http.ayde — the public path', () => {
  const via = (ip = '203.0.113.7') => ({ headers: { 'X-Forwarded-For': ip } });

  it('X-Forwarded-For or Forwarded: team gets in; a right login above team is 403 with a clear message and no prompt, logged; without either: as before', async () => {
    const { get, page, lines } = await limb({ trustProxy: true });
    expect((await get('tree', {}, 'tina', via())).body).toMatchObject({ user: 'tina', level: 'team' });
    expect((await page('tina', via())).status).toBe(200);
    expect((await get('file', { p: 'secrets/telegram-main.token' }, 'tina', via())).realm).toBe(realm('root'));
    for (const [user, level] of [['dev', 'devs'], ['ada', 'admin'], ['rob', 'root']]) {
      const r = await get('tree', {}, user, via());
      expect(r.status, user).toBe(403);
      expect(r.realm, user).toBeNull();
      expect(r.body.message, user).toBe(`The ${level} level opens only from the internal network.`);
      expect(lines, user).toContain(`ayde: ${user} (${level}) refused from 203.0.113.7 — the ${level} level opens only from the internal network (public_max_level: team)`);
    }
    const p = await page('rob', via());
    expect(p.status).toBe(403);
    expect(p.headers.get('www-authenticate')).toBeNull();
    expect(await p.text()).toContain('The root level opens only from the internal network.');
    expect((await get('file', { p: 'secrets/telegram-main.token' }, 'rob', { headers: { Forwarded: 'for=203.0.113.8' } })).status).toBe(403);
    expect(JSON.stringify(await get('file', { p: 'secrets/telegram-main.token' }, 'rob', via()))).not.toContain('dummy-telegram-token');
    expect((await get('file', { p: 'secrets/telegram-main.token' }, 'rob')).body.text).toBe(`${TELEGRAM}\n`);
    expect((await get('tree', {}, 'ada')).status).toBe(200);
    expect((await page('rob')).status).toBe(200);
  });

  it('a right login above the cap is not a failed login; a wrong password is 401 and counted as before, saying nothing of the user\'s level', async () => {
    const { get, lines } = await limb({ trustProxy: true });
    for (let i = 0; i < 12; i++) expect((await get('tree', {}, 'rob', via())).status, `try ${i + 1}`).toBe(403);
    expect((await get('tree', {}, 'tina', via())).status).toBe(200);
    const wrong = await get('tree', {}, basic('rob', 'wrong-password-x'), via('203.0.113.9'));
    expect(wrong.status).toBe(401);
    expect(wrong).toEqual(await get('tree', {}, basic('nadie', 'wrong-password-x'), via('203.0.113.9')));
    for (let i = 0; i < 8; i++) expect((await get('tree', {}, basic('rob', 'wrong-password-x'), via('203.0.113.9'))).status).toBe(401);
    expect((await get('tree', {}, 'rob', via('203.0.113.9'))).status).toBe(429);
    expect(lines).toContain('ayde: login refused for "rob" from 203.0.113.9 (1/10)');
    expect(lines).toContain('ayde: 203.0.113.9 locked out for 15 min');
    expect(lines.filter((l) => /refused from 203\.0\.113\.9/.test(l))).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/password-1|wrong-password/);
  });

  it('public_max_level: devs lets devs in from the internet and not admin; an invalid value is logged and taken as team', async () => {
    const { get } = await limb({ ayde: { on: true, scope: SCOPE, public_max_level: 'devs' } });
    expect((await get('file', { p: `conversations/http/${A}/.tools/run.sh` }, 'dev', via())).body.text).toBe('echo dev tool\n');
    expect((await get('tree', {}, 'tina', via())).status).toBe(200);
    expect((await get('tree', {}, 'ada', via())).status).toBe(403);
    expect((await get('tree', {}, 'rob', via())).status).toBe(403);
    expect((await get('tree', {}, 'ada')).status).toBe(200);
    const bad = await limb({ ayde: { on: true, public_max_level: 'god' } });
    expect(bad.lines).toContain("ayde: public_max_level 'god' is not team | devs | admin | root — treated as team");
    expect((await bad.get('tree', {}, 'dev', via())).status).toBe(403);
    expect((await bad.get('tree', {}, 'tina', via())).status).toBe(200);
    expect((await bad.get('tree', {}, 'dev')).status).toBe(200);
  });
});

describe('limbs.http.ayde — the page and audit', () => {
  it('the page: one self-contained HTML, no external asset, a nonce CSP, no referrer', async () => {
    const { page } = await limb();
    const r = await page('tina');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = r.headers.get('content-security-policy');
    expect(csp).toMatch(/default-src 'none'/);
    const html = await r.text();
    expect(html).toContain(`<script nonce="${/'nonce-([^']+)'/.exec(csp)[1]}">`);
    expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
  });

  it('the page: a Log out link to <ayde path>/logout beside the user', async () => {
    const { page } = await limb();
    expect(await (await page('tina')).text()).toContain('<span id="who"></span><a href="logout">Log out</a>');
  });

  it('the page: one list with one search box, from tree?scope=1; no separate search panel; text only through textContent', async () => {
    const { page, get } = await limb();
    const html = await (await page('tina')).text();
    expect(html).toContain("call('tree', { scope: '1' })");
    expect(html.match(/<input /g)).toHaveLength(1);
    expect(html).not.toMatch(/Website conversations|id="found"|call\('search'/);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).toContain("['Today', ");
    expect(html).toContain("['Previous', ");
    expect(html).not.toMatch(/second: |toLocaleString\(\)/);
    expect((await get('search', { q: '' }, 'tina')).status).toBe(404);
  });

  it('audit: every list, view and download in the log; inside a conversation also its admin-access.log; refusals logged; no contents', async () => {
    const { get, api, lines } = await limb();
    await get('tree', { p: `conversations/http/${A}` }, 'tina');
    await get('file', { p: `conversations/http/${A}/.tools/run.sh` }, 'dev');
    await api('file', { p: `conversations/http/${A}/gavetas/foto.bin`, download: '1' }, 'tina');
    await get('tree', { p: 'conversations/http' }, 'rob');
    await get('file', { p: 'config/config.yaml' }, 'rob');
    await get('file', { p: `conversations/http/${A}/.secrets/db.env` }, 'tina');
    await get('tree', {}, 'tina');
    await get('tree', { p: 'conversations/http' }, 'ada');
    const log = await readFile(at('conversations', 'http', A, 'admin-access.log'), 'utf8');
    expect(log).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+ tina \\(team\\) listed conversations/http/${A}/$`, 'm'));
    expect(log).toMatch(new RegExp(`dev \\(devs\\) viewed conversations/http/${A}/\\.tools/run\\.sh$`, 'm'));
    expect(log).toMatch(new RegExp(`tina \\(team\\) downloaded conversations/http/${A}/gavetas/foto\\.bin$`, 'm'));
    expect(log.trim().split('\n')).toHaveLength(3);
    expect(lines).toContain('ayde: rob (root) listed conversations/http/');
    expect(lines).toContain('ayde: rob (root) viewed config/config.yaml');
    expect(lines).toContain(`ayde: tina (team) refused conversations/http/${A}/.secrets/db.env — needs root`);
    expect(lines).toContain('ayde: tina (team) listed the scope');
    expect(lines).toContain('ayde: ada (admin) refused conversations/http — needs root');
    expect(existsSync(at('conversations', 'http', 'admin-access.log'))).toBe(false);
    expect(existsSync(at('config', 'admin-access.log'))).toBe(false);
    expect(lines.join('\n')).not.toMatch(/PGUSER|dummy-beeper/);
  });

  it('read-only: POST, PUT, DELETE, PATCH on the page or any call are 405', async () => {
    const { base, api } = await limb();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await fetch(base, { method, headers: { Authorization: basic('rob') } })).status, method).toBe(405);
      for (const sub of ['search', 'tree', 'file']) expect((await api(sub, { p: 'state/alive.txt' }, 'rob', { method })).status, `${method} ${sub}`).toBe(405);
    }
    expect(await readFile(at('state', 'alive.txt'), 'utf8')).toBe('alive\n');
  });

  it('an unknown call is 404', async () => {
    const { get } = await limb();
    expect((await get('rename', { p: 'state' }, 'rob')).status).toBe(404);
    expect((await get('file/extra', { p: 'state' }, 'rob')).status).toBe(404);
  });

  it('a text file past the cap is cut and says so; a binary one is flagged', async () => {
    await writeFile(at('conversations', 'http', A, 'gavetas', 'big.txt'), 'x'.repeat(300 * 1024), 'utf8');
    const { get } = await limb();
    const r = await get('file', { p: `conversations/http/${A}/gavetas/big.txt` }, 'tina');
    expect(r.body).toMatchObject({ size: 300 * 1024, truncated: true });
    expect(r.body.text.length).toBe(256 * 1024);
    expect((await get('file', { p: `conversations/http/${A}/gavetas/foto.bin` }, 'tina')).body).toEqual({ path: `conversations/http/${A}/gavetas/foto.bin`, size: 6, binary: true });
  });
});
