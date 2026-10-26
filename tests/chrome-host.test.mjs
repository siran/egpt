// tests/chrome-host.test.mjs — the S1 daemon HOLDS every group Chrome (src/chrome-host.mjs), so a spine
// restart re-attaches instead of relaunching (operator 2026-10-11: "restarting the spine wouldn't
// restart chrome"). The REAL host and the REAL spine end (connectChromeHost) over an in-memory IPC pair;
// only Chrome is fake (fake-pipe-chrome.mjs). A spine restart = the pair drops, a new pair + a new
// createCommands against the same host.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createChromeHost, connectChromeHost, CHROME_HOST_ENV } from '../src/chrome-host.mjs';
import { createChannelTransport } from '../src/tools/cdp.mjs';
import { chromePipeArgs, chromePlainArgs } from '../src/tools/chrome-launcher.mjs';
import { createCommands, CHROME_BRAIN_PROFILE } from '../src/spine/commands.mjs';
import { fakeChromeChild } from './fake-pipe-chrome.mjs';

const MB = 1024 * 1024;
const SHARED = { key: 'Reinie-2607150057', name: 'Reinie', group: 'shared' };
const ROOT = dirname(CHROME_BRAIN_PROFILE);
// What the spine sends for group `g` (commands.mjs ensureGroupChrome).
const launchOf = (group, bin = 'chrome') => ({ group, profileDir: join(ROOT, group), bin, argv: chromePipeArgs({ userDataDir: join(ROOT, group), windowName: group }) });
const TABS = [{ id: 'T1', title: 'kept', url: 'https://x/' }];
const until = async (ok) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setImmediate(r)); expect(ok()).toBe(true); };

// The daemon's child handle ⇄ the spine's `process`, async and JSON-cloned like node's IPC.
function ipcPair() {
  const daemonSide = Object.assign(new EventEmitter(), { connected: true });
  const spineSide = Object.assign(new EventEmitter(), { connected: true });
  const deliver = (to, m) => setImmediate(() => { if (to.connected) to.emit('message', JSON.parse(JSON.stringify(m))); });
  daemonSide.send = (m) => deliver(spineSide, m);
  spineSide.send = (m) => deliver(daemonSide, m);
  const drop = () => { daemonSide.connected = spineSide.connected = false; daemonSide.emit('disconnect'); spineSide.emit('disconnect'); };
  return { daemonSide, spineSide, drop };
}

