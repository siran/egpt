// tests/chrome-dedicated-pool.test.mjs — the per-GROUP Chrome pool (plans/2610091931 rev 2026-10-11).
// EVERY group, `brain` included (config/browsers.yaml; unlisted → `shared`; no conversation → brain),
// launches its GROUP's Chrome over --remote-debugging-pipe, driven by a pipe cdpClient (3a). The
// non-brain groups go through the pure memory check (chunk 2: evict when short, never denied); brain and
// shared are never evicted.
//
// NO REAL CHROME: the daemon's chromeHost is faked over two in-memory streams as fds 3 & 4 (like 3a's
// fake peer) and a fake child; memory (freeMem/rssOf) is injected as plain numbers, so admission is
// deterministic. The pipe client actually speaks CDP against a scripted peer, so "a client was built
// over the pipe" is proven by a round-trip, not by inspection.
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromePipeArgs } from '../src/tools/chrome-launcher.mjs';
import { createPipeChannel } from '../src/tools/cdp.mjs';
import { createCommands, CHROME_BRAIN_PROFILE } from '../src/spine/commands.mjs';
import { chromeConversationOf } from '../src/spine/chrome-pool.mjs';
import { readBrowserGroups } from '../src/rooms-file.mjs';

const MB = 1024 * 1024;

// A scripted CDP peer on the fd pair: answers Target.getTargets so client.listTabs round-trips.
const TARGETS = [{ targetId: 'T1', type: 'page', url: 'https://x/', title: 'x' }];
function wirePeer(toChrome, toClient) {
  let buf = Buffer.alloc(0);
  toChrome.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (!frame.length) continue;
      const msg = JSON.parse(frame.toString('utf8'));
      const result = msg.method === 'Target.getTargets' ? { targetInfos: TARGETS } : {};
      toClient.write(JSON.stringify({ id: msg.id, result }) + '\0');
    }
  });
}

// A fake chromeHost (src/chrome-host.mjs connectChromeHost's shape): records launch opts + the handles
// it made, reports exits like the daemon does, and models memory as a shared cell — a launch CONSUMES
// `cost`, a kill (eviction) FREES it, so pressure is deterministic.
function fakePipeSpawner({ mem = { free: Infinity }, cost = 0 } = {}) {
  const calls = [];
  const handles = [];
  const exits = new Set();
  let pid = 1000;
  const launch = async (opts) => {
    calls.push(opts);
    const toChrome = new PassThrough();
    const toClient = new PassThrough();
    wirePeer(toChrome, toClient);
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.stdio = [null, null, null, toChrome, toClient];
    child.kill = () => {
      if (child.killed) return;
      child.killed = true; child.exitCode = 0;
      mem.free += cost;
      try { toClient.end(); } catch { /* best effort */ }
      child.emit('exit', 0, null);
    };
    mem.free -= cost;
    const h = { child, group: opts.group, pid: ++pid, profileDir: opts.profileDir };
    child.on('exit', (code, signal) => { for (const cb of exits) cb({ group: h.group, pid: h.pid, code, signal }); });
    handles.push(h);
    return { pid: h.pid, channel: createPipeChannel({ writable: toChrome, readable: toClient }) };
  };
  const kill = (group) => { handles.find((h) => h.group === group && !h.child.killed)?.child.kill(); };
  return { chromeHost: { launch, kill, list: async () => [], onExit: (cb) => { exits.add(cb); } }, calls, handles };
}

function build({ config = {}, mem, cost = 0, freeMem, rssOf, profileHolder = () => null } = {}) {
  const { chromeHost, calls, handles } = fakePipeSpawner({ mem, cost });
  const logs = [];
  let clk = 0;
  const cmds = createCommands({
    getConfig: () => config,
    chromeHost,
    profileHolder,
    freeMem: freeMem ?? (() => (mem ? mem.free : Infinity)),
    rssOf: rssOf ?? (() => null),
    onChromeLog: (m) => logs.push(m),
    now: () => (clk += 1),
    sleep: async () => {},
    send: async () => {},
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
  });
  return { cmds, calls, handles, logs };
}

