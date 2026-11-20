// tests/browser-screens.test.mjs — a screen per browser group, shared by link (plans/2611022204-BROWSER-SCREENS.md;
// operator 2026-11-02, NU Ops #96-#121). Hermetic: fake spawns, fake /proc, a temp EGPT_HOME, the fake chrome-host.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, writeSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createBrowserScreens, allocateDisplay, sessionsOn, portsOf } from '../src/tools/browser-screens.mjs';
import { createScreenTunnel, linkOf } from '../src/tools/screen-tunnel.mjs';
import { createCommands, CHROME_BRAIN_PROFILE } from '../src/spine/commands.mjs';
import { readBrowserGroups, setBrowserGroup } from '../src/rooms-file.mjs';
import * as YAML from 'yaml';
import { fakePipeChrome } from './fake-pipe-chrome.mjs';

const homes = [];
const tempHome = () => { const h = mkdtempSync(join(tmpdir(), 'egpt-screens-')); homes.push(h); return h; };
afterEach(() => { while (homes.length) rmSync(homes.pop(), { recursive: true, force: true }); });

// A fake OS: spawn records argv under a pid, /proc answers from it, every started port listens.
function fakeOs() {
  const procs = new Map();
  let pid = 500;
  const listening = new Set();
  const row = (port, st) => `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${st} 0`;
  return {
    procs, listening,
    spawn: (bin, args) => {
      const p = ++pid;
      procs.set(p, [bin, ...args]);
      const port = args.find((a) => /^\d+$/.test(a)) ?? args.find((a) => /^127\.0\.0\.1:\d+$/.test(a))?.split(':')[1];
      if (port) listening.add(Number(port));
      return { pid: p, on() {}, unref() {} };
    },
    argvOf: (p) => procs.get(p) ?? [],
    kill: (p) => { procs.delete(p); },
    tcp: () => ['  sl local rem st\n' + [...listening].map((p) => row(p, '0A')).join('\n')],
    has: () => true,
    exists: (p) => p.startsWith('/tmp/.X11-unix/') || p === '/usr/share/novnc' || existsSync(p),
  };
}
const screensOn = (home, os = fakeOs()) => ({ os, screens: createBrowserScreens({ egptHome: home, platform: 'linux', ...os }) });