function world(browser = { listTabs: async () => TABS }) {
  const spawns = [];
  const logs = [];
  const host = createChromeHost({
    profilesRoot: ROOT,
    log: (m) => logs.push(m),
    setPriority: () => {},
    spawn: (bin, argv, opts) => { const child = fakeChromeChild(browser, 4000 + spawns.length); spawns.push({ bin, argv, opts, child }); return child; },
  });
  // One spine: a fresh IPC pair to the SAME host, and the spine's end of it.
  const connect = () => {
    const pair = ipcPair();
    host.attach(pair.daemonSide);
    return { pair, chromeHost: connectChromeHost(pair.spineSide, { [CHROME_HOST_ENV]: '1' }) };
  };
  const spine = () => {
    const { pair, chromeHost } = connect();
    const logs = [];
    const cmds = createCommands({
      getConfig: () => ({ chrome: { bin: 'C:/x/chrome.exe' } }),
      chromeHost, profileHolder: () => null, freeMem: () => 8192 * MB, rssOf: () => null,
      onChromeLog: (m) => logs.push(m), send: async () => {}, sleep: async () => {},
      brains: { resolve: (name) => ({ name, type: 'ccode' }) },
    });
    return { pair, cmds, logs };
  };
  return { host, spawns, logs, connect, spine };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a spine restart never restarts a Chrome', () => {
  it('a new spine re-attaches to the Chrome the daemon holds and does NOT relaunch it', async () => {
    const w = world();
    const one = w.spine();
    expect(await one.cmds.startBrowser(SHARED)).toMatchObject({ ok: true, launched: true });
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].bin).toBe('C:/x/chrome.exe');
    expect(w.spawns[0].argv).toContain('--remote-debugging-pipe');

    one.pair.drop();                                   // /upgrade, /restart: the spine goes, the daemon stays
    const two = w.spine();
    const again = await two.cmds.startBrowser(SHARED);
    expect(again).toMatchObject({ ok: true, alreadyRunning: true });
    expect(again.detail).toContain(`pid ${w.spawns[0].child.pid}`);
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].child.killed).toBe(false);
    expect(await (await two.cmds.chromeClientFor(SHARED)).client.listTabs()).toEqual([{ id: 'T1', type: 'page', title: 'kept', url: 'https://x/' }]);
    expect(two.logs.some((l) => /re-attached "shared" Chrome/.test(l))).toBe(true);
  });

  it('a Chrome that exits is marked down; the next need relaunches it', async () => {
    const w = world();
    const { cmds, logs } = w.spine();
    await cmds.startBrowser(SHARED);
    w.spawns[0].child.kill();                          // Chrome died on its own
    await until(() => logs.some((l) => /"shared" Chrome \(pid 4000\) exited/.test(l)));
    expect((await cmds.chromeClientFor(SHARED, { launch: false })).running).toBe(false);
    expect(await cmds.startBrowser(SHARED)).toMatchObject({ ok: true, launched: true });
    expect(w.spawns).toHaveLength(2);
  });

  // REAL spawn, SAFE BY CONSTRUCTION: the configured binary does not exist, so the OS starts nothing.
  // Without an 'error' listener that ENOENT would be an uncaught exception in the DAEMON.
  it('runs the configured binary; a spawn that fails is the launch\'s error, and nothing is held', async () => {
    const host = createChromeHost({ profilesRoot: ROOT });
    const pair = ipcPair();
    host.attach(pair.daemonSide);
    const chromeHost = connectChromeHost(pair.spineSide, { [CHROME_HOST_ENV]: '1' });
    const missing = join(tmpdir(), 'egpt-no-such-dir', 'no-such-chrome.exe');
    await expect(chromeHost.launch(launchOf('g', missing))).rejects.toThrow(/ENOENT/);
    expect(await chromeHost.list()).toEqual([]);
  });

  it('kill reaches the daemon and its exit comes back', async () => {
    const w = world();
    const { chromeHost } = w.connect();
    const exits = [];
    chromeHost.onExit((e) => exits.push(e));
    const { channel } = await chromeHost.launch(launchOf('g'));
    chromeHost.kill('g');
    await until(() => exits.length === 1);
    expect(exits[0]).toMatchObject({ group: 'g', pid: 4000 });
    expect(w.spawns[0].child.killed).toBe(true);
    expect(channel.closed).toBe(true);
    expect(await chromeHost.list()).toEqual([]);
  });
});

describe('no daemon IPC → no browser', () => {
  it('connectChromeHost is null without the daemon flag or without an IPC channel', () => {
    const proc = Object.assign(new EventEmitter(), { send: () => {} });
    expect(connectChromeHost(proc, {})).toBe(null);
    expect(connectChromeHost(new EventEmitter(), { [CHROME_HOST_ENV]: '1' })).toBe(null);
  });

  it('the flag is the spine\'s alone: connecting removes it, so a process the spine starts never sees it', () => {
    const env = { [CHROME_HOST_ENV]: '1' };
    expect(connectChromeHost(Object.assign(new EventEmitter(), { send: () => {}, connected: true }), env)).not.toBe(null);
    expect(env[CHROME_HOST_ENV]).toBeUndefined();
  });

  it('a spine with no chrome-host answers "no browser", launches nothing, one log line', async () => {
    const logs = [];
    const cmds = createCommands({ getConfig: () => ({}), chromeHost: null, profileHolder: () => null, onChromeLog: (m) => logs.push(m), send: async () => {}, brains: { resolve: (name) => ({ name }) } });
    const r = await cmds.startBrowser(SHARED);
    expect(r).toMatchObject({ ok: false, reason: 'no-browser' });
    expect(r.detail).toMatch(/no daemon chrome-host/);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/no browser for "Reinie"/);
  });

  // Operator 2026-10-22: the Session 0 service runs the node while nobody is logged in; the browser
  // needs a desktop, so a browser request there is told plainly when it will be possible.
  it('under the Session 0 daemon it says the browser is available once someone logs in', async () => {
    const cmds = createCommands({ getConfig: () => ({}), chromeHost: null, inSession0: true, profileHolder: () => null, onChromeLog: () => {}, send: async () => {}, brains: { resolve: (name) => ({ name }) } });
    const r = await cmds.startBrowser(SHARED);
    expect(r).toMatchObject({ ok: false, reason: 'no-browser' });
    expect(r.detail).toMatch(/nobody is logged in.*once someone logs in/);
  });
});