const SHARED = { key: 'Reinie-2607150057', name: 'Reinie', group: 'shared' };
const sharedDir = join(dirname(CHROME_BRAIN_PROFILE), 'shared');
const BRAIN = { key: 'eGPT Admin-2601010000', name: 'eGPT Admin', group: 'brain' };

describe('chromePipeArgs — pipe, non-default profile, no port/origins', () => {
  const args = chromePipeArgs({ userDataDir: 'C:/x/profiles/conv-1' });
  it('uses --remote-debugging-pipe, never a port', () => {
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });
  it('restores the group\'s last session, keeps the trailing url, and never names a port', () => {
    expect(args).toContain('--restore-last-session');
    expect(args.at(-1)).toBe('about:blank');
    expect(chromePipeArgs({ userDataDir: 'C:/x/p', url: 'https://example.com/' }).at(-1)).toBe('https://example.com/');
    expect(args.some((a) => a.includes('remote-debugging-port'))).toBe(false);
  });

  it('does not announce automation to sites: the pipe alone makes navigator.webdriver true (measured 2026-10-27)', () => {
    expect(args).toContain('--disable-blink-features=AutomationControlled');
  });
  it('drops --remote-allow-origins (that is port/WS-only)', () => {
    expect(args.some((a) => a.startsWith('--remote-allow-origins'))).toBe(false);
  });
  it('keeps a NON-default --user-data-dir, --no-first-run and the renderer-alive flags', () => {
    expect(args).toContain('--user-data-dir=C:/x/profiles/conv-1');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--disable-renderer-backgrounding');
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args).toContain('--disable-backgrounding-occluded-windows');
  });
  it('--window-name only when a name is given, before the trailing url', () => {
    expect(args.some((a) => a.startsWith('--window-name'))).toBe(false);
    const named = chromePipeArgs({ userDataDir: 'C:/x/p', windowName: 'eduweb-si' });
    expect(named).toContain('--window-name=eduweb-si');
    expect(named.at(-1)).toBe('about:blank');
  });
});

describe('a non-brain GROUP → its group pipe Chrome + a pipe cdpClient', () => {
  it('pipe-spawns <profiles-root>/<group>, with the configured binary, and builds a working pipe client', async () => {
    const { cmds, calls } = build({ config: { chrome: { bin: 'C:/x/chrome.exe' } } });
    const r = await cmds.chromeClientFor(SHARED);
    expect(r.profileDir).toBe(sharedDir);
    expect(calls).toHaveLength(1);
    expect(calls[0].profileDir).toBe(sharedDir);
    expect(calls[0].profileDir).not.toBe(CHROME_BRAIN_PROFILE);   // non-default (Chrome 136 requires it)
    expect(calls[0].bin).toBe('C:/x/chrome.exe');
    expect(calls[0].argv).toEqual(chromePipeArgs({ userDataDir: sharedDir, windowName: 'shared' }));
    // the client speaks CDP over the pipe against the scripted peer
    const tabs = await r.client.listTabs();
    expect(tabs).toEqual([{ id: 'T1', type: 'page', url: 'https://x/', title: 'x' }]);
  });

  it('group brain launches over the PIPE on chrome.profile_dir — the same pool, no port', async () => {
    const { cmds, calls } = build({ config: { chrome: { profile_dir: 'C:/x/brain' } }, mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor(BRAIN);
    expect(calls.map((c) => c.profileDir)).toEqual(['C:/x/brain']);
    expect(calls[0].argv).toContain('--window-name=brain');
    expect(r.profileDir).toBe('C:/x/brain');
    expect(await r.client.listTabs()).toEqual([{ id: 'T1', type: 'page', url: 'https://x/', title: 'x' }]);
  });

  it('no conversation → the brain group, discovered profile when chrome.profile_dir is unset', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const r = await cmds.startBrowser();
    expect(r).toMatchObject({ ok: true, launched: true });
    expect(r.detail).toMatch(/the "brain" browser is up/);
    expect(calls.map((c) => c.profileDir)).toEqual([CHROME_BRAIN_PROFILE]);
  });

  it('brain is never memory-gated: low memory logs nothing for it; a non-brain group launches anyway', async () => {
    const { cmds, calls, logs } = build({ mem: { free: 100 * MB } });
    expect((await cmds.chromeClientFor(BRAIN)).client).not.toBe(null);
    expect(logs.filter((l) => /memory looks short/.test(l))).toHaveLength(0);
    expect((await cmds.chromeClientFor(SHARED)).client).not.toBe(null);
    expect(logs.filter((l) => /memory looks short .*shared.*launching anyway/.test(l))).toHaveLength(1);
    expect(calls.map((c) => c.profileDir)).toEqual([CHROME_BRAIN_PROFILE, sharedDir]);
  });

  it('two chats in the SAME group share ONE Chrome', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const a = await cmds.chromeClientFor(SHARED);
    const b = await cmds.chromeClientFor({ key: 'Diego-2605201243', name: 'Diego', group: 'shared' });
    expect(calls).toHaveLength(1);
    expect(b.client).toBe(a.client);
  });
});