describe('a display per group, kept', () => {
  it('allocateDisplay: a group keeps its number; a new one takes the lowest free from :100', () => {
    expect(allocateDisplay({}, 'brain')).toBe(100);
    expect(allocateDisplay({ brain: { display: 100 } }, 'work')).toBe(101);
    expect(allocateDisplay({ brain: { display: 100 }, work: { display: 101 } }, 'work')).toBe(101);
    expect(allocateDisplay({ work: { display: 101 } }, 'shared')).toBe(100);
    expect(portsOf(100)).toEqual({ rfbPort: 5901, webPort: 6081 });
  });

  it('ensure starts Xvfb, x11vnc (localhost, shared, view-only passwords) and noVNC on the group\'s own display; the number survives a restart and a close', async () => {
    const home = tempHome();
    const { os, screens } = screensOn(home);
    expect(screens.available()).toBe(true);
    const [brain, work] = await Promise.all([screens.ensure('brain'), screens.ensure('work')]);
    expect(brain).toEqual({ group: 'brain', display: ':100', rfbPort: 5901, webPort: 6081 });
    expect(work.display).toBe(':101');
    const argv = [...os.procs.values()];
    expect(argv).toContainEqual(['Xvfb', ':100', '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-nolisten', 'local']);
    const vnc = argv.find((a) => a[0] === 'x11vnc' && a.includes(':100'));
    expect(vnc).toEqual(expect.arrayContaining(['-localhost', '-shared', '-forever', '-rfbport', '5901', '-passwdfile', `read:${join(home, 'state', 'browser-screens', 'brain', 'passwd')}`]));
    expect(argv).toContainEqual(['websockify', '--web', '/usr/share/novnc', '127.0.0.1:6081', 'localhost:5901']);
    const pw = screens.passwords('brain');
    expect(pw.control).toMatch(/^[\w-]{8}$/);
    expect(readFileSync(join(home, 'state', 'browser-screens', 'brain', 'passwd'), 'utf8')).toBe(`${pw.control}\n__BEGIN_VIEWONLY__\n${pw.view}\n`);

    const n = os.procs.size;
    const again = createBrowserScreens({ egptHome: home, platform: 'linux', ...os });   // a spine restart
    expect(await again.ensure('brain')).toMatchObject({ display: ':100' });
    expect(os.procs.size).toBe(n);                                                      // nothing restarted
    expect(again.close('brain')).toBe(true);
    expect(again.close('brain')).toBe(false);
    expect(os.procs.size).toBe(n - 3);
    expect((await again.ensure('shared')).display).toBe(':102');
    expect((await again.ensure('brain')).display).toBe(':100');
  });

  it('close with keepDisplay (the idle timer) stops x11vnc and noVNC only: the Xvfb, and the Chrome on it, stay; ensure brings the viewing side back', async () => {
    const { os, screens } = screensOn(tempHome());
    await screens.ensure('work');
    expect(screens.close('work', { keepDisplay: true })).toBe(true);
    expect([...os.procs.values()].map((a) => a[0])).toEqual(['Xvfb']);
    await screens.ensure('work');
    expect([...os.procs.values()].map((a) => a[0]).sort()).toEqual(['Xvfb', 'websockify', 'x11vnc']);
  });

  it('idleMs: xprintidle on the group\'s display (ms since the last X input); a broken probe throws, never a made-up number', async () => {
    const seen = [];
    const { screens } = (() => { const os = fakeOs(); return { screens: createBrowserScreens({ egptHome: tempHome(), platform: 'linux', ...os, xIdle: (d) => { seen.push(d); if (d !== ':100') throw new Error('xprintidle: not found'); return 4200; } }) }; })();
    expect(() => screens.idleMs('brain')).toThrow(/no screen/);
    await screens.ensure('brain');
    await screens.ensure('work');
    expect(screens.idleMs('brain')).toBe(4200);
    expect(seen).toEqual([':100']);
    expect(() => screens.idleMs('work')).toThrow(/xprintidle/);
  });

  it('viewers = established sessions on the x11vnc port only (not noVNC\'s)', () => {
    const t = ['  sl local rem st\n'
      + '   0: 0100007F:170D 0100007F:9C40 01 0\n'      // x11vnc :5901 ← a viewer
      + '   1: 0100007F:9C40 0100007F:170D 01 0\n'      // websockify's end of the same session
      + '   2: 0100007F:17C1 0100007F:9C41 01 0\n'      // cloudflared keep-alive on noVNC :6081
      + '   3: 0100007F:170D 00000000:0000 0A 0'];
    expect(sessionsOn(t, 5901)).toBe(1);
    expect(sessionsOn(t, 5901, '0A')).toBe(1);
  });

  it('a Windows node, or one with no Xvfb, has no screens', () => {
    expect(createBrowserScreens({ egptHome: tempHome(), platform: 'win32', has: () => true, exists: () => true }).available()).toBe(false);
    expect(createBrowserScreens({ egptHome: tempHome(), platform: 'linux', has: (b) => b !== 'Xvfb', exists: () => true }).available()).toBe(false);
  });
});

// The tunnel: cloudflared prints its URL, the watcher closes on viewers. Timers are driven by hand.
function tunnelWorld({ viewers = () => 0 } = {}) {
  const home = tempHome();
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'cloudflared'), '');
  const procs = new Map(), spawns = [], fresh = [];
  let pid = 900, ticks = [];
  const screens = {
    portsOf: () => ({ rfbPort: 5901, webPort: 6081 }),
    viewers: (g) => viewers(g),
    passwords: (g, { fresh: f = false } = {}) => { if (f) fresh.push(g); return { control: `c${fresh.length}`, view: `v${fresh.length}` }; },
  };
  const tunnel = createScreenTunnel({
    egptHome: home, screens, graceMs: 120_000, idleMs: 600_000, pollMs: 5_000,
    spawn: (bin, args, opts) => {
      const p = ++pid;
      procs.set(p, [bin, ...args]);
      spawns.push(args);
      writeSync(opts.stdio[1], `INF |  https://quick-${p}.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0\n`);
      return { pid: p, on() {}, unref() {} };
    },
    argvOf: (p) => procs.get(p) ?? [],
    kill: (p) => { procs.delete(p); },
    setInterval: (fn) => { const t = { fn }; ticks.push(t); return t; },
    clearInterval: (t) => { ticks = ticks.filter((x) => x !== t); },
    fetch: async () => { throw new Error('no network in tests'); },
  });
  const advance = (ms) => { for (let i = 0; i < ms / 5_000; i++) for (const t of [...ticks]) t.fn(); };
  return { tunnel, spawns, fresh, advance, procs };
}