describe('the orphan sweep at daemon start', () => {
  it('kills only pipe Chromes whose --user-data-dir is under our profiles root', () => {
    const root = join(tmpdir(), 'egpt-sweep', 'chrome', 'profiles');
    const killed = [];
    const host = createChromeHost({
      profilesRoot: root,
      processes: () => [
        { pid: 1, cmd: `"C:\\chrome.exe" --remote-debugging-pipe --user-data-dir=${join(root, 'brain')} --no-first-run about:blank` },
        { pid: 2, cmd: `chrome.exe --remote-debugging-pipe "--user-data-dir=${join(root, 'with space')}" --new-window` },
        { pid: 3, cmd: `chrome.exe --type=renderer --user-data-dir=${join(root, 'brain')}` },
        { pid: 4, cmd: `chrome.exe --remote-debugging-pipe --user-data-dir=${join(tmpdir(), 'elsewhere')}` },
        { pid: 5, cmd: `chrome.exe --remote-debugging-pipe --user-data-dir=${root}-evil${sep}brain` },
        { pid: 6, cmd: `chrome.exe --remote-debugging-port=9222 --user-data-dir=${join(root, 'brain')}` },
        { pid: 7, cmd: `chrome.exe --remote-debugging-pipe --user-data-dir=${root}` },
        { pid: 8, cmd: 'chrome.exe' },
      ],
      killTree: (pid) => killed.push(pid),
    });
    host.sweepOrphans();
    expect(killed).toEqual([1, 2]);
  });

  it('a failing process listing never throws out of the daemon', () => {
    const logs = [];
    const host = createChromeHost({ profilesRoot: 'x', processes: () => { throw new Error('no powershell'); }, killTree: () => {}, log: (m) => logs.push(m) });
    expect(() => host.sweepOrphans()).not.toThrow();
    expect(logs.join('\n')).toMatch(/no powershell/);
  });
});

describe('what a dropped spine leaves on a held Chrome', () => {
  it('message ids never collide: a reply still in flight for the old spine is not the new spine\'s answer', async () => {
    const held = [];
    const w = world({ cdp: (m) => (m.method === 'Slow.call' ? new Promise((r) => held.push(() => r({ from: m.params.who }))) : {}) });
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const a = w.connect();
    const { channel } = await a.chromeHost.launch(launchOf('g'));
    const s1 = await createChannelTransport(channel).openBrowserSession();
    s1.send('Slow.call', { who: 'spine1' }).catch(() => {});
    await until(() => held.length === 1);
    a.pair.drop();

    clock.mockReturnValue(t0 + 5000);                 // the next spine boots seconds later
    const b = w.connect();
    const [g] = await b.chromeHost.list();
    const s2 = await createChannelTransport(g.channel).openBrowserSession();
    const mine = s2.send('Slow.call', { who: 'spine2' });
    await until(() => held.length === 2);
    held[0]();                                         // the OLD spine's reply lands first
    held[1]();
    expect(await mine).toEqual({ from: 'spine2' });
  });

  it('the daemon detaches every root session the dropped spine attached — even one still attaching', async () => {
    let late = null;
    let n = 0;
    const w = world({
      cdp: (m) => {
        if (m.method === 'Target.attachToBrowserTarget') return { sessionId: `R${++n}` };
        if (m.method === 'Target.attachToTarget' && m.params.targetId === 'LATE') return new Promise((r) => { late = () => r({ sessionId: 'S-LATE' }); });
        if (m.method === 'Target.attachToTarget') return { sessionId: `S-${m.params.targetId}` };
        return {};
      },
    });
    const a = w.connect();
    const { channel } = await a.chromeHost.launch(launchOf('g'));
    const t = createChannelTransport(channel);
    await t.openTargetSession('T1');                                    // a top-level page session
    const b = await t.openBrowserSession();
    await b.send('Target.attachToBrowserTarget');                       // a root a mux client holds
    await b.send('Target.attachToTarget', { targetId: 'T2', flatten: true });
    t.openTargetSession('LATE').catch(() => {});                        // still attaching when the spine goes
    await until(() => late != null);
    a.pair.drop();
    late();
    const chrome = w.spawns[0].child;
    const detached = () => chrome.received.filter((m) => m.method === 'Target.detachFromTarget').map((m) => [m.params.sessionId, m.id < 0]);
    await until(() => detached().length === 4);
    expect(detached().sort()).toEqual([['R1', true], ['S-LATE', true], ['S-T1', true], ['S-T2', true]]);

    const c = w.connect();                                              // the next spine hears none of that
    const heard = [];
    (await c.chromeHost.list())[0].channel.onMessage((m) => heard.push(m));
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([]);
  });
});

