// secrets-tunnel.test.mjs — /<handle> secret over a cloudflared quick tunnel (tools/screen-tunnel.mjs, the one the browser
// screens use): the tunnel opens with the first session and closes with the last (end, expiry, five wrong codes); the
// tunnel's door serves ONLY /secret/<token>/… (nothing else of this node is reachable through the public URL); the
// claim stays inactive until the chat confirms; wrong-token hits are rate-limited, logged, nosniff; and the cloudflared
// download is pinned and checksummed for linux-amd64 and windows-amd64.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScreenTunnel, CLOUDFLARED_VERSION, CLOUDFLARED_ASSETS } from '../src/tools/screen-tunnel.mjs';
import { createSecretSessions, createSecretsPage, createSecretsDoor, createSecretLink, secretScreens, SECRET_KEY } from '../src/bridges/http-secrets.mjs';
import { startHttpBridge, json, readBody } from '../src/bridges/http.mjs';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

let home, cleanup;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'egpt-secrets-tunnel-')); cleanup = []; });
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); await rm(home, { recursive: true, force: true }); });

// A raw GET/POST: fetch would normalise the path (../, //) and hide what the door really answers.
const raw = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    const parts = [];
    res.on('data', (b) => parts.push(b));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});

// The whole thing, with a fake cloudflared: spawn records the args and prints a URL; timers by hand.
async function world({ audits = [], logs = [] } = {}) {
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin', 'cloudflared'), '');
  const procs = new Map(), spawns = [], kills = [];
  let pid = 700, expire = new Map(), clock = 1_000_000, ticks = [];
  let link = null;
  const sessions = createSecretSessions({
    now: () => clock,
    timer: (fn) => { const t = { fn }; expire.set(t, fn); return t; }, untimer: (t) => { expire.delete(t); },
    onOpened: (s) => audits.push({ action: 'opened', who: s.who }),
    onEnd: (s, n) => link?.ended(s, n),
  });
  const page = createSecretsPage({ home, sessions, base: '/', json, readBody, audit: (a) => audits.push(a), now: () => clock, log: (m) => logs.push(m) });
  const door = createSecretsDoor({ page, json });
  const tunnel = createScreenTunnel({
    egptHome: home, stateDir: 'secret-link', platform: 'linux', arch: 'x64', screens: secretScreens({ door, sessions }), graceMs: 10_000, idleMs: 60_000, pollMs: 5_000,
    spawn: (bin, args, opts) => {
      const p = ++pid;
      procs.set(p, [bin, ...args]); spawns.push(args);
      writeSync(opts.stdio[1], `INF |  https://quick-${p}.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0\n`);
      return { pid: p, on() {}, unref() {} };
    },
    argvOf: (p) => procs.get(p) ?? [], kill: (p) => { kills.push(p); procs.delete(p); },
    setInterval: (fn) => { const t = { fn }; ticks.push(t); return t; }, clearInterval: (t) => { ticks = ticks.filter((x) => x !== t); },
    fetch: async () => { throw new Error('no network in tests'); },
  });
  link = createSecretLink({ sessions, door, tunnel, httpLimb: () => false });
  cleanup.push(() => door.stop());
  const ask = (n = 'ana') => link.open({ who: n, operator: `@${n}`, chatId: '!c' });
  const tokenOf = (r) => /\/secret\/([A-Za-z0-9_-]{43})/.exec(r.url)[1];
  return { sessions, door, tunnel, link, spawns, kills, ask, tokenOf, audits, logs, advance: (ms) => { clock += ms; }, expireAll: () => { for (const fn of [...expire.values()]) fn(); }, tick: (ms) => { for (let i = 0; i < ms / 5000; i++) for (const t of [...ticks]) t.fn(); }, procs };
}