describe('the link (a quick tunnel per group)', () => {
  it('opens once per group and is reused while open; each opening has fresh passwords', async () => {
    const w = tunnelWorld();
    const a = await w.tunnel.open('brain');
    expect(a).toEqual({ url: 'https://quick-901.trycloudflare.com', control: 'c1', view: 'v1', reused: false });
    expect(w.spawns[0]).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://localhost:6081']);
    expect(await w.tunnel.open('brain')).toEqual({ ...a, reused: true, control: 'c1', view: 'v1' });
    expect(w.spawns).toHaveLength(1);
    expect(w.tunnel.close('brain')).toBe(true);
    expect(w.tunnel.isOpen('brain')).toBe(false);
    const b = await w.tunnel.open('brain');
    expect(b).toMatchObject({ url: 'https://quick-902.trycloudflare.com', control: 'c2', view: 'v2', reused: false });
    expect(w.fresh).toEqual(['brain', 'brain']);
  });

  it('IDLE: nobody ever connects → closes after 600 s, not before', async () => {
    const w = tunnelWorld();
    await w.tunnel.open('brain');
    w.advance(595_000);
    expect(w.tunnel.isOpen('brain')).toBe(true);
    w.advance(5_000);
    expect(w.tunnel.isOpen('brain')).toBe(false);
  });

  it('GRACE: no time limit while watched; closes 120 s after the last viewer leaves', async () => {
    let n = 0;
    const w = tunnelWorld({ viewers: () => n });
    await w.tunnel.open('brain');
    w.advance(300_000);
    n = 2;
    w.advance(3_600_000);                       // an hour watched: still open
    expect(w.tunnel.isOpen('brain')).toBe(true);
    n = 0;
    w.advance(115_000);
    expect(w.tunnel.isOpen('brain')).toBe(true);
    n = 1;                                      // someone came back: the grace starts over
    w.advance(5_000);
    n = 0;
    w.advance(115_000);
    expect(w.tunnel.isOpen('brain')).toBe(true);
    w.advance(5_000);
    expect(w.tunnel.isOpen('brain')).toBe(false);
  });

  it('linkOf: noVNC autoconnects, scaled, view-only or not, the password url-encoded', () => {
    expect(linkOf('https://a.trycloudflare.com', 'a+b/c=', true)).toBe('https://a.trycloudflare.com/vnc.html?autoconnect=1&resize=scale&view_only=1&password=a%2Bb%2Fc%3D');
    expect(linkOf('https://a.trycloudflare.com', 'x', false)).toMatch(/view_only=0&password=x$/);
  });
});

// /<handle> browser [all|stop|close] [group] and /browser refresh, over fake screens and a fake tunnel.
const STATE = { contacts: { whatsapp: { '!work': { slug: 'Work chat-2601010000' }, '!edu': { slug: 'Edu chat-2601010000' }, '!brain': { slug: 'Brain chat-2601010000' }, '!admin': { slug: 'eGPT Admin-2601010000' }, '!other': { slug: 'Other chat-2601010000' } } } };
const GROUPS = { work: ['Work chat'], edu: ['Edu chat'], brain: ['Brain chat'] };
const NAMES = { '!work': 'Work chat', '!edu': 'Edu chat', '!brain': 'Brain chat', '!other': 'Other chat' };
const URL = 'https://q.trycloudflare.com';
function build({ available = true, admin = { chatId: '!admin' }, chromeHost, profileHolder = () => null, killProcessTree = () => {}, chromeProcesses = () => [], chrome = {}, profiles = [], freeMem = 8192, screenCloseThrows = null, xIdle = () => Infinity, rssOf = () => null, platform = 'linux', screensOpen = null, linked = null, clock = null } = {}) {
  const browsersFile = join(tempHome(), 'browsers.yaml');   // the real chat-to-group table, read and written as the spine does
  writeFileSync(browsersFile, YAML.stringify({ groups: GROUPS }));
  const tableIO = { path: browsersFile, read: (p, e) => readFile(p, e) };   // no stat cache: tests rewrite within a tick
  const fake = fakePipeChrome({ listTabs: async () => [] });
  const ops = [];
  const browserScreens = {
    available: () => available,
    ensure: async (g) => { ops.push(`screen:${g}`); return { group: g, display: ':101' }; },
    idleMs: (g) => xIdle(g),
    ...(screensOpen && { open: () => screensOpen }),
    close: (g, o) => { if (screenCloseThrows) throw new Error(screenCloseThrows); ops.push(`screen-close:${g}${o?.keepDisplay ? ':display-kept' : ''}`); return true; },
  };
  let open = false;
  const screenTunnel = {
    open: async (g) => { ops.push(`link:${g}`); const reused = open; open = true; return { url: URL, control: 'CTL', view: 'VIEW', reused }; },
    close: (g) => { ops.push(`link-close:${g}`); const was = linked ? linked.has(g) : open; open = false; return was; },
    isOpen: (g) => (linked ? linked.has(g) : open),
  };
  const sent = [], logs = [];
  const cmds = createCommands({
    getConfig: () => ({ node_name: 'nu', agents: { n: {} }, chrome: { bin: '/x/chrome', ...chrome } }),
    chromeHost: chromeHost === undefined ? fake.chromeHost : chromeHost,
    profileHolder, killProcessTree, chromeProcesses, freeMem: () => freeMem * 1024 * 1024, rssOf, platform,
    browserGroups: () => readBrowserGroups(tableIO), assignBrowserGroup: (name, g) => setBrowserGroup(name, g, { path: browsersFile }), profileFolders: () => profiles,
    loadState: async () => STATE, writeState: async () => {},
    send: async (chatId, text) => sent.push({ chatId, text }),
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
    ...(clock && { now: clock }), browserScreens, screenTunnel, adminChat: async () => admin, onChromeLog: (m) => logs.push(m),
  });
  const run = (chatId, body) => cmds.run({ chatId, chatName: NAMES[chatId] ?? 'eGPT Admin', surface: 'whatsapp', authorized: true, commandHandle: 'n', body });
  return { cmds, run, sent, ops, logs, table: () => readBrowserGroups(tableIO), ...fake };
}
const VIEW_LINK = `${URL}/vnc.html?autoconnect=1&resize=scale&view_only=1&password=VIEW`;
const CONTROL_LINK = `${URL}/vnc.html?autoconnect=1&resize=scale&view_only=0&password=CTL`;