// The daemon is the ONLY Chrome spawner, so it runs nothing but a pipe Chrome on the profile it was
// sent, under our profiles root — whatever a spine (or anything else on its IPC) asks for.
describe('the daemon refuses a launch that is not a pipe Chrome on our profile', () => {
  const dir = join(ROOT, 'g');
  const pipeArgs = chromePipeArgs({ userDataDir: dir });
  const refused = async (argv, profileDir = dir, why) => {
    const w = world();
    const { chromeHost } = w.connect();
    await expect(chromeHost.launch({ group: 'g', profileDir, bin: 'chrome', argv })).rejects.toThrow(why);
    expect(w.spawns).toHaveLength(0);
    expect(w.logs.filter((l) => /refused/.test(l))).toHaveLength(1);
  };

  it('a debugging PORT or ADDRESS, in any switch spelling Chrome reads', async () => {
    await refused([...pipeArgs, '--remote-debugging-port=9222'], dir, /remote-debugging-port/);
    await refused([...pipeArgs, '--remote-debugging-address=0.0.0.0'], dir, /remote-debugging-address/);
    await refused(['/Remote-Debugging-Port=9222', ...pipeArgs], dir, /remote-debugging-port/i);
    await refused(['-remote-debugging-port', ...pipeArgs], dir, /remote-debugging-port/);
  });

  it('no --remote-debugging-pipe', async () => {
    await refused(pipeArgs.filter((a) => a !== '--remote-debugging-pipe'), dir, /not a pipe Chrome/);
  });

  it('no --user-data-dir, one outside the profiles root, or the root itself', async () => {
    await refused(pipeArgs.filter((a) => !a.startsWith('--user-data-dir=')), dir, /under/);
    const out = join(tmpdir(), 'egpt-elsewhere', 'g');
    await refused(chromePipeArgs({ userDataDir: out }), out, /under/);
    await refused(chromePipeArgs({ userDataDir: ROOT }), ROOT, /under/);
  });

  it('a --user-data-dir that is not the profileDir it was sent, or a second one', async () => {
    await refused(chromePipeArgs({ userDataDir: join(ROOT, 'other') }), dir, /is not/);
    await refused([...pipeArgs, `--user-data-dir=${join(tmpdir(), 'egpt-elsewhere')}`], dir, /one --user-data-dir/);
    await refused([...pipeArgs, `-user-data-dir=${join(ROOT, 'other')}`], dir, /one --user-data-dir/);
  });

  it('the spine\'s own chromePipeArgs launch still runs — a profile path with a space too', async () => {
    const w = world();
    const { chromeHost } = w.connect();
    const spaced = join(ROOT, 'with space');
    await chromeHost.launch({ group: 'with space', profileDir: spaced, bin: 'chrome', argv: chromePipeArgs({ userDataDir: spaced }) });
    await chromeHost.launch(launchOf('g'));
    expect(w.spawns.map((s) => s.argv)).toEqual([chromePipeArgs({ userDataDir: spaced }), launchOf('g').argv]);
    expect(w.logs.filter((l) => /refused/.test(l))).toEqual([]);
  });

  it('--window-name=<group> passes, a group name with a space too, and still no port slips in with it', async () => {
    const w = world();
    const { chromeHost } = w.connect();
    const spaced = join(ROOT, 'with space');
    const argv = chromePipeArgs({ userDataDir: spaced, windowName: 'with space' });
    await chromeHost.launch({ group: 'with space', profileDir: spaced, bin: 'chrome', argv });
    expect(w.spawns[0].argv).toContain('--window-name=with space');
    expect(w.logs.filter((l) => /refused/.test(l))).toEqual([]);
    await refused([...chromePipeArgs({ userDataDir: dir, windowName: 'g' }), '--remote-debugging-port=9222'], dir, /remote-debugging-port/);
  });
});