describe('the tunnel lives as long as the session', () => {
  it('opens with the first session, pointed at the door (loopback), under its own state dir; the link is <tunnel>/secret/<token>', async () => {
    const w = await world();
    const r = await w.ask();
    expect(w.spawns).toEqual([['tunnel', '--no-autoupdate', '--url', `http://localhost:${w.door.port}`]]);
    expect(r.url).toMatch(/^https:\/\/quick-\d+\.trycloudflare\.com\/secret\/[A-Za-z0-9_-]{43}$/);
    expect(r.via).toBe('tunnel');
    expect(existsSync(join(home, 'state', 'secret-link', SECRET_KEY, 'tunnel.pid'))).toBe(true);
    expect(existsSync(join(home, 'state', 'browser-screens'))).toBe(false);   // the screens' dir is not shared
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(true);
    expect(w.door.isOpen()).toBe(true);
    expect((await raw(w.door.port, `/secret/${w.tokenOf(r)}/`)).status).toBe(200);
  });

  it('a second session shares the tunnel; ending one leaves it, ending the last closes the tunnel and the door', async () => {
    const w = await world();
    const a = await w.ask('ana'), b = await w.ask('bo');
    expect(w.spawns).toHaveLength(1);
    const port = w.door.port;
    w.sessions.end(w.tokenOf(a));
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(true);
    expect((await raw(port, `/secret/${w.tokenOf(b)}/`)).status).toBe(200);
    w.sessions.end(w.tokenOf(b));
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(false);
    expect(w.kills).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.door.isOpen()).toBe(false);
    await expect(raw(port, '/secret/x/')).rejects.toThrow();   // nothing listens any more
  });

  it('closes when the session expires', async () => {
    const w = await world();
    await w.ask();
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(true);
    w.advance(15 * 60_000);
    w.expireAll();
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(false);
    expect(w.sessions.count()).toBe(0);
  });

  it('closes when the page ends the session (End session)', async () => {
    const w = await world();
    const r = await w.ask(), token = w.tokenOf(r);
    const s = w.sessions.check(token);
    const cookie = 'owner-cookie';
    s.claim = createHash('sha256').update(cookie).digest(); s.code = '11112222'; s.confirmed = true;
    const res = await raw(w.door.port, `/secret/${token}/api/end`, { method: 'POST', headers: { Cookie: `secret_session=${cookie}` } });
    expect(res.status).toBe(200);
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(false);
    expect((await raw(w.door.port, `/secret/${token}/`).catch(() => ({ status: 'down' }))).status).not.toBe(200);
  });

  it('a tunnel left behind with no session (a spine restart) closes by itself after its idle time', async () => {
    const w = await world();
    await w.door.start();
    await w.tunnel.open(SECRET_KEY);   // as an adopted one: no live session behind it
    w.tick(55_000);
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(true);
    w.tick(10_000);
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(false);
  });

  it('a failed start leaves nothing behind: the session is dropped and the door stopped', async () => {
    const w = await world();
    w.tunnel.open = async () => { throw new Error('boom'); };
    await expect(w.ask()).rejects.toThrow('boom');
    expect(w.sessions.count()).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.door.isOpen()).toBe(false);
  });
});

describe('only the secrets page is reachable through the tunnel (the door)', () => {
  it('everything but /secret/<token>/… is 404, with nothing of ayde, the chatbox or the root', async () => {
    const w = await world();
    const r = await w.ask(), token = w.tokenOf(r);
    for (const path of ['/', '/ayde', '/ayde/', `/ayde/secret/${token}/`, '/ayde/say', '/chat/acme/start', '/chat/widget.js', '/secret', '/secrets/x', '/secret../x',
      `/%73ecret/${token}/`, `/secret/${token}/../../ayde/`, '/api/list', '/healthz', '/.env', '/shell', '/metrics']) {
      const res = await raw(w.door.port, path);
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body), path).toEqual({ error: 'not found' });
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
    }
    expect((await raw(w.door.port, `/secret/${token}/`)).status).toBe(200);
    for (const m of ['PUT', 'DELETE', 'PATCH']) expect((await raw(w.door.port, '/ayde/', { method: m })).status).toBe(404);
  });

  it('binds loopback only', async () => {
    const w = await world();
    await w.ask();
    const addr = w.door.port;
    expect(addr).toBeGreaterThan(0);
    const s = (await import('node:net')).createConnection({ host: '127.0.0.1', port: addr });
    await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('error', reject); });
    s.destroy();
  });

  it('next to a running http limb (ayde on), the door answers none of the limb\'s routes', async () => {
    const w = await world();
    const port = await freeSafeHttpPort();
    const limb = await startHttpBridge({ port, clients: { acme: { being: 'ed' } }, home, ayde: { on: true }, aydeRoot: home, aydeUsers: () => null });
    cleanup.push(() => limb.stop());
    const r = await w.ask();
    for (const path of ['/chat/acme/start', '/chat/widget.js', '/ayde/', '/ayde/logout']) {
      const viaLimb = await raw(port, path);
      const viaDoor = await raw(w.door.port, path);
      expect(viaLimb.status, `${path} on the limb`).not.toBe(0);
      expect(viaDoor.status, path).toBe(404);
      expect(JSON.parse(viaDoor.body)).toEqual({ error: 'not found' });
    }
    expect(w.door.port).not.toBe(port);
    expect(r.url).not.toContain(String(port));
  });
});

