// http-ayde.test.mjs — /ayde: the EduWeb team's read-only browser of EGPT_HOME on the chatbox limb
// (limbs.http.ayde). HTTP Basic against secrets/ayde.users, each user with a level: team < devs < admin
// < root. A path above the user's level is 401 in that level's realm; admin reads config with its
// token-like values masked; nothing outside EGPT_HOME, nothing written but the audit.
import { describe, it, expect, afterEach, beforeEach, beforeAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { startHttpBridge } from '../src/bridges/http.mjs';
import { userLine, LEVELS, levelOf } from '../src/bridges/http-ayde.mjs';
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
let home, outside;
const at = (...p) => join(home, ...p);
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'egpt-ayde-'));
  outside = await mkdtemp(join(tmpdir(), 'egpt-ayde-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'outside EGPT_HOME', 'utf8');
  const put = async (path, text) => { await mkdir(join(at(path), '..'), { recursive: true }); await writeFile(at(path), text); };
  await put('config/config.yaml', CONFIG);
  await put('config/agents/ed.json', JSON.stringify({ name: 'ed', apiKey: 'dummy-json-key-KKKK1111', nested: { hash: 'dummy-json-hash-LLLL2222' }, model: 'opus' }, null, 2));
  await put('config/broken.yaml', 'a: [unclosed\n');
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
});