describe('/<handle> browser — who gets which link', () => {
  it('in a chat: the group\'s Chrome opens on its screen; the chat gets the VIEW link, the admin channel the CONTROL link', async () => {
    const w = build();
    await w.run('!work', '/browser');
    expect(w.calls[0]).toEqual({ group: 'work', profileDir: expect.stringMatching(/work$/), bin: '/x/chrome', argv: expect.any(Array), display: ':101' });
    expect(w.sent).toEqual([
      { chatId: '!admin', text: `work browser, control (asked in Work chat): ${CONTROL_LINK}` },
      { chatId: '!work', text: expect.stringContaining(`work browser, view only: ${VIEW_LINK}\nThe control link is in the admin channel.`) },
    ]);
    expect(w.sent[1].text).not.toContain('CTL');
  });

  it('typed in the admin channel itself: both links land there, nothing goes anywhere else', async () => {
    const w = build();
    await w.run('!admin', '/browser');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ chatId: '!admin' });
    expect(w.sent[0].text).toContain(`view only: ${VIEW_LINK}\ncontrol: ${CONTROL_LINK}`);
  });

  it('admin_channel unset: refuses and says why — no screen, no Chrome, no link', async () => {
    const w = build({ admin: { reason: 'unset' } });
    await w.run('!work', '/browser');
    expect(w.sent).toEqual([{ chatId: '!work', text: 'no link: the control link goes to the admin channel and admin_channel is not set in config.yaml — set it, or /n browser all gives this chat the control link' }]);
    expect(w.ops).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('`all`: the CONTROL link in the chat — anyone with it drives; the admin channel is not involved', async () => {
    const w = build({ admin: { reason: 'unset' } });
    await w.run('!work', '/browser all');
    expect(w.sent).toEqual([{ chatId: '!work', text: expect.stringContaining(`work browser — anyone with this link can drive it: ${CONTROL_LINK}`) }]);
  });

  it('`stop`: closes the link only; `close`: the Chrome, the link and the screen', async () => {
    const w = build();
    await w.run('!work', '/browser all');
    await w.run('!work', '/browser stop');
    expect(w.sent.at(-1).text).toBe('closed the work link; the browser stays.');
    expect(w.handles[0].child.killed).toBe(false);
    await w.run('!work', '/browser stop');
    expect(w.sent.at(-1).text).toBe('no work link is open.');
    await w.run('!work', '/browser all');
    await w.run('!work', '/browser close');
    expect(w.handles[0].child.killed).toBe(true);
    expect(w.ops.slice(-2)).toEqual(['link-close:work', 'screen-close:work']);
    expect(w.sent.at(-1).text).toBe('closed the work browser: its Chrome, its link, its screen. It starts again on next need.');
  });

  it('`close` takes a sign-in window too', async () => {
    const w = build();
    await w.run('!work', '/browser refresh');
    await w.run('!work', '/browser close');
    expect(w.events).toEqual(['plain:work', 'kill:work']);
  });

  it('`close` kills an untracked Chrome that holds the profile (a sign-in window left by a restarted daemon)', async () => {
    let held = 'pid 4242';
    const killed = [];
    let dir;
    const w = build({ profileHolder: (d) => { dir = d; return held; }, killProcessTree: (pid) => { killed.push(pid); held = null; }, chromeProcesses: () => [{ pid: 4242, cmd: `google-chrome --user-data-dir=${dir}` }] });
    await w.run('!work', '/browser close');
    expect(killed).toEqual([4242]);
    expect(w.sent.at(-1).text).toBe('closed the work browser: its Chrome, its screen. It starts again on next need.');
  });

  it('`close` does not kill a stale-lock pid that is no longer a Chrome on this profile (pid reuse)', async () => {
    const killed = [];
    const w = build({ profileHolder: () => 'pid 4242', killProcessTree: (pid) => killed.push(pid), chromeProcesses: () => [{ pid: 4242, cmd: '/usr/bin/sleep 100' }] });
    await w.run('!work', '/browser close');
    expect(killed).toEqual([]);
    expect(w.sent.at(-1).text).toBe('closed the work browser: its screen. It starts again on next need.');   // no "its Chrome", no "could not be closed"
  });

  it('`close` with a holder that names no pid (Windows) kills nothing and says so', async () => {
    const killed = [];
    const w = build({ profileHolder: () => 'EBUSY', killProcessTree: (pid) => killed.push(pid) });
    await w.run('!work', '/browser close');
    expect(killed).toEqual([]);
    expect(w.sent.at(-1).text).toContain('could not be closed by pid');
  });

  it('`close` of a tracked Chrome still goes through chromeHost.kill, never the pid kill', async () => {
    const killed = [];
    const w = build({ killProcessTree: (pid) => killed.push(pid) });
    await w.run('!work', '/browser all');
    await w.run('!work', '/browser close');
    expect(w.handles[0].child.killed).toBe(true);
    expect(killed).toEqual([]);
  });

  it('/browser refresh opens the plain window on the group\'s screen and answers with its link, not "Open VNC (:6080)"', async () => {
    const w = build();
    await w.run('!work', '/browser refresh accounts.google.com');
    expect(w.plain[0]).toMatchObject({ group: 'work', display: ':101' });
    expect(w.sent.at(-1).text).toMatch(/^My browser for work was not open\. A normal Chrome window opened on nu at https:\/\/accounts\.google\.com\/: .*\nwork browser, view only: /);
    expect(w.sent.at(-1).text).not.toMatch(/VNC/);
    expect(w.sent.find((m) => m.chatId === '!admin').text).toContain(CONTROL_LINK);
  });

  it('a desktop node: "open as a normal window on this PC" — the Chrome opens there, no screen, no link', async () => {
    const w = build({ available: false });
    await w.run('!work', '/browser');
    expect(w.sent).toEqual([{ chatId: '!work', text: 'the "work" browser is open as a normal window on nu — you are at that PC: no screen to share, no link.' }]);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).not.toHaveProperty('display');
    expect(w.ops).toEqual([]);
    await w.run('!work', '/browser refresh');
    expect(w.plain[0]).not.toHaveProperty('display');
    expect(w.sent.at(-1).text).not.toMatch(/VNC|link/);
  });
});