describe('the claim stays inactive until the chat confirms', () => {
  async function opened() {
    const w = await world();
    const r = await w.ask('ana'), token = w.tokenOf(r), at = (sub = '') => `/secret/${token}${sub}`;
    const claim = await raw(w.door.port, at('/claim'), { method: 'POST' });
    const cookie = { Cookie: claim.headers['set-cookie'][0].split(';')[0] };
    return { w, token, at, claim, cookie, code: w.sessions.check(token).code };
  }

  it('the claim answers 303 with the owner cookie and the page then says "waiting for confirmation in chat" with a random 8-digit code; nothing else works', async () => {
    const { w, token, at, claim, cookie, code } = await opened();
    expect(claim.status).toBe(303);
    expect(claim.headers['set-cookie'][0]).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(code).toMatch(/^\d{8}$/);
    const page = await raw(w.door.port, at(''), { headers: cookie });
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/Waiting for confirmation in chat/);
    expect(page.body).toContain(`secret confirm ${code}`);
    expect(page.body).not.toMatch(/id="value"|api\//);
    for (const sub of ['/api/list', '/api/secret?name=a', '/page.js', '/crypto.js']) expect((await raw(w.door.port, at(sub), { headers: cookie })).status, sub).toBe(403);
    for (const sub of ['/api/save', '/api/purge', '/api/end']) expect((await raw(w.door.port, at(sub), { method: 'POST', headers: cookie, body: JSON.stringify({ name: 'a', value: 'v' }) })).status, sub).toBe(403);
    expect(existsSync(join(home, 'secrets', 'managed', 'a'))).toBe(false);
    expect(w.audits).toEqual([]);
    expect(w.sessions.check(token).confirmed).toBe(false);
  });

  it('codes are random per session', async () => {
    const codes = new Set();
    for (let i = 0; i < 6; i++) { const { code } = await opened(); codes.add(code); }
    expect(codes.size).toBeGreaterThan(1);
  });

  it('a second browser claiming first/after gets nothing; the one that did not claim cannot confirm for it', async () => {
    const { w, at } = await opened();
    expect((await raw(w.door.port, at('/claim'), { method: 'POST' })).status).toBe(404);   // already claimed
    expect((await raw(w.door.port, at(''), { headers: { Cookie: 'secret_session=guess' } })).status).toBe(404);
    expect((await raw(w.door.port, at('/api/list'))).status).toBe(404);
  });

  it('the operator\'s confirm (right code, same chat, same operator) opens the page and the API; the audit line says who', async () => {
    const { w, at, cookie, code } = await opened();
    expect(w.sessions.confirm({ chatId: '!c', operator: '@ana', code })).toEqual({ ok: true, who: 'ana' });
    expect(w.audits).toEqual([{ action: 'opened', who: 'ana' }]);
    expect((await raw(w.door.port, at('/api/list'), { headers: cookie })).status).toBe(200);
    expect((await raw(w.door.port, at(''), { headers: cookie })).body).toContain('id="secret"');
    const save = await raw(w.door.port, at('/api/save'), { method: 'POST', headers: cookie, body: JSON.stringify({ name: 'gh.token', value: 'v1' }) });
    expect(save.status).toBe(200);
    expect(await readFile(join(home, 'secrets', 'managed', 'gh.token'), 'utf8')).toBe('v1\n');
  });

  it('a wrong code, another chat or another operator confirms nothing', async () => {
    const { w, at, cookie, code } = await opened();
    expect(w.sessions.confirm({ chatId: '!c', operator: '@ana', code: '00000000' }).error).toMatch(/not the code/);
    expect(w.sessions.confirm({ chatId: '!other', operator: '@ana', code }).error).toMatch(/no secrets page is waiting/);
    expect(w.sessions.confirm({ chatId: '!c', operator: '@bo', code }).error).toMatch(/no secrets page is waiting/);
    expect((await raw(w.door.port, at('/api/list'), { headers: cookie })).status).toBe(403);
  });

  it('an unconfirmed session expires with the 15 minutes and nothing can then confirm it', async () => {
    const { w, token, code } = await opened();
    w.advance(15 * 60_000);
    expect(w.sessions.confirm({ chatId: '!c', operator: '@ana', code }).error).toMatch(/no secrets page is waiting/);
    expect(w.sessions.check(token)).toBeNull();
    expect(w.tunnel.isOpen(SECRET_KEY)).toBe(false);
  });
});