const live = [];
afterEach(async () => {
  while (live.length) await live.pop()();
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// user: one of USERS (its right password), a "Basic …" header, or null for none.
async function limb({ ayde = { on: true }, users = () => USERS_TEXT, ...opts } = {}) {
  const port = await freeSafeHttpPort();
  const lines = [];
  const b = await startHttpBridge({
    port, clients: { acme: { being: 'ed' } }, ayde, aydeRoot: home, aydeUsers: () => users?.() ?? null, onLog: (m) => lines.push(m), ...opts,
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
  it('levelOf: under conversations/, a .secrets segment is root, another dot segment (.ssh too) devs, the rest team', () => {
    const of = (p) => levelOf(p.split('/'));
    expect(of('conversations/x/.secrets/y')).toBe('root');
    expect(of('conversations/x/.secrets')).toBe('root');
    expect(of('conversations/http/x/sub/.secrets')).toBe('root');
    expect(of('conversations/x/.ssh/id_ed25519')).toBe('devs');
    expect(of('conversations/x/.tools/a')).toBe('devs');
    expect(of('conversations/x/.secrets.bak/a')).toBe('devs');
    expect(of('conversations/x/.notes.md')).toBe('devs');
    expect(of('conversations/x/transcript.md')).toBe('team');
    expect(of('conversations/http/x/gavetas/notas.md')).toBe('team');
    expect(of('secrets/x')).toBe('root');
    expect(of('config/x.yaml')).toBe('admin');
  });

  it('each level reads its paths and the lower levels\' paths; above it: 401 in the realm of the level it needs', async () => {
    const { get } = await limb();
    const cases = [
      ['tree', 'conversations', 'team'], ['tree', `conversations/http/${A}`, 'team'], ['file', `conversations/http/${A}/gavetas/notas.md`, 'team'],
      ['file', 'conversations/whatsapp/familia/transcript.md', 'team'],
      ['tree', `conversations/http/${A}/.tools`, 'devs'], ['file', `conversations/http/${A}/.tools/run.sh`, 'devs'],
      ['tree', `conversations/http/${A}/.ssh`, 'devs'], ['file', `conversations/http/${A}/.ssh/id_rsa`, 'devs'],
      ['file', 'conversations/whatsapp/familia/.notes.md', 'devs'],
      ['tree', `conversations/http/${A}/.secrets`, 'root'], ['file', `conversations/http/${A}/.secrets/db.env`, 'root'],
      ['tree', '', 'admin'], ['tree', 'config', 'admin'], ['file', 'state/alive.txt', 'admin'], ['file', 'config/config.yaml', 'admin'],
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

  it('team never sees a dot entry; devs does; admin sees EGPT_HOME with secrets/ marked root', async () => {
    const { get } = await limb();
    const names = async (user, p) => (await get('tree', { p }, user)).body.entries.map((e) => e.name);
    expect(await names('tina', `conversations/http/${A}`)).toEqual(['admin-access.log', 'gavetas', 'transcript.md', 'usuario.json']);
    expect(await names('dev', `conversations/http/${A}`)).toEqual(['.secrets', '.ssh', '.tools', 'admin-access.log', 'gavetas', 'transcript.md', 'usuario.json']);
    expect(await names('tina', 'conversations/whatsapp/familia')).toEqual(['admin-access.log', 'transcript.md']);
    const top = (await get('tree', { p: '' }, 'ada')).body;
    expect(top).toMatchObject({ user: 'ada', level: 'admin', path: '' });
    expect(top.entries.find((e) => e.name === 'secrets')).toMatchObject({ dir: true, level: 'root' });
    expect(top.entries.find((e) => e.name === 'config')).toMatchObject({ dir: true, level: 'admin' });
    expect(top.entries.find((e) => e.name === 'conversations')).toMatchObject({ dir: true, level: 'team' });
  });

  it('a conversation\'s .secrets/ is root\'s: below root, 401 in the root realm by its path, by a link into it, or as a download; devs sees it listed as root', async () => {
    await symlink(at('conversations', 'http', A, '.secrets'), at('conversations', 'whatsapp', 'familia', 'llaves'), 'junction');
    const { get, api } = await limb();
    const sec = `conversations/http/${A}/.secrets`, link = 'conversations/whatsapp/familia/llaves';
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

  it('the tree with no path starts at the user\'s top: conversations for team and devs, EGPT_HOME for admin and root', async () => {
    const { get } = await limb();
    expect((await get('tree', {}, 'tina')).body).toMatchObject({ path: 'conversations', level: 'team' });
    expect((await get('tree', {}, 'dev')).body.path).toBe('conversations');
    expect((await get('tree', {}, 'ada')).body.path).toBe('');
    expect((await get('tree', {}, 'rob')).body.path).toBe('');
  });

  it('admin reads config YAML/JSON (and config.readonly.yaml) masked, comments and the rest kept; root reads them as they are', async () => {
    const { get, api } = await limb();
    const y = await get('file', { p: 'config/config.yaml' }, 'ada');
    expect(y.body.masked).toBe(true);
    const doc = parseYaml(y.body.text);
    expect(doc.beeper_token).toBe('•••(27)');
    expect(doc.shell.token).toBe('•••(26)');
    expect(doc.limbs.beeper.main).toEqual({ account: 'x@example.com', token: '•••(25)' });
    expect(doc.sandbox_oauth_token).toBe('•••(48)');
    expect(doc.api_keys).toEqual(['•••(23)', '•••(23)']);
    expect(doc.user_name).toBe('John');
    expect(y.body.text).toMatch(/^# eGPT node config$/m);
    expect(y.body.text).toContain('node_name: EDW            # the node');
    expect(y.body.text).toMatch(/^# old_token: •••$/m);
    const j = await get('file', { p: 'config/agents/ed.json' }, 'ada');
    expect(JSON.parse(j.body.text)).toEqual({ name: 'ed', apiKey: '•••(23)', nested: { hash: '•••(24)' }, model: 'opus' });
    const ro = await get('file', { p: 'config.readonly.yaml' }, 'ada');
    expect(ro.body.text).toBe('beeper_token: "•••(29)"\n');
    const dl = await api('file', { p: 'config/config.yaml', download: '1' }, 'ada');
    const dlText = await dl.text();
    expect(dlText).toBe(y.body.text);
    for (const s of SECRETS) expect(`${y.body.text}${j.body.text}${ro.body.text}${dlText}`, s).not.toContain(s);
    expect((await get('file', { p: 'config/config.yaml' }, 'rob')).body).toMatchObject({ text: CONFIG, truncated: false });
    expect((await get('file', { p: 'config/config.yaml' }, 'rob')).body.masked).toBeUndefined();
    expect((await get('file', { p: `conversations/http/${A}/usuario.json` }, 'ada')).body.masked).toBeUndefined();
  });

  it('a config file that does not parse cannot be masked: it needs root', async () => {
    const { get } = await limb();
    const r = await get('file', { p: 'config/broken.yaml' }, 'ada');
    expect(r.status).toBe(401);
    expect(r.realm).toBe(realm('root'));
    expect((await get('file', { p: 'config/broken.yaml' }, 'rob')).body.text).toBe('a: [unclosed\n');
  });

  it('root reads secrets/ as it is', async () => {
    const { get, api } = await limb();
    expect((await get('file', { p: 'secrets/telegram-main.token' }, 'rob')).body.text).toBe(`${TELEGRAM}\n`);
    expect(await (await api('file', { p: 'secrets/telegram-main.token', download: '1' }, 'rob')).text()).toBe(`${TELEGRAM}\n`);
    expect((await get('tree', { p: 'secrets' }, 'rob')).body.entries.map((e) => e.name)).toEqual(['telegram-main.token']);
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

  it('a link out of EGPT_HOME is refused for everyone; a link to a higher path needs that path\'s level', async () => {
    await symlink(outside, at('conversations', 'http', A, 'gavetas', 'fuera'), 'junction');
    await symlink(at('secrets'), at('conversations', 'http', A, 'gavetas', 'llaves'), 'junction');
    await symlink(at('conversations', 'http', A, '.tools'), at('conversations', 'whatsapp', 'familia', 'escondido'), 'junction');
    const { get } = await limb();
    for (const user of Object.keys(USERS)) {
      expect((await get('tree', { p: `conversations/http/${A}/gavetas/fuera` }, user)).status, user).toBe(404);
      expect((await get('file', { p: `conversations/http/${A}/gavetas/fuera/secret.txt` }, user)).status, user).toBe(404);
    }
    for (const user of ['tina', 'dev', 'ada']) {
      const r = await get('file', { p: `conversations/http/${A}/gavetas/llaves/telegram-main.token` }, user);
      expect(r.status, user).toBe(401);
      expect(r.realm, user).toBe(realm('root'));
    }
    expect((await get('file', { p: `conversations/http/${A}/gavetas/llaves/telegram-main.token` }, 'rob')).body).toMatchObject({ path: 'secrets/telegram-main.token', text: `${TELEGRAM}\n` });
    expect((await get('file', { p: 'conversations/whatsapp/familia/escondido/run.sh' }, 'tina')).realm).toBe(realm('devs'));
    expect((await get('file', { p: 'conversations/whatsapp/familia/escondido/run.sh' }, 'dev')).body.text).toBe('echo dev tool\n');
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

  it('no login: 401 in the team realm; a higher path asks in its own realm', async () => {
    const { page, get } = await limb();
    const p = await page(null);
    expect(p.status).toBe(401);
    expect(p.headers.get('www-authenticate')).toBe(realm('team'));
    expect(await p.text()).toMatch(/Sign in with your ayde user/);
    for (const sub of ['search', 'tree']) expect((await get(sub, {}, null)).realm).toBe(realm('team'));
    expect((await get('file', { p: 'secrets/telegram-main.token' }, null)).realm).toBe(realm('root'));
    expect((await get('tree', { p: 'config' }, null)).realm).toBe(realm('admin'));
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
    expect((await get('tree', { p: '' }, 'tina')).status).toBe(401);
    text = `${await userLine('tina', 'admin', pw('tina'))}\n${await userLine('rob', 'root', pw('rob'))}`;
    expect((await get('tree', { p: '' }, 'tina')).body.level).toBe('admin');
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
    expect((await get('tree', { p: '' }, 'ada')).status).toBe(200);
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
    const { get } = await limb({ ayde: { on: true, public_max_level: 'devs' } });
    expect((await get('file', { p: `conversations/http/${A}/.tools/run.sh` }, 'dev', via())).body.text).toBe('echo dev tool\n');
    expect((await get('tree', {}, 'tina', via())).status).toBe(200);
    expect((await get('tree', {}, 'ada', via())).status).toBe(403);
    expect((await get('tree', {}, 'rob', via())).status).toBe(403);
    expect((await get('tree', { p: '' }, 'ada')).status).toBe(200);
    const bad = await limb({ ayde: { on: true, public_max_level: 'god' } });
    expect(bad.lines).toContain("ayde: public_max_level 'god' is not team | devs | admin | root — treated as team");
    expect((await bad.get('tree', {}, 'dev', via())).status).toBe(403);
    expect((await bad.get('tree', {}, 'tina', via())).status).toBe(200);
    expect((await bad.get('tree', {}, 'dev')).status).toBe(200);
  });
});

describe('limbs.http.ayde — the page, search and audit', () => {
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

  it('search: website conversations by username (any case, part of it), optionally abrin; newest first; a shortcut into the tree', async () => {
    const { get, lines } = await limb();
    const r = await get('search', { q: 'MLOP' }, 'tina');
    expect(r.body).toMatchObject({ user: 'tina', level: 'team' });
    expect(r.body.conversations.map((c) => c.path)).toEqual([`conversations/http/${A}`, `conversations/http/${B}`]);
    expect(r.body.conversations[0]).toMatchObject({ id: A, usuario: { username: 'mlopez', abrin: 'IEV', short_name: 'María López' } });
    expect((await get('search', { q: '', abrin: 'csj' }, 'tina')).body.conversations.map((c) => c.id)).toEqual([C]);
    expect((await get('search', { q: '' }, 'tina')).body.conversations.map((c) => c.id)).toEqual([A, C, D, B]);
    expect(lines).toContain('ayde: tina (team) searched "mlop"');
  });

  it('audit: every list, view and download in the log; inside a conversation also its admin-access.log; refusals logged; no contents', async () => {
    const { get, api, lines } = await limb();
    await get('tree', { p: `conversations/http/${A}` }, 'tina');
    await get('file', { p: `conversations/http/${A}/.tools/run.sh` }, 'dev');
    await api('file', { p: `conversations/http/${A}/gavetas/foto.bin`, download: '1' }, 'tina');
    await get('tree', { p: 'conversations/http' }, 'tina');
    await get('file', { p: 'config/config.yaml' }, 'ada');
    await get('file', { p: `conversations/http/${A}/.secrets/db.env` }, 'tina');
    const log = await readFile(at('conversations', 'http', A, 'admin-access.log'), 'utf8');
    expect(log).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+ tina \\(team\\) listed conversations/http/${A}/$`, 'm'));
    expect(log).toMatch(new RegExp(`dev \\(devs\\) viewed conversations/http/${A}/\\.tools/run\\.sh$`, 'm'));
    expect(log).toMatch(new RegExp(`tina \\(team\\) downloaded conversations/http/${A}/gavetas/foto\\.bin$`, 'm'));
    expect(log.trim().split('\n')).toHaveLength(3);
    expect(lines).toContain('ayde: tina (team) listed conversations/http/');
    expect(lines).toContain('ayde: ada (admin) viewed config/config.yaml');
    expect(lines).toContain(`ayde: tina (team) refused conversations/http/${A}/.secrets/db.env — needs root`);
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