// CHANGE 1 — the browser inactivity timer (operator: "a browser inactivity timer, with an option to keep on").
// The signal is the group's `lastUsedAt` — the spine's own record of its last browser use (a being's tool call, /tabs,
// /open, /browser…), the one eviction already ranks by. No viewer count: a forgotten tab does not keep a screen up.
const MIN = 60_000;
describe('/<handle> browser — the idle timer closes a screen, `keep` holds it', () => {
  const clock = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const idleLines = (w) => w.sent.filter((m) => /screen closed after/.test(m.text));
  afterEach(() => vi.useRealTimers());

  it('default 30 min: the link and the VNC close, the Chrome stays, ONE line lands in the chat the link went to', async () => {
    clock();
    const w = build();
    await w.run('!work', '/browser');
    vi.advanceTimersByTime(29 * MIN);
    expect(w.ops).not.toContain('link-close:work');
    vi.advanceTimersByTime(2 * MIN);
    expect(w.ops.slice(-2)).toEqual(['link-close:work', 'screen-close:work:display-kept']);
    expect(w.handles[0].child.killed).toBe(false);
    vi.advanceTimersByTime(5 * 60 * MIN);
    expect(idleLines(w)).toEqual([{ chatId: '!work', text: 'browser work screen closed after 30 min idle' }]);
  });

  it('browser activity through the spine (a /tabs) starts the count over', async () => {
    clock();
    const w = build();
    await w.run('!work', '/browser');
    vi.advanceTimersByTime(25 * MIN);
    await w.run('!work', '/tabs');
    vi.advanceTimersByTime(25 * MIN);
    expect(w.ops).not.toContain('link-close:work');
    vi.advanceTimersByTime(6 * MIN);
    expect(w.ops).toContain('link-close:work');
  });

  // OPERATOR 2026-11-20: "click counts, and typing in browser": the X display's input idle time (xprintidle).
  it('human input on the group\'s X display (a click, a key through VNC) starts the count over', async () => {
    clock();
    let lastInput = Date.now();
    const w = build({ xIdle: () => Date.now() - lastInput });
    await w.run('!work', '/browser');
    vi.advanceTimersByTime(25 * MIN);
    lastInput = Date.now();                     // someone clicks in the viewer: no spine call at all
    vi.advanceTimersByTime(25 * MIN);
    expect(w.ops).not.toContain('link-close:work');
    vi.advanceTimersByTime(6 * MIN);
    expect(w.ops).toContain('link-close:work');
  });

  it('a probe that fails fails SAFE: the screen stays open, and the failure is logged ONCE, loudly', async () => {
    clock();
    const w = build({ xIdle: () => { throw new Error('xprintidle: not found'); } });
    await w.run('!work', '/browser');
    vi.advanceTimersByTime(3 * 60 * MIN);
    expect(w.ops).not.toContain('link-close:work');
    expect(w.logs.filter((l) => /xprintidle: not found/.test(l))).toHaveLength(1);
    expect(w.logs.join('\n')).toMatch(/work.*idle probe.*active/i);
  });

  it('the group is evictable again once the link closes (a watched one is pinned)', async () => {
    clock();
    const w = build({ freeMem: 0 });
    await w.run('!work', '/browser');
    await w.run('!edu', '/chrome');
    expect(w.events).not.toContain('kill:work');
    vi.advanceTimersByTime(31 * MIN);
    await w.run('!brain', '/chrome');
    await w.run('!admin', '/chrome');
    expect(w.events).toContain('kill:work');
  });

  it('chrome.idle_minutes sets N; 0 and "keep" mean never', async () => {
    clock();
    const five = build({ chrome: { idle_minutes: 5 } });
    await five.run('!work', '/browser');
    vi.advanceTimersByTime(6 * MIN);
    expect(idleLines(five)[0].text).toBe('browser work screen closed after 5 min idle');
    for (const idle_minutes of [0, 'keep']) {
      const w = build({ chrome: { idle_minutes } });
      await w.run('!work', '/browser');
      vi.advanceTimersByTime(48 * 60 * MIN);
      expect(w.ops).not.toContain('link-close:work');
    }
  });

  it('`keep` (also with `all`) holds the link until /browser close; the next launch without it is on the timer again', async () => {
    clock();
    const w = build();
    await w.run('!work', '/browser keep');
    vi.advanceTimersByTime(10 * 60 * MIN);
    expect(w.ops).not.toContain('link-close:work');
    await w.run('!work', '/browser close');
    await w.run('!work', '/browser all');
    vi.advanceTimersByTime(31 * MIN);
    expect(idleLines(w)).toHaveLength(1);
    await w.run('!work', '/browser all keep');
    vi.advanceTimersByTime(10 * 60 * MIN);
    expect(idleLines(w)).toHaveLength(1);
  });

  it('a close that fails is loud: logged and said in the chat, not swallowed', async () => {
    clock();
    const w = build({ screenCloseThrows: 'EPERM' });
    await w.run('!work', '/browser');
    vi.advanceTimersByTime(31 * MIN);
    expect(w.logs.join('\n')).toMatch(/work.*idle.*EPERM/s);
    expect(w.sent.at(-1)).toEqual({ chatId: '!work', text: expect.stringMatching(/browser work screen did not close after 30 min idle — EPERM/) });
  });
});