describe('FAIL CLOSED: a chat the lookup refused gets NO browser and one log line', () => {
  it('a chat listed in two groups → no client, nothing spawned, never the brain', async () => {
    const { cmds, calls, logs } = build({ mem: { free: 8192 * MB } });
    const conv = chromeConversationOf({ conversation_path: 'x/eGPT Admin-2609121344' }, { brain: ['eGPT Admin'], work: ['eGPT Admin'] });
    const r = await cmds.chromeClientFor(conv);
    expect(r.client).toBe(null);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "eGPT Admin".*brain, work/.test(l))).toHaveLength(1);
  });

  it('an unsafe group name → no client, nothing spawned', async () => {
    const { cmds, calls, logs } = build({ mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor({ key: 'x-1', name: 'Diego', group: '../brain' });
    expect(r.client).toBe(null);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "Diego"/.test(l))).toHaveLength(1);
  });

  it('a non-brain group whose dir IS the brain profile dir → no browser, never the brain Chrome', async () => {
    const work = join(dirname(CHROME_BRAIN_PROFILE), 'work');
    const { cmds, calls, logs } = build({ config: { chrome: { profile_dir: work } }, mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor({ key: 'x-1', name: 'Diego', group: 'work' });
    expect(r.client).toBe(null);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "Diego".*brain profile dir/.test(l))).toHaveLength(1);
  });
});

