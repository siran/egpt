// tests/browser-screens.test.mjs — a screen per browser group, shared by link (plans/2611022204-BROWSER-SCREENS.md;
// operator 2026-11-02, NU Ops #96-#121). Hermetic: fake spawns, fake /proc, a temp EGPT_HOME, the fake chrome-host.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, writeSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserScreens, allocateDisplay, sessionsOn, portsOf } from '../src/tools/browser-screens.mjs';
import { createScreenTunnel, linkOf } from '../src/tools/screen-tunnel.mjs';
import { createCommands } from '../src/spine/commands.mjs';
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
const STATE = { contacts: { whatsapp: { '!work': { slug: 'Work chat-2601010000' }, '!admin': { slug: 'eGPT Admin-2601010000' } } } };
const GROUPS = { work: ['Work chat'] };
const URL = 'https://q.trycloudflare.com';
function build({ available = true, admin = { chatId: '!admin' }, chromeHost } = {}) {
  const fake = fakePipeChrome({ listTabs: async () => [] });
  const ops = [];
  const browserScreens = {
    available: () => available,
    ensure: async (g) => { ops.push(`screen:${g}`); return { group: g, display: ':101' }; },
    close: (g) => { ops.push(`screen-close:${g}`); return true; },
  };
  let open = false;
  const screenTunnel = {
    open: async (g) => { ops.push(`link:${g}`); const reused = open; open = true; return { url: URL, control: 'CTL', view: 'VIEW', reused }; },
    close: (g) => { ops.push(`link-close:${g}`); const was = open; open = false; return was; },
  };
  const sent = [];
  const cmds = createCommands({
    getConfig: () => ({ node_name: 'nu', agents: { n: {} }, chrome: { bin: '/x/chrome' } }),
    chromeHost: chromeHost === undefined ? fake.chromeHost : chromeHost,
    profileHolder: () => null, freeMem: () => 8192 * 1024 * 1024, rssOf: () => null,
    browserGroups: async () => GROUPS, profileFolders: () => [],
    loadState: async () => STATE, writeState: async () => {},
    send: async (chatId, text) => sent.push({ chatId, text }),
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
    browserScreens, screenTunnel, adminChat: async () => admin,
  });
  const run = (chatId, body) => cmds.run({ chatId, chatName: chatId === '!work' ? 'Work chat' : 'eGPT Admin', surface: 'whatsapp', authorized: true, commandHandle: 'n', body });
  return { cmds, run, sent, ops, ...fake };
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
    await w.run('!admin', '/browser work');
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