// OPERATOR 2026-11-20: "name defaults to 'shared'; if a name is given it is used, and the group joins the
// groups-per-browser table, so the next '/edu browser [all]' goes to the group's profile". Group name = profile dir
// name; the table is config/browsers.yaml.
describe('/<handle> browser [all] [<profile>] — shared by default, a named profile is remembered', () => {
  const dirOf = (name) => expect.stringMatching(new RegExp(`[\\\\/]${name}$`));
  const members = async (w, g) => (await w.table())[g] ?? [];

  it('no profile, chat not in the table: `shared`, created on first use without `new`', async () => {
    const w = build();
    await w.run('!other', '/browser');
    expect(w.calls[0]).toMatchObject({ group: 'shared', profileDir: dirOf('shared') });
    expect(await w.table()).toEqual(GROUPS);      // nothing recorded for a bare command
  });

  it('no profile, chat in the table: its group, as before', async () => {
    const w = build();
    await w.run('!work', '/browser');
    expect(w.calls[0]).toMatchObject({ group: 'work', profileDir: dirOf('work') });
  });

  it('a named profile is used AND recorded: the chat leaves its old group, and the next bare /browser uses it', async () => {
    const w = build({ profiles: ['lola'] });
    await w.run('!work', '/browser all lola');
    expect(w.calls[0]).toMatchObject({ group: 'lola', profileDir: dirOf('lola'), display: ':101' });
    expect(w.ops.at(-1)).toBe('link:lola');
    expect(await members(w, 'lola')).toEqual(['Work chat']);
    expect(await members(w, 'work')).toEqual([]);
    await w.run('!work', '/browser close');
    await w.run('!work', '/browser all');
    expect(w.calls.at(-1)).toMatchObject({ group: 'lola', profileDir: dirOf('lola') });
  });

  it('`/browser shared` un-assigns: the chat is in `shared` again', async () => {
    const w = build();
    await w.run('!work', '/browser lola new');
    await w.run('!work', '/browser close');
    await w.run('!work', '/browser shared');
    expect(w.calls.at(-1)).toMatchObject({ group: 'shared', profileDir: dirOf('shared') });
    expect(await members(w, 'lola')).toEqual([]);
    expect(await members(w, 'shared')).toEqual(['Work chat']);
  });

  it('an unknown non-default profile is refused unless `new`; nothing starts, nothing is recorded', async () => {
    const w = build({ profiles: ['lola'] });
    await w.run('!work', '/browser nope');
    expect(w.sent.at(-1).text).toContain('no profile "nope"');
    expect(w.sent.at(-1).text).toContain('browser nope new');
    expect(w.calls).toEqual([]);
    expect(w.ops).toEqual([]);
    expect(await w.table()).toEqual(GROUPS);
    await w.run('!work', '/browser nope new');
    expect(w.calls[0]).toMatchObject({ group: 'nope', profileDir: dirOf('nope') });
    expect(await members(w, 'nope')).toEqual(['Work chat']);
  });

  it('the profile obeys isSafeGroupName: no paths, no traversal, even with `new`', async () => {
    const w = build();
    for (const bad of ['../x', 'a/b', '..', 'a\\b', '.hidden']) {
      await w.run('!work', `/browser ${bad} new`);
      expect(w.sent.at(-1).text).toMatch(/^usage:/);
    }
    expect(w.calls).toEqual([]);
    expect(await w.table()).toEqual(GROUPS);
  });

  it('a profile another group holds is refused and not recorded (the brain Chrome\'s dir)', async () => {
    const w = build({ chrome: { profile_dir: join(dirname(CHROME_BRAIN_PROFILE), 'lola') }, profiles: ['lola'] });
    await w.run('!work', '/browser lola');
    expect(w.sent.at(-1).text).toMatch(/no browser for this chat — .*brain profile dir/);
    expect(w.calls).toEqual([]);
    expect(await members(w, 'work')).toEqual(['Work chat']);
  });

  it('a chat joining a group whose Chrome is running shares it: one Chrome per profile, not a second launch', async () => {
    const w = build();
    await w.run('!work', '/browser');
    await w.run('!edu', '/browser work');
    expect(w.calls).toHaveLength(1);
    expect(await members(w, 'work')).toEqual(['Work chat', 'Edu chat']);
  });

  it('the brain group is fixed: its chats cannot leave, nobody can join', async () => {
    const w = build({ profiles: ['lola'] });
    await w.run('!brain', '/browser lola');
    expect(w.sent.at(-1).text).toMatch(/brain.*fixed/);
    await w.run('!work', '/browser brain');
    expect(w.sent.at(-1).text).toMatch(/brain.*fixed/);
    expect(w.calls).toEqual([]);
    expect(await w.table()).toEqual(GROUPS);
  });

  it('stays operator-only; usage names the profile', async () => {
    const w = build();
    const ev = { chatId: '!work', surface: 'whatsapp', authorized: false, body: '/n browser lola' };
    expect(await w.cmds.isCommand(w.cmds.commandOf(ev))).toBe(false);
    await w.run('!work', '/browser a b c');
    expect(w.sent.at(-1).text).toContain('browser [all] [<profile> [new]] [keep]');
  });
});