// /browser refresh's sign-in window: a PLAIN Chrome the daemon runs and holds like a pipe one, minus the pipe.
describe('the daemon\'s plain Chrome (a human\'s sign-in window)', () => {
  const dir = join(ROOT, 'g');
  const G = { key: 'g', name: 'g', group: 'g' };
  const plainOf = (argv = chromePlainArgs({ userDataDir: dir })) => ({ group: 'g', profileDir: dir, bin: 'chrome', argv });

  it('runs with no pipe fds, is listed as plain with no channel, blocks a pipe launch on its group, and its exit comes back', async () => {
    const w = world();
    const { pair, chromeHost } = w.connect();
    const exits = [];
    chromeHost.onExit((e) => exits.push(e));
    const url = 'https://accounts.google.com/';
    expect(await chromeHost.launchPlain(plainOf(chromePlainArgs({ userDataDir: dir, url })))).toEqual({ pid: 4000 });
    expect(w.spawns[0].argv).toEqual([`--user-data-dir=${dir}`, '--no-first-run', url]);
    expect(w.spawns[0].opts.stdio).toBe('inherit');
    expect(await chromeHost.list()).toEqual([{ group: 'g', profileDir: dir, pid: 4000, plain: true }]);
    await expect(chromeHost.launch(launchOf('g'))).rejects.toThrow(/already up/);
    pair.spineSide.send({ t: 'msg', group: 'g', msg: { id: 1, method: 'Target.getTargets' } });   // no pipe: dropped
    await new Promise((r) => setTimeout(r, 10));
    expect(w.spawns[0].child.received).toEqual([]);
    w.spawns[0].child.kill();                                                                     // the human closed it
    await until(() => exits.length === 1);
    expect(exits[0]).toMatchObject({ group: 'g', pid: 4000 });
    expect(await chromeHost.list()).toEqual([]);
  });

  it('refuses a plain launch with a debugging switch or a profile outside our root', async () => {
    const refused = async (o, why) => {
      const w = world();
      await expect(w.connect().chromeHost.launchPlain(o)).rejects.toThrow(why);
      expect(w.spawns).toHaveLength(0);
    };
    await refused(plainOf([...chromePlainArgs({ userDataDir: dir }), '--remote-debugging-pipe']), /no --remote-debugging switch/);
    await refused(plainOf(['/remote-debugging-pipe', ...chromePlainArgs({ userDataDir: dir })]), /no --remote-debugging switch/);
    await refused(plainOf(['--remote-debugging-port=9222', ...chromePlainArgs({ userDataDir: dir })]), /opens a debugging port/);
    const out = join(tmpdir(), 'egpt-elsewhere', 'g');
    await refused({ ...plainOf(chromePlainArgs({ userDataDir: out })), profileDir: out }, /under/);
  });

  it('end to end: /browser refresh kills the pipe Chrome in the daemon, then the daemon runs the plain one', async () => {
    const w = world();
    const { cmds } = w.spine();
    await cmds.startBrowser(null);                                   // brain (no registry): the conversation-less path
    const brain = CHROME_BRAIN_PROFILE;
    await cmds.run({ chatId: '!x', surface: 'whatsapp', authorized: true, body: '/browser refresh https://accounts.google.com' });
    expect(w.spawns[0].child.killed).toBe(true);
    expect(w.spawns[1].argv).toEqual(chromePlainArgs({ userDataDir: brain, url: 'https://accounts.google.com/' }));
    expect(w.logs.filter((l) => /refused|already up/.test(l))).toEqual([]);
  });

  it('a restarted spine re-holds the group for sign-in; the window\'s exit hands it back', async () => {
    const w = world();
    const a = w.connect();
    await a.chromeHost.launchPlain(plainOf());
    a.pair.drop();
    const two = w.spine();
    const held = await two.cmds.startBrowser(G);
    expect(held).toMatchObject({ ok: false, reason: 'no-browser' });
    expect(held.detail).toMatch(/"g" browser is held for sign-in/);
    expect(two.logs).toContain('"g" held for sign-in: plain Chrome pid 4000, held by the daemon');
    w.spawns[0].child.kill();
    await until(() => two.logs.some((l) => /sign-in window \(pid 4000\) closed/.test(l)));
    expect(await two.cmds.startBrowser(G)).toMatchObject({ ok: true, launched: true });
    expect(w.spawns[1].argv).toEqual(launchOf('g').argv);
  });
});

describe('a refresh while the daemon still holds an earlier sign-in window', () => {
  it('a restarted spine sees the hold before it acts: "already held", nothing killed or launched', async () => {
    const w = world();
    const a = w.connect();
    const dir = CHROME_BRAIN_PROFILE;
    await a.chromeHost.launchPlain({ group: 'brain', profileDir: dir, bin: 'chrome', argv: chromePlainArgs({ userDataDir: dir }) });
    a.pair.drop();
    const sent = [];
    const { pair, chromeHost } = w.connect();
    const cmds = createCommands({
      getConfig: () => ({}), chromeHost, profileHolder: () => null, onChromeLog: () => {},
      send: async (chatId, text) => sent.push(text), brains: { resolve: (name) => ({ name }) },
    });
    await cmds.run({ chatId: '!x', surface: 'whatsapp', authorized: true, body: '/browser refresh' });
    expect(sent.at(-1)).toMatch(/"brain" browser is already held for sign-in/);
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].child.killed).toBe(false);
    pair.drop();
  });
});