describe('browsers.yaml end to end — an operator edit moves a chat without a restart', () => {
  it('eGPT Rodz Lulu An: brain\'s Chrome → removed from brain → shared\'s Chrome', async () => {
    const home = mkdtempSync(join(tmpdir(), 'egpt-browsers-'));
    const saved = process.env.EGPT_HOME;
    try {
      process.env.EGPT_HOME = home;
      mkdirSync(join(home, 'config'));
      const file = join(home, 'config', 'browsers.yaml');
      writeFileSync(file, 'groups:\n  brain: [ "eGPT Admin", "eGPT Rodz Lulu An" ]\n');
      const { cmds, calls } = build({ mem: { free: 8192 * MB } });
      const entry = { conversation_path: '.egpt/conversations/whatsapp/eGPT Rodz Lulu An-2609201419' };   // live shape: no pushedName

      const before = await cmds.chromeClientFor(chromeConversationOf(entry, await readBrowserGroups()));
      expect(before.profileDir).toBe(CHROME_BRAIN_PROFILE);
      expect(calls).toHaveLength(1);

      writeFileSync(file, 'groups:\n  brain: [ "eGPT Admin" ]\n');
      const after = await cmds.chromeClientFor(chromeConversationOf(entry, await readBrowserGroups()));
      expect(after.profileDir).toBe(sharedDir);
      expect(calls).toHaveLength(2);
    } finally {
      process.env.EGPT_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('memory admission for the EXTRA (non-brain) group Chromes: evict when short, never deny', () => {
  it('LAUNCHES when free memory is well above the margin', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor(SHARED);
    expect(r.client).not.toBe(null);
    expect(calls).toHaveLength(1);
  });

  it('below the margin with nothing to evict, LAUNCHES ANYWAY with one log line saying why', async () => {
    // 100 − 500 estimate = −400 MB, far below the 1024 MB margin; the pool is empty so canEvict=false.
    const { cmds, calls, logs } = build({ mem: { free: 100 * MB } });
    const r = await cmds.chromeClientFor(SHARED);
    expect(r).toMatchObject({ launched: true, running: true });
    expect(r.client).not.toBe(null);
    expect(calls).toHaveLength(1);
    const short = logs.filter((l) => /memory looks short/.test(l));
    expect(short).toHaveLength(1);
    expect(short[0]).toMatch(/margin.*launching anyway: browsers are never denied/);
  });

  it('ED on the 2 GB EDW node: low memory, nothing to evict → `browser start` still gets a browser', async () => {
    // operator 2026-10-24: "Don't deny browsers to conversations."
    const { cmds, calls, logs } = build({ mem: { free: 300 * MB } });
    const r = await cmds.startBrowser({ key: 'ED-2610200000', name: 'ED', group: 'edw' });
    expect(r).toMatchObject({ ok: true, launched: true });
    expect(calls.map((c) => c.group)).toEqual(['edw']);
    expect(logs.filter((l) => /memory looks short .*edw.*launching anyway/.test(l))).toHaveLength(1);
  });

  it('under pressure, EVICTS the idlest group Chrome then launches the newcomer', async () => {
    // Each Chrome costs 600 MB; 2200 MB leaves room for two (estimate 500 + margin 1024) but not three.
    const mem = { free: 2200 * MB };
    const { cmds, calls, handles, logs } = build({ mem, cost: 600 * MB });
    const A = { key: 'a', name: 'A', group: 'A-1' };
    const B = { key: 'b', name: 'B', group: 'B-1' };
    const C = { key: 'c', name: 'C', group: 'C-1' };
    await cmds.chromeClientFor(A);   // free 2200 → 1600
    await cmds.chromeClientFor(B);   // free 1600 → 1000
    const rc = await cmds.chromeClientFor(C);   // 1000 − 500 < 1024 → evict idlest (A), free 1600, launch C

    expect(rc.client).not.toBe(null);
    expect(calls).toHaveLength(3);                       // A, B, C each spawned once
    const aHandle = handles.find((h) => h.profileDir.endsWith('A-1'));
    expect(aHandle.child.killed).toBe(true);             // the idlest (A) was evicted
    expect(logs.some((l) => /evicted group Chrome .*A-1/.test(l))).toBe(true);
    expect(logs.some((l) => /launching anyway/.test(l))).toBe(false);   // eviction made room: no override

    // the evicted profile persists on disk → a later ensure relaunches it (room is free again here)
    mem.free = 8192 * MB;
    await cmds.chromeClientFor(A);
    expect(calls).toHaveLength(4);
  });
});

describe('per-profile single-flight + never-relaunch-a-live-profile', () => {
  it('two concurrent ensures of the SAME profile spawn ONE Chrome and share the client', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const [a, b] = await Promise.all([cmds.chromeClientFor(SHARED), cmds.chromeClientFor(SHARED)]);
    expect(calls).toHaveLength(1);
    expect(a.client).toBe(b.client);
  });

  it('a second ensure of a LIVE profile relaunches nothing and returns the running client', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const first = await cmds.chromeClientFor(SHARED);
    const second = await cmds.chromeClientFor(SHARED);
    expect(calls).toHaveLength(1);
    expect(second.client).toBe(first.client);
    expect(second.pid).toBe(first.pid);
  });

  it('two DISTINCT groups each get their own Chrome', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const a = await cmds.chromeClientFor(SHARED);
    const b = await cmds.chromeClientFor({ key: 'Other-2601010000', name: 'Other', group: 'work' });
    expect(calls).toHaveLength(2);
    expect(a.client).not.toBe(b.client);
    expect(a.profileDir).not.toBe(b.profileDir);
  });
});

describe('brain and shared serve many chats: never evicted', () => {
  it('under pressure the idlest OTHER group is evicted, though brain and shared are idler', async () => {
    const mem = { free: 3200 * MB };
    const { cmds, handles, logs } = build({ mem, cost: 600 * MB });
    await cmds.chromeClientFor(BRAIN);                                    // idlest; 2600 free
    await cmds.chromeClientFor(SHARED);                                   // next idlest; 2000 free
    await cmds.chromeClientFor({ key: 'a', name: 'A', group: 'A-1' });   // 1400 free
    const rb = await cmds.chromeClientFor({ key: 'b', name: 'B', group: 'B-1' });   // 1400 − 500 < 1024 → evict
    expect(rb.client).not.toBe(null);
    expect(handles.filter((h) => h.child.killed).map((h) => h.profileDir)).toEqual([join(dirname(CHROME_BRAIN_PROFILE), 'A-1')]);
    expect(logs.filter((l) => /evicted/.test(l))).toHaveLength(1);
  });

  it('with only brain and shared up, a newcomer that does not fit LAUNCHES ANYWAY, never evicting them', async () => {
    const mem = { free: 2200 * MB };
    const { cmds, calls, handles, logs } = build({ mem, cost: 600 * MB });
    await cmds.chromeClientFor(BRAIN);
    await cmds.chromeClientFor(SHARED);                                   // 1000 free
    const r = await cmds.chromeClientFor({ key: 'a', name: 'A', group: 'A-1' });
    expect(r.client).not.toBe(null);
    expect(calls).toHaveLength(3);
    expect(handles.some((h) => h.child.killed)).toBe(false);
    expect(logs.filter((l) => /memory looks short .*A-1.*launching anyway/.test(l))).toHaveLength(1);
  });
});

describe('a profile another Chrome already holds is never launched over', () => {
  it('brain open in a normal window → no spawn, one log line, a clear answer', async () => {
    const asked = [];
    const { cmds, calls, logs } = build({ mem: { free: 8192 * MB }, profileHolder: (dir) => { asked.push(dir); return 'EBUSY'; } });
    const r = await cmds.startBrowser(BRAIN);
    expect(r).toEqual({ ok: false, reason: 'no-browser', detail: 'the "brain" browser is open in a normal window; close it to hand it back to the spine' });
    expect(asked).toEqual([CHROME_BRAIN_PROFILE]);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /not launching "brain" Chrome .*another Chrome holds it \(EBUSY\)/.test(l))).toHaveLength(1);
  });

  it('the holder is asked only when about to launch — never for a Chrome the pool already runs', async () => {
    let held = false;
    const { cmds, calls } = build({ mem: { free: 8192 * MB }, profileHolder: () => (held ? 'EBUSY' : null) });
    const first = await cmds.chromeClientFor(SHARED);
    held = true;   // our own pipe Chrome now holds the lockfile
    const again = await cmds.chromeClientFor(SHARED);
    expect(again.client).toBe(first.client);
    expect(calls).toHaveLength(1);
  });

  it('once the window closes, the next ask launches it over the pipe', async () => {
    let held = 'EBUSY';
    const { cmds, calls } = build({ mem: { free: 8192 * MB }, profileHolder: () => held });
    expect((await cmds.chromeClientFor(SHARED)).client).toBe(null);
    held = null;
    expect((await cmds.chromeClientFor(SHARED)).client).not.toBe(null);
    expect(calls).toHaveLength(1);
  });
});