// /<handle> browsers (alias: browser list) and browser close all (operator 2026-11-20), over the fake daemon's list.
describe('/<handle> browsers, browser close all', () => {
  let killed = [];
  beforeEach(() => { killed = []; });
  const listing = (rows) => { const w = fakePipeChrome({ listTabs: async () => [] }); return { ...w.chromeHost, list: async () => rows, kill: (g) => killed.push(g) }; };
  const CHROMES = [{ group: 'work', profileDir: '/p/work', pid: 11, channel: {} }, { group: 'shared', profileDir: '/p/shared', pid: 12, plain: true }];
  const procs = () => [
    { pid: 11, cmd: 'chrome --user-data-dir=/p/work --pipe' }, { pid: 111, cmd: 'chrome --type=renderer --user-data-dir=/p/work' },
    { pid: 12, cmd: 'chrome --user-data-dir=/p/shared' }, { pid: 99, cmd: 'chrome --user-data-dir=/p/other' },
  ];
  const rss = { 11: 300 * 1048576, 111: 112 * 1048576, 12: 380 * 1048576, 99: 5 * 1048576 };

  it('nothing open: one line', async () => {
    const w = build({ chromeHost: listing([]) });
    await w.run('!work', '/browsers');
    expect(w.sent).toEqual([{ chatId: '!work', text: 'no browsers open.' }]);
  });

  it('an eGPT Chrome, a sign-in window and a screen-only group: chats, screen, link, idle, memory', async () => {
    const t0 = 1_000_000;
    const w = build({
      chromeHost: listing(CHROMES), chromeProcesses: procs, rssOf: (pid) => rss[pid] ?? null,
      screensOpen: [{ group: 'work', display: ':100' }, { group: 'shared', display: ':101' }, { group: 'lab', display: ':102' }],
      linked: new Set(['work']), xIdle: (g) => (g === 'work' ? 4 * 60_000 : 60_000), clock: () => t0,
    });
    await w.run('!work', '/browsers');
    expect(w.sent.at(-1).text).toBe([
      'browsers open (3):',
      '• lab — screen only, no Chrome · screen :102 · idle 1 min',
      '• shared — sign-in window · chats: every unlisted chat · screen :101 · idle 1 min · 380 MB',
      '• work — eGPT · chats: Work chat · screen :100, link open · idle 4 min · 412 MB',
    ].join('\n'));
  });

  it('memory counts only the profile own Chromes, not a sibling whose path starts the same', async () => {
    const w = build({
      chromeHost: listing(CHROMES), rssOf: (pid) => rss[pid] ?? null,
      chromeProcesses: () => [...procs(), { pid: 13, cmd: 'chrome --user-data-dir=/p/work2' }],
    });
    rss[13] = 900 * 1048576;
    await w.run('!work', '/browsers');
    expect(w.sent.at(-1).text).toContain('412 MB');
    delete rss[13];
  });

  it('win32: no memory column (it cannot be read there)', async () => {
    const w = build({ chromeHost: listing(CHROMES), chromeProcesses: procs, rssOf: (pid) => rss[pid] ?? null, platform: 'win32' });
    await w.run('!work', '/browsers');
    expect(w.sent.at(-1).text).toBe('browsers open (2):\n• shared — sign-in window · chats: every unlisted chat\n• work — eGPT · chats: Work chat');
  });

  it('memory is omitted when it cannot be read, and the command never fails', async () => {
    const w = build({ chromeHost: listing(CHROMES), chromeProcesses: () => { throw new Error('no ps'); }, available: false });
    await w.run('!work', '/browsers');
    const text = w.sent.at(-1).text;
    expect(text).toBe('browsers open (2):\n• shared — sign-in window · chats: every unlisted chat\n• work — eGPT · chats: Work chat');
    expect(text).not.toMatch(/MB|screen|link/);
  });

  it('`browser list` answers exactly as `browsers`', async () => {
    const w = build({ chromeHost: listing(CHROMES), chromeProcesses: procs, rssOf: (pid) => rss[pid] ?? null });
    await w.run('!work', '/browsers');
    await w.run('!work', '/browser list');
    expect(w.sent[1].text).toBe(w.sent[0].text);
    expect(w.sent[0].text).toContain('browsers open (2)');
  });

  it('close all closes each open browser (Chrome, link, screen) and summarizes in one reply', async () => {
    const w = build({ chromeHost: listing(CHROMES), screensOpen: [{ group: 'work', display: ':100' }], linked: new Set(['work']) });
    await w.run('!work', '/browser close ALL');
    expect(killed).toEqual(['shared', 'work']);
    expect(w.ops).toEqual(['link-close:shared', 'screen-close:shared', 'link-close:work', 'screen-close:work']);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].text).toMatch(/^closed 2 browsers: shared \(its Chrome, its screen\); work \(its Chrome, its link, its screen\)\. They start again/);
  });

  it('close all with nothing open says so and closes nothing', async () => {
    const w = build({ chromeHost: listing([]) });
    await w.run('!work', '/browser close all');
    expect(w.sent).toEqual([{ chatId: '!work', text: 'no browsers open: nothing to close.' }]);
    expect(killed).toEqual([]);
  });

  it('close <group> still closes only that group', async () => {
    const w = build({ chromeHost: listing(CHROMES) });
    await w.run('!work', '/browser close work');
    expect(w.ops).toEqual(['link-close:work', 'screen-close:work']);
    expect(w.sent.at(-1).text).toContain('the work browser');
  });

  it('a non-owner is refused, as for the rest of /browser', async () => {
    const w = build();
    const stranger = (body) => ({ chatId: '!other', chatName: 'Other chat', surface: 'whatsapp', authorized: false, commandBeing: 'n', commandHandle: 'n', body });
    for (const body of ['/browsers', '/browser list', '/browser close all', '/browser close']) expect(await w.cmds.isCommand(stranger(body))).toBe(false);
    expect(await w.cmds.isCommand({ ...stranger('/browsers'), authorized: true })).toBe(true);
  });
});