describe('wrong tokens: logged, rate-limited; every answer nosniff', () => {
  it('logs each unknown token, answers 429 past 20 a minute, and a valid token still works', async () => {
    const logs = [];
    const w = await world({ logs });
    const r = await w.ask(), token = w.tokenOf(r);
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push((await raw(w.door.port, `/secret/${'x'.repeat(42)}${i % 10}/api/list`)).status);
    expect(codes.slice(0, 20).every((c) => c === 404)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429, 429, 429, 429]);
    expect(logs.filter((m) => /unknown or expired token/.test(m))).toHaveLength(20);
    expect(logs.filter((m) => /refusing more/.test(m))).toHaveLength(1);
    expect((await raw(w.door.port, `/secret/${'y'.repeat(43)}/`)).headers['retry-after']).toBe('60');
    expect((await raw(w.door.port, `/secret/${token}/`)).status).toBe(200);   // the live session is not locked out
    w.advance(61_000);
    expect((await raw(w.door.port, `/secret/${'z'.repeat(43)}/`)).status).toBe(404);   // the window passed
  });

  it('the page, its script, the claim and the errors carry X-Content-Type-Options: nosniff', async () => {
    const w = await world();
    const r = await w.ask(), token = w.tokenOf(r);
    const claim = await raw(w.door.port, `/secret/${token}/claim`, { method: 'POST' });
    const cookie = { Cookie: claim.headers['set-cookie'][0].split(';')[0] };
    w.sessions.confirm({ chatId: '!c', operator: '@ana', code: w.sessions.check(token).code });
    for (const [sub, h] of [['', {}], ['/page.js', cookie], ['/crypto.js', cookie], ['/api/list', cookie], ['/api/nope', cookie], ['/api/list', {}], ['/claim', {}]]) {
      const res = await raw(w.door.port, `/secret/${token}${sub}`, { headers: h });
      expect(res.headers['x-content-type-options'], sub).toBe('nosniff');
    }
    expect(claim.headers['x-content-type-options']).toBe('nosniff');
    expect((await raw(w.door.port, `/secret/${'q'.repeat(43)}/`)).headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('cloudflared: a pinned release, windows-amd64 and linux-amd64, SHA-256 checked', () => {
  const bytes = Buffer.from('not really cloudflared');
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const make = async (platform, arch, body = bytes) => {
    const urls = [];
    const h = await mkdtemp(join(tmpdir(), 'egpt-cf-'));
    cleanup.push(() => rm(h, { recursive: true, force: true }));
    const t = createScreenTunnel({
      egptHome: h, stateDir: 'secret-link', platform, arch, screens: { portsOf: () => ({ webPort: 1 }), viewers: () => 0 }, urlWaitMs: 0,
      spawn: () => { throw new Error('stop after the download'); },
      fetch: async (u) => { urls.push(u); return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }; },
    });
    return { t, urls, h };
  };

  it('pins a version and one SHA-256 per platform (the release notes\' list), not releases/latest', () => {
    expect(CLOUDFLARED_VERSION).toBe('2026.11.2');
    expect(CLOUDFLARED_ASSETS['linux-x64']).toMatchObject({ file: 'cloudflared-linux-amd64', sha256: '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf', exe: 'cloudflared' });
    expect(CLOUDFLARED_ASSETS['win32-x64']).toMatchObject({ file: 'cloudflared-windows-amd64.exe', sha256: '555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113', exe: 'cloudflared.exe' });
  });

  for (const [platform, key] of [['linux', 'linux-x64'], ['win32', 'win32-x64']]) {
    it(`${platform}: fetches the pinned asset URL, installs it as ${CLOUDFLARED_ASSETS[key].exe} only when the hash matches`, async () => {
      const saved = CLOUDFLARED_ASSETS[key].sha256;
      CLOUDFLARED_ASSETS[key].sha256 = sha(bytes);
      try {
        const { t, urls, h } = await make(platform, 'x64');
        await expect(t.open('k')).rejects.toThrow('stop after the download');
        expect(urls).toEqual([`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${CLOUDFLARED_ASSETS[key].file}`]);
        expect(await readFile(join(h, 'bin', CLOUDFLARED_ASSETS[key].exe))).toEqual(bytes);
      } finally { CLOUDFLARED_ASSETS[key].sha256 = saved; }
    });

    it(`${platform}: a download that does not match the pinned hash is refused and nothing is written`, async () => {
      const { t, h } = await make(platform, 'x64');
      await expect(t.open('k')).rejects.toThrow(/is not the pinned/);
      expect(existsSync(join(h, 'bin', CLOUDFLARED_ASSETS[key].exe))).toBe(false);
    });
  }

  it('another platform or arch is said, not guessed', async () => {
    const { t, urls } = await make('linux', 'arm64');
    await expect(t.open('k')).rejects.toThrow(/no cloudflared build for linux-arm64/);
    expect(urls).toEqual([]);
  });
});
