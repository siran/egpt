// beeper-update.test.mjs — /update beeper and the Beeper update check (src/tools/beeper-update.mjs),
// driven through fakes; the .ps1 plan and the service-permission SDDL on win32 (touching nothing).
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  autoUpdateMethod, stateOf, cmpVersion, detect, statusLine, noticeLine, resultLine, startLine,
  peerUpdating, lastJson, createBeeperUpdate, holdLine, quitLine, CLOSE_TRY_SEC, CLOSE_WAIT_SEC,
  runToolDry, runTool,
} from '../src/tools/beeper-update.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { lifecycleExit } from '../src/spine/ingest.mjs';
import { COMMANDS } from '../src/interpreter.mjs';
import { createEarProbe } from '../src/ear-probe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'egpt-beeper-update-'));
const flush = () => new Promise((r) => setTimeout(r, 0));

// reve on 2026-10-19: 4.3.176 installed and running, 4.3.209 downloaded.
const REVE = () => ({
  installed: '4.3.176',
  pending: { fileName: 'Beeper x64 4.3.209.exe', version: '4.3.209', adminRequired: false },
  running: [{ name: 'primary', port: 23373, version: '4.3.176' }, { name: 'secondary', port: 23374, version: '4.3.176' }],
  latest: { version: '4.3.209' },
});

describe('beeper.auto_update — the method per OS', () => {
  it('defaults to manual on windows and to none elsewhere, silently', () => {
    expect(autoUpdateMethod({}, 'win32')).toEqual({ os: 'windows', method: 'manual', note: null });
    expect(autoUpdateMethod({}, 'linux')).toEqual({ os: 'linux', method: 'none', note: null });
    expect(autoUpdateMethod({ beeper: { primary: { token: 't' } } }, 'darwin')).toEqual({ os: 'mac', method: 'none', note: null });
  });

  it('reads auto | manual | none per OS', () => {
    for (const m of ['auto', 'manual', 'none']) {
      expect(autoUpdateMethod({ beeper: { auto_update: { windows: { method: m } } } }, 'win32').method).toBe(m);
    }
    expect(autoUpdateMethod({ beeper: { auto_update: { windows: { method: ' Auto ' } } } }, 'win32').method).toBe('auto');
  });

  it('linux and mac accept a method but run none, with ONE note to log at boot', () => {
    const l = autoUpdateMethod({ beeper: { auto_update: { linux: { method: 'manual' } } } }, 'linux');
    expect(l.method).toBe('none');
    expect(l.note).toMatch(/not implemented on linux/);
    const m = autoUpdateMethod({ beeper: { auto_update: { mac: { method: 'auto' } } } }, 'darwin');
    expect(m.method).toBe('none');
    expect(m.note).toMatch(/not implemented on mac/);
  });

  it('an unknown method is none, said once', () => {
    const r = autoUpdateMethod({ beeper: { auto_update: { windows: { method: 'sometimes' } } } }, 'win32');
    expect(r.method).toBe('none');
    expect(r.note).toMatch(/not auto \| manual \| none/);
  });

  it('the tick logs the not-implemented note once, and never checks', async () => {
    const lines = [];
    let detects = 0;
    const u = createBeeperUpdate({ getConfig: () => ({ beeper: { auto_update: { linux: { method: 'auto' } } } }), platform: 'linux', home: tmp(), detect: async () => { detects += 1; return REVE(); }, onLog: (m) => lines.push(m) });
    u.tick(0); u.tick(CHECK_LATER); await flush(); await flush();
    expect(lines.filter((l) => /not implemented on linux/.test(l))).toHaveLength(1);
    expect(detects).toBe(0);
  });
});
const CHECK_LATER = 7 * 3_600_000;

describe('detection — the states, from structured facts only', () => {
  it('versions compare numerically', () => {
    expect(cmpVersion('4.3.10', '4.3.9')).toBe(1);
    expect(cmpVersion('4.3.209', '4.3.209')).toBe(0);
    expect(cmpVersion('4.3.176', '4.3.209')).toBe(-1);
  });

  it('downloaded: a newer download (reve)', () => expect(stateOf(REVE())).toBe('downloaded'));

  it('up-to-date: a STALE download equal to the install (dolly)', () => {
    expect(stateOf({ installed: '4.3.209', pending: { version: '4.3.209', adminRequired: false }, running: [{ name: 'primary', port: 23373, version: '4.3.209' }], latest: { version: '4.3.209' } })).toBe('up-to-date');
  });

  it('blocked: the download needs admin rights', () => {
    const d = REVE();
    d.pending.adminRequired = true;
    expect(stateOf(d)).toBe('blocked');
  });

  it('restart-needed: installed newer than a running Beeper', () => {
    expect(stateOf({ installed: '4.3.209', pending: null, running: [{ name: 'primary', port: 23373, version: '4.3.209' }, { name: null, port: 23375, version: '4.3.176' }], latest: { version: '4.3.209' } })).toBe('restart-needed');
  });

  it('available: the feed is newer and nothing is downloaded yet', () => {
    expect(stateOf({ installed: '4.3.176', pending: null, running: [], latest: { version: '4.3.209' } })).toBe('available');
    expect(stateOf({ installed: '4.3.176', pending: { version: '4.3.100', adminRequired: false }, running: [], latest: { version: '4.3.209' } })).toBe('available');
  });

  it('detect() reads /v1/info, the tokens, update-info.json and the feed — auto_update is not a connection', async () => {
    const lad = tmp();
    mkdirSync(join(lad, 'beepertexts-updater', 'pending'), { recursive: true });
    writeFileSync(join(lad, 'beepertexts-updater', 'pending', 'update-info.json'), JSON.stringify({ fileName: 'Beeper x64 4.3.209.exe', sha512: 'x', isAdminRightsRequired: false }));
    const owners = { 23373: 'tok-primary', 23374: 'tok-secondary' };
    const fetchImpl = async (url, opts = {}) => {
      const u = new URL(url);
      if (u.hostname === 'api.beeper.com') return { status: 200, json: async () => ({ version: '4.3.209', url: 'https://example.invalid/Beeper%20x64%204.3.209.exe', sha512: 'c2hh', download_size: 1, pub_date: '2026-10-15T11:58:08+00:00' }) };
      const port = Number(u.port);
      if (![23373, 23374, 23375].includes(port)) throw new Error('ECONNREFUSED');
      if (u.pathname === '/v1/info') return { status: 200, json: async () => ({ app: { version: '4.3.176' }, server: { port } }) };
      const ok = opts.headers?.Authorization === `Bearer ${owners[port]}`;
      return { status: ok ? 200 : 401, json: async () => [] };
    };
    const cfg = { beeper: { primary: { token: 'tok-primary' }, secondary: { token: 'tok-secondary' }, auto_update: { windows: { method: 'manual' } }, use: 'secondary' } };
    const d = await detect(cfg, { fetchImpl, installedVersion: async () => '4.3.176', localAppData: lad });
    expect(d.installed).toBe('4.3.176');
    expect(d.pending).toEqual({ fileName: 'Beeper x64 4.3.209.exe', version: '4.3.209', adminRequired: false });
    expect(d.latest).toEqual({ version: '4.3.209', date: '2026-10-15T11:58:08+00:00', url: 'https://example.invalid/Beeper%20x64%204.3.209.exe', sha512: 'c2hh' });
    expect(d.running).toEqual([
      { name: 'primary', port: 23373, version: '4.3.176' },
      { name: 'secondary', port: 23374, version: '4.3.176' },
      { name: null, port: 23375, version: '4.3.176' },
    ]);
    expect(stateOf(d)).toBe('downloaded');
    expect(statusLine('kg', d)).toBe('kg · Beeper 4.3.176 · 4.3.209 downloaded · running primary 4.3.176 :23373, secondary 4.3.176 :23374, other 4.3.176 :23375');
    rmSync(lad, { recursive: true, force: true });
  });

  it('the feed answering 204 means nothing newer', async () => {
    const d = await detect({}, { fetchImpl: async (url) => { if (String(url).includes('api.beeper.com')) return { status: 204, json: async () => null }; throw new Error('ECONNREFUSED'); }, installedVersion: async () => '4.3.209', localAppData: tmp() });
    expect(d.latest).toEqual({ version: '4.3.209', date: null });
    expect(stateOf(d)).toBe('up-to-date');
    expect(statusLine('do', d)).toBe('do · Beeper 4.3.209 · up to date');
  });

  it('the status lines say the state in words', () => {
    const blocked = REVE(); blocked.pending.adminRequired = true;
    expect(statusLine('kg', blocked)).toMatch(/^kg · Beeper 4\.3\.176 · 4\.3\.209 downloaded, blocked: needs admin rights · running /);
    const avail = { installed: '4.3.176', pending: null, running: [], latest: { version: '4.3.209' } };
    expect(statusLine('kg', avail, 'available', '/e update beeper')).toBe('kg · Beeper 4.3.176 · 4.3.209 available — /e update beeper downloads and installs it');
    expect(statusLine('kg', avail)).toBe('kg · Beeper 4.3.176 · 4.3.209 available — /update beeper downloads and installs it');
  });
});

// A service on fakes: every seam records into `calls`, in order.
function rig({ detect: det = REVE, plan = { ok: true, flow: 'services' }, result = null, log = [], method = 'manual', node = 'kg', home = tmp(), restartPending = () => false, platform = 'win32', runThrows = null, runs = [], fetchImpl = async () => { throw new Error('no network in tests'); } } = {}) {
  const calls = [], posts = [], edits = [], lines = [], tool = [];
  let drained = null;
  const cfg = { node_name: node, beeper: { auto_update: { windows: { method } } } };
  const u = createBeeperUpdate({
    getConfig: () => cfg, platform, home, repoRoot: 'C:\\egpt', fetchImpl,
    detect: async () => { calls.push('detect'); return det(); },
    dryRun: async (o) => { calls.push(`dryRun${o.restartOnly ? ':restartOnly' : ''}`); tool.push({ dryRun: true, ...o }); return plan; },
    run: async (o) => {
      tool.push(o);
      calls.push(`run${o.restartOnly ? ':restartOnly' : ''}${o.closeAppOnly ? `:closeAppOnly:${o.waitSec}` : ''}${o.relaunchApp ? ':relaunchApp' : ''}`);
      if (runThrows) throw runThrows;
      const next = runs.shift();
      if (next) return typeof next === 'function' ? next(o) : next;
      return result ?? { ok: true, restartSec: 72, connections: [{ name: 'primary', status: 'ok' }, { name: 'secondary', status: 'ok' }] }; },
    drain: (fn) => { calls.push('drain'); drained = fn; },
    restartPending,
    beeperRestart: async (on) => { calls.push(`beeperRestart:${on}`); },
    logToGroup: async (t) => { calls.push(`post:${t.slice(0, 2)}`); posts.push(t); return true; },
    readLog: async () => { calls.push('readLog'); return [...log, ...posts.map((text, i) => ({ id: `p${i}`, text, ts: 0 }))]; },
    editLog: async (id, t) => { calls.push('edit'); edits.push({ id, t }); return true; },
    hint: () => '/e update beeper',
    ownNames: () => new Set([node]),
    now: () => 0,
    onLog: (m) => lines.push(m),
  });
  return { u, calls, posts, edits, lines, home, tool, runDrain: async () => { await drained?.(); for (let i = 0; i < 5; i++) await flush(); } };
}

describe('the notice — ONE line per newly downloaded version, per node', () => {
  it('manual: one line, never repeated, persisted across a restart, a new version is a new line', async () => {
    const home = tmp();
    const a = rig({ home });
    await a.u.check();
    await a.u.check();
    expect(a.posts).toEqual(['⬆ kg · Beeper 4.3.209 downloaded (running 4.3.176) — send /e update beeper']);
    const b = rig({ home });   // the next spine, same profile
    await b.u.check();
    expect(b.posts).toEqual([]);
    const c = rig({ home, detect: () => ({ ...REVE(), pending: { version: '4.3.210', adminRequired: false } }) });
    await c.u.check();
    expect(c.posts).toEqual(['⬆ kg · Beeper 4.3.210 downloaded (running 4.3.176) — send /e update beeper']);
    expect([...a.calls, ...b.calls, ...c.calls]).not.toContain('drain');   // manual never installs by itself
  });

  it('none: no detection, no notice', async () => {
    const r = rig({ method: 'none' });
    expect(await r.u.check()).toBe(null);
    expect(r.calls).toEqual([]);
  });

  it('nothing downloaded: no notice', async () => {
    const r = rig({ detect: () => ({ ...REVE(), pending: null }) });
    expect(await r.u.check()).toBe('available');
    expect(r.posts).toEqual([]);
  });

  it('blocked: the notice names the launcher that asks for administrator', async () => {
    const r = rig({ detect: () => ({ ...REVE(), pending: { version: '4.3.209', adminRequired: true } }) });
    await r.u.check();
    expect(r.posts).toEqual(['⬆ kg · Beeper 4.3.209 downloaded, needs admin rights — run C:\\egpt\\src\\tools\\beeper-update.cmd (it asks for administrator)']);
  });

  it('auto: the notice, then the drain — once per version', async () => {
    const r = rig({ method: 'auto' });
    await r.u.check();
    expect(r.posts[0]).toBe('⬆ kg · Beeper 4.3.209 downloaded (running 4.3.176) — installing at the next quiet moment');
    expect(r.calls.filter((c) => c === 'drain')).toHaveLength(1);
    await r.runDrain();
    await r.u.check();
    expect(r.calls.filter((c) => c === 'drain')).toHaveLength(1);
  });

  it('auto refused (no permission): said once, not retried every 6 h', async () => {
    const r = rig({ method: 'auto', plan: { ok: false, step: 'permission', error: 'this user may not stop/start egpt-beeper-primary', remedy: 'run C:\\egpt\\setup\\grant-beeper-service-control.cmd once as administrator' } });
    await r.u.check();
    await r.u.check();
    expect(r.posts.filter((p) => /needs elevation/.test(p))).toEqual(['kg · Beeper 4.3.209 not installed: needs elevation: run C:\\egpt\\setup\\grant-beeper-service-control.cmd once as administrator']);
    expect(r.calls).not.toContain('drain');
  });

  it('noticeLine and the tick: first tick checks, the next one within 6 h does not', async () => {
    const r = rig();
    r.u.tick(1000);
    r.u.tick(2000);
    for (let i = 0; i < 5; i++) await flush();
    expect(r.calls.filter((c) => c === 'detect')).toHaveLength(1);
    expect(noticeLine('do', REVE(), 'downloaded', { method: 'manual', hint: '/don update beeper' })).toBe('⬆ do · Beeper 4.3.209 downloaded (running 4.3.176) — send /don update beeper');
  });
});

describe('/<handle> update beeper — the command', () => {
  const OP = { whatsapp: { chat_id: '!self' }, agents: { e: {} } };
  const cmdHarness = (beeperUpdate) => {
    const sent = [];
    const cmds = createCommands({ getConfig: () => OP, send: async (chatId, text) => sent.push(text), beeperUpdate, io: { writeFile: async () => {}, mkdir: async () => {} } });
    // A typed line as the spine reads it: `/<handle> <command>` → the command (commandOf), else the line.
    const typed = (body, over = {}) => { const ev = { surface: 'whatsapp', chatId: '!self', body, ...over }; return cmds.commandOf(ev) ?? ev; };
    return { cmds, sent, typed };
  };

  it('is registered as /update, wired, and is not /upgrade', () => {
    const e = COMMANDS.find((c) => c.cmd === '/update');
    expect(e).toMatchObject({ usage: '/<handle> update beeper', wired: true });
    expect(lifecycleExit('/update beeper')).toBe(null);
    expect(lifecycleExit('/upgrade')).toBe(42);
  });

  it('operator: /e update beeper runs the update on e\'s node and replies with its line', async () => {
    let n = 0;
    const { cmds, sent, typed } = cmdHarness({ update: async () => { n += 1; return 'kg · Beeper 4.3.209 · up to date'; } });
    const ev = typed('/e update beeper');
    expect(ev).toMatchObject({ body: '/update beeper', commandBeing: 'e' });
    expect(await cmds.isCommand(ev)).toBe(true);
    await cmds.run(ev);
    expect(n).toBe(1);
    expect(sent).toEqual(['kg · Beeper 4.3.209 · up to date']);
  });

  it('a progress line (the download starting) reaches the same chat before the reply', async () => {
    const { cmds, sent, typed } = cmdHarness({ update: async (say) => { await say('⬇ downloading'); return 'the reply'; } });
    await cmds.run(typed('/e update beeper'));
    expect(sent).toEqual(['⬇ downloading', 'the reply']);
  });

  it('another node\'s handle runs nothing here', async () => {
    const { cmds, typed } = cmdHarness({ update: async () => 'x' });
    const ev = typed('/don update beeper');
    expect(ev.commandElsewhere).toBe('don');
    expect(await cmds.isCommand(ev)).toBe(false);
  });

  it('an unknown or missing target gets the usage line, in the handle typed', async () => {
    let n = 0;
    const { cmds, sent, typed } = cmdHarness({ update: async () => { n += 1; return 'x'; } });
    await cmds.run(typed('/e update foo'));
    await cmds.run(typed('/e update'));
    const usage = 'usage: /e update beeper — install the Beeper update this node downloaded (eGPT itself: /e upgrade)';
    expect(sent).toEqual([usage, usage]);
    expect(n).toBe(0);
  });

  it('operator only, and never bare in a chat', async () => {
    const { cmds, typed } = cmdHarness({ update: async () => 'x' });
    expect(await cmds.isCommand(typed('/e update beeper', { chatId: '!some-group', senderId: '@someone:beeper.local' }))).toBe(false);
    expect(await cmds.isCommand(typed('/update beeper'))).toBe(false);
  });

  it('the notice names the node\'s own handle (boot passes commands.hintOf)', () => {
    const kg = createCommands({ getConfig: () => OP, defaultKey: 'e', send: async () => {} });
    const dolly = createCommands({ getConfig: () => ({ agents: { egpt: { handles: ['don', 'egpt'], default: true } } }), defaultKey: 'egpt', send: async () => {} });
    expect(kg.hintOf('update beeper')).toBe('/e update beeper');
    expect(dolly.hintOf('update beeper')).toBe('/don update beeper');
  });

  it('a node without the service says so', async () => {
    const { cmds, sent, typed } = cmdHarness(null);
    await cmds.run(typed('/e update beeper'));
    expect(sent).toEqual(['Beeper updates are not wired on this node']);
  });
});

describe('/update beeper — the flow', () => {
  it('nothing to install: the one-line state, nothing else runs', async () => {
    const r = rig({ detect: () => ({ ...REVE(), pending: null, latest: { version: '4.3.176' } }) });
    expect(await r.u.update()).toBe('kg · Beeper 4.3.176 · up to date · running primary 4.3.176 :23373, secondary 4.3.176 :23374');
    expect(r.calls).toEqual(['detect']);
  });

  it('refuses without the service permission, names the remedy, and touches nothing', async () => {
    const r = rig({ plan: { ok: false, step: 'permission', error: 'this user may not stop/start egpt-beeper-secondary', remedy: 'run C:\\egpt\\setup\\grant-beeper-service-control.cmd once as administrator' } });
    expect(await r.u.update()).toBe('kg · Beeper 4.3.209 not installed: needs elevation: run C:\\egpt\\setup\\grant-beeper-service-control.cmd once as administrator');
    expect(r.calls).toEqual(['detect', 'dryRun']);
    expect(r.u.busy()).toBe(false);
  });

  it('other refusals carry the tool\'s own reason and fix', async () => {
    const r = rig({ plan: { ok: false, step: 'sha512', error: 'the download does not match its sha512', remedy: 'delete X and let Beeper download it again' } });
    expect(await r.u.update()).toBe('kg · Beeper 4.3.209 not installed: the download does not match its sha512 — delete X and let Beeper download it again');
  });

  it('drain first; once quiet: the peer check, the start line, the restart state around the tool, then ONE result line', async () => {
    const r = rig();
    const reply = await r.u.update();
    expect(reply).toMatch(/^⏳ kg · Beeper 4\.3\.176 → 4\.3\.209: restarting Beeper for the update once turns finish/);
    expect(r.calls).toEqual(['detect', 'dryRun', 'drain']);   // the tool waits for the drain
    expect(r.u.busy()).toBe(true);
    await r.runDrain();
    expect(r.calls.slice(3)).toEqual(['readLog', 'post:🔄', 'beeperRestart:true', 'run', 'beeperRestart:false', 'readLog', 'edit']);
    expect(r.posts[0]).toMatch(/^🔄 kg · Beeper 4\.3\.176 → 4\.3\.209 · restarting for update… ⟦bu-kg-/);
    expect(r.edits).toEqual([{ id: 'p0', t: '🔄 kg · Beeper 4.3.176 → 4.3.209 · restarted in 72 s · primary ✓ · secondary ✓' }]);
    expect(r.u.busy()).toBe(false);
  });

  describe('the open app goes first, with every bridge still serving', () => {
    const OPEN = { ok: true, flow: 'services', closeApp: true };
    const HID = { ok: false, quit: false, step: 'close-app', error: 'the Beeper app hid instead of quitting', remedy: 'quit Beeper from its tray icon (Quit), then update again', connections: [] };
    const QUIT = { ok: true, quit: true };
    const ASK = '⏳ kg · Beeper 4.3.176 → 4.3.209: quit Beeper from the tray (Quit) and the update continues; nothing is stopped until then';

    it('it only hides: ONE line asking for the tray Quit, the long wait, then the restart state and the run that relaunches it', async () => {
      const r = rig({ plan: OPEN, runs: [HID, QUIT] });
      await r.u.update();
      await r.runDrain();
      expect(r.calls.slice(3)).toEqual(['readLog', 'post:🔄', `run:closeAppOnly:${CLOSE_TRY_SEC}`, 'post:⏳ ', `run:closeAppOnly:${CLOSE_WAIT_SEC}`, 'beeperRestart:true', 'run:relaunchApp', 'beeperRestart:false', 'readLog', 'edit']);
      expect(r.posts.filter((p) => p.startsWith('⏳'))).toEqual([ASK]);
      expect(quitLine('kg', '4.3.176', '4.3.209')).toBe(ASK);
      expect(r.edits).toEqual([{ id: 'p0', t: '🔄 kg · Beeper 4.3.176 → 4.3.209 · restarted in 72 s · primary ✓ · secondary ✓' }]);
      expect([CLOSE_TRY_SEC, CLOSE_WAIT_SEC]).toEqual([30, 570]);
      expect(r.u.busy()).toBe(false);
    });

    it('it quits on WM_CLOSE: no tray line, straight on, and it is relaunched', async () => {
      const r = rig({ plan: OPEN, runs: [QUIT] });
      await r.u.update();
      await r.runDrain();
      expect(r.calls.slice(3)).toEqual(['readLog', 'post:🔄', `run:closeAppOnly:${CLOSE_TRY_SEC}`, 'beeperRestart:true', 'run:relaunchApp', 'beeperRestart:false', 'readLog', 'edit']);
      expect(r.posts.some((p) => p.startsWith('⏳'))).toBe(false);
    });

    it('nobody quits it in time: today\'s refusal line, nothing stopped, no restart state', async () => {
      const r = rig({ plan: OPEN, runs: [HID, HID] });
      await r.u.update();
      await r.runDrain();
      expect(r.calls.slice(3)).toEqual(['readLog', 'post:🔄', `run:closeAppOnly:${CLOSE_TRY_SEC}`, 'post:⏳ ', `run:closeAppOnly:${CLOSE_WAIT_SEC}`, 'readLog', 'edit']);
      expect(r.calls).not.toContain('beeperRestart:true');
      expect(r.posts.filter((p) => p.startsWith('⏳'))).toEqual([ASK]);
      expect(r.edits[0].t).toBe('🔄 kg · Beeper 4.3.176 → 4.3.209 · FAILED at close-app: the Beeper app hid instead of quitting — quit Beeper from its tray icon (Quit), then update again');
      expect(r.u.busy()).toBe(false);
    });

    it('the close step itself fails: that is the result, no tray line, no restart state', async () => {
      const r = rig({ plan: OPEN, runs: [{ ok: false, step: 'tool', error: 'spawn powershell.exe ENOENT' }] });
      await r.u.update();
      await r.runDrain();
      expect(r.calls).not.toContain('beeperRestart:true');
      expect(r.posts.some((p) => p.startsWith('⏳'))).toBe(false);
      expect(r.edits[0].t).toBe('🔄 kg · Beeper 4.3.176 → 4.3.209 · FAILED at tool: spawn powershell.exe ENOENT');
    });

    it('a handover hold during the wait is refused; the update goes on when he quits', async () => {
      let quit;
      const r = rig({ plan: OPEN, runs: [HID, () => new Promise((res) => { quit = res; })] });
      await r.u.update();
      await r.runDrain();
      expect(r.calls.at(-1)).toBe(`run:closeAppOnly:${CLOSE_WAIT_SEC}`);
      expect(r.u.busy()).toBe(true);
      expect(await r.u.hold(true)).toBe(false);
      expect(r.lines).toContain('hold refused: an update is under way');
      expect(r.calls).not.toContain('beeperRestart:true');
      quit(QUIT);
      for (let i = 0; i < 10; i++) await flush();
      expect(r.calls.slice(-5)).toEqual(['beeperRestart:true', 'run:relaunchApp', 'beeperRestart:false', 'readLog', 'edit']);
      expect(r.u.busy()).toBe(false);
    });
  });

  it('a peer already restarting its Beeper: no restart here, one line saying so', async () => {
    const r = rig({ log: [{ id: 'x', text: '🔄 do · Beeper 4.3.176 → 4.3.209 · restarting for update… ⟦bu-do-1⟧', ts: 0 }] });
    await r.u.update();
    await r.runDrain();
    expect(r.calls).not.toContain('run');
    expect(r.calls).not.toContain('beeperRestart:true');
    expect(r.posts).toEqual(['⏸ kg · Beeper 4.3.176 → 4.3.209 not started — do is restarting its Beeper for an update; send /e update beeper again after its 🔄 line']);
    expect(r.u.busy()).toBe(false);
  });

  it('a busy update refuses a second; idle() settles when it is done', async () => {
    const r = rig();
    await r.u.update();
    expect(await r.u.update()).toBe('kg · a Beeper update is already under way');
    const idle = r.u.idle();
    await r.runDrain();
    await expect(idle).resolves.toBeUndefined();
  });

  it('a pending /restart goes first', async () => {
    const r = rig({ restartPending: () => true });
    expect(await r.u.update()).toBe('kg · a restart is pending — send /e update beeper after it');
    expect(r.calls).toEqual([]);
  });

  it('restart-needed restarts without installing', async () => {
    const r = rig({ detect: () => ({ installed: '4.3.209', pending: { version: '4.3.209', adminRequired: false }, running: [{ name: 'primary', port: 23373, version: '4.3.176' }], latest: { version: '4.3.209' } }) });
    expect(await r.u.update()).toMatch(/Beeper 4\.3\.176 → 4\.3\.209/);
    await r.runDrain();
    expect(r.calls).toContain('dryRun:restartOnly');
    expect(r.calls).toContain('run:restartOnly');
  });

  it('a tool that throws still ends the restart state, and the line says what failed', async () => {
    const r = rig({ runThrows: new Error('spawn powershell.exe ENOENT') });
    await r.u.update();
    await r.runDrain();
    expect(r.calls).toContain('beeperRestart:false');
    expect(r.edits[0].t).toBe('🔄 kg · Beeper 4.3.176 → 4.3.209 · FAILED at tool: spawn powershell.exe ENOENT');
  });

  it('blocked: the state line names the launcher that asks for administrator; nothing runs', async () => {
    const r = rig({ detect: () => ({ ...REVE(), pending: { version: '4.3.209', adminRequired: true } }) });
    expect(await r.u.update()).toMatch(/· 4\.3\.209 downloaded, blocked: needs admin rights · running .* — run C:\\egpt\\src\\tools\\beeper-update\.cmd \(it asks for administrator\)$/);
    expect(r.calls).toEqual(['detect']);
  });

  it('a failure entering the restart state still clears it, and the line says so', async () => {
    let first = true;
    const calls = [];
    const u = createBeeperUpdate({
      getConfig: () => ({ node_name: 'kg' }), platform: 'win32', home: tmp(), now: () => 0,
      detect: async () => REVE(), dryRun: async () => ({ ok: true, flow: 'app' }), run: async () => { calls.push('run'); return { ok: true }; },
      drain: (fn) => fn(),
      beeperRestart: async (on) => { calls.push(`beeperRestart:${on}`); if (on && first) { first = false; throw new Error('bridge gone'); } },
      logToGroup: async (t) => { calls.push(t); return true; },
    });
    await u.update();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toContain('beeperRestart:false');
    expect(calls).not.toContain('run');
    expect(calls.at(-1)).toBe('🔄 kg · Beeper 4.3.176 → 4.3.209 · FAILED at tool: bridge gone');
    expect(u.busy()).toBe(false);
  });

  it('not implemented off Windows', async () => {
    const r = rig({ platform: 'linux' });
    expect(await r.u.update()).toBe('kg · Beeper updates are not implemented on linux yet');
    expect(r.calls).toEqual([]);
  });
});

// kg on 2026-10-30: 4.3.229 installed and running, the feed offers 4.3.264, Beeper's own updater never
// downloaded it (and empties its pending folder, so eGPT keeps its download in its own).
const BYTES = Buffer.from('fake installer bytes');
const b64 = (buf) => createHash('sha512').update(buf).digest('base64');
const FILE = 'Beeper x64 4.3.264.exe';
const KG = () => ({
  installed: '4.3.229', pending: null,
  running: [{ name: 'primary', port: 23373, version: '4.3.229' }, { name: 'secondary', port: 23374, version: '4.3.229' }],
  latest: { version: '4.3.264', date: null, url: `https://example.invalid/builds/${encodeURIComponent(FILE)}`, sha512: b64(BYTES) },
});
const serving = (bytes, fetched = []) => async (url) => { fetched.push(String(url)); return new Response(bytes, { status: 200, headers: { 'content-length': String(235 * 2 ** 20) } }); };

describe('/update beeper — available: eGPT downloads the feed\'s installer itself', () => {
  const dlDir = (home) => join(home, 'state', 'beeper-update');

  it('downloads into state/beeper-update, says so once, then plans and runs the tool on THAT installer', async () => {
    const fetched = [], said = [];
    const r = rig({ detect: KG, fetchImpl: serving(BYTES, fetched) });
    const reply = await r.u.update((t) => { said.push(t); });
    const path = join(dlDir(r.home), FILE);
    expect(fetched).toEqual([KG().latest.url]);
    expect(readFileSync(path)).toEqual(BYTES);
    expect(readdirSync(dlDir(r.home))).toEqual([FILE]);   // no temp name left behind
    expect(said).toEqual(['⬇ kg · Beeper 4.3.229 → 4.3.264: downloading the installer (235 MB) first']);
    expect(reply).toMatch(/^⏳ kg · Beeper 4\.3\.229 → 4\.3\.264: restarting Beeper for the update once turns finish/);
    expect(r.calls).toEqual(['detect', 'dryRun', 'drain']);
    await r.runDrain();
    expect(r.tool).toEqual([
      { dryRun: true, restartOnly: false, installer: path, sha512: b64(BYTES) },
      { restartOnly: false, relaunchApp: false, installer: path, sha512: b64(BYTES) },
    ]);
    expect(r.edits[0].t).toBe('🔄 kg · Beeper 4.3.229 → 4.3.264 · restarted in 72 s · primary ✓ · secondary ✓');
  });

  it('a sha512 mismatch: the download is deleted, ONE refusal line, nothing else runs', async () => {
    const said = [];
    const r = rig({ detect: KG, fetchImpl: serving(Buffer.from('tampered')) });
    expect(await r.u.update((t) => { said.push(t); })).toBe('kg · Beeper 4.3.264 not downloaded: the download does not match the feed\'s sha512 — deleted');
    expect(said).toHaveLength(1);
    expect(readdirSync(dlDir(r.home))).toEqual([]);
    expect(r.calls).toEqual(['detect']);
    expect(r.u.busy()).toBe(false);
  });

  it('a complete file whose sha512 already matches is reused: no fetch, no download line', async () => {
    const said = [];
    const r = rig({ detect: KG, fetchImpl: async () => { throw new Error('must not fetch'); } });
    mkdirSync(dlDir(r.home), { recursive: true });
    writeFileSync(join(dlDir(r.home), FILE), BYTES);
    expect(await r.u.update((t) => { said.push(t); })).toMatch(/^⏳ kg · Beeper 4\.3\.229 → 4\.3\.264/);
    expect(said).toEqual([]);
    expect(r.tool[0]).toEqual({ dryRun: true, restartOnly: false, installer: join(dlDir(r.home), FILE), sha512: b64(BYTES) });
  });

  it('a file that does not match (cut short) is downloaded again', async () => {
    const fetched = [];
    const r = rig({ detect: KG, fetchImpl: serving(BYTES, fetched) });
    mkdirSync(dlDir(r.home), { recursive: true });
    writeFileSync(join(dlDir(r.home), FILE), BYTES.subarray(0, 4));
    expect(await r.u.update()).toMatch(/^⏳ /);
    expect(fetched).toHaveLength(1);
    expect(readFileSync(join(dlDir(r.home), FILE))).toEqual(BYTES);
  });

  it('a second /update beeper while it downloads is refused as under way', async () => {
    let open;
    const gate = new Promise((res) => { open = res; });
    const r = rig({ detect: KG, fetchImpl: async () => { await gate; return new Response(BYTES); } });
    const first = r.u.update();
    await flush();
    expect(await r.u.update()).toBe('kg · a Beeper update is already under way');
    open();
    expect(await first).toMatch(/^⏳ /);
  });

  it('a feed without an installer url and sha512: one line, nothing fetched', async () => {
    const r = rig({ detect: () => ({ ...KG(), latest: { version: '4.3.264', date: null, url: null, sha512: null } }) });
    expect(await r.u.update()).toBe('kg · Beeper 4.3.264 not downloaded: the update feed names no installer url and sha512');
    expect(r.calls).toEqual(['detect']);
  });

  it('downloaded (Beeper\'s own pending file) is today\'s path: no fetch, no -Installer', async () => {
    const r = rig({ fetchImpl: async () => { throw new Error('must not fetch'); } });
    await r.u.update();
    await r.runDrain();
    expect(r.tool.map((o) => o.installer)).toEqual([undefined, undefined]);
  });

  it('the tool gets -Installer <path> -Sha512 <b64>, dry run and real run alike', async () => {
    const argvs = [];
    const spawn = (exe, args) => {
      argvs.push(args);
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.kill = () => {};
      setTimeout(() => { c.stdout.emit('data', '{"ok":true}\n'); c.emit('exit', 0); c.emit('close', 0); }, 0);
      return c;
    };
    const home = tmp(), exe = join(home, FILE);
    await runToolDry({ repoRoot: ROOT, home, installer: exe, sha512: 'abc=', spawn });
    await runTool({ repoRoot: ROOT, home, relaunchApp: true, installer: exe, sha512: 'abc=', spawn, readFileImpl: async () => '{"ok":true}' });
    await runToolDry({ repoRoot: ROOT, home, spawn });
    expect(argvs[0].slice(-5)).toEqual(['-DryRun', '-Installer', exe, '-Sha512', 'abc=']);
    expect(argvs[1].slice(-5)).toEqual(['-RelaunchApp', '-Installer', exe, '-Sha512', 'abc=']);
    expect(argvs[2]).not.toContain('-Installer');
  });
});

describe('the Beeper handover hold — /beeper-hold on|off through the ingest box', () => {
  const restarts = (calls) => calls.filter((c) => c.startsWith('beeperRestart'));

  it('holdLine parses exactly on / off; lifecycleExit ignores it', () => {
    expect(holdLine('/beeper-hold on')).toBe(true);
    expect(holdLine(' /beeper-hold off\n')).toBe(false);
    for (const l of ['/beeper-hold', '/beeper-hold ON', '/beeper-hold on now', '/restart', '', null]) expect(holdLine(l)).toBe(null);
    expect(lifecycleExit('/beeper-hold on')).toBe(null);
    expect(lifecycleExit('/beeper-hold off')).toBe(null);
  });

  it('on then off: the restart state once each way, busy in between', async () => {
    const r = rig();
    expect(await r.u.hold(true)).toBe(true);
    expect(r.u.busy()).toBe(true);
    expect(await r.u.hold(false)).toBe(true);
    expect(r.u.busy()).toBe(false);
    expect(r.calls).toEqual(['beeperRestart:true', 'beeperRestart:false']);
  });

  it('a second hold while held is refused', async () => {
    const r = rig();
    await r.u.hold(true);
    expect(await r.u.hold(true)).toBe(false);
    expect(restarts(r.calls)).toEqual(['beeperRestart:true']);
    expect(r.lines).toContain('hold refused: already held');
    await r.u.hold(false);
  });

  it('refused during an update; off during an update leaves its restart state alone', async () => {
    let open;
    const gate = new Promise((res) => { open = res; });
    const calls = [];
    const u = createBeeperUpdate({
      getConfig: () => ({ node_name: 'kg' }), platform: 'win32', home: tmp(), now: () => 0,
      detect: async () => REVE(), dryRun: async () => ({ ok: true, flow: 'services' }),
      run: async () => { calls.push('run'); await gate; return { ok: true }; },
      drain: (fn) => fn(),
      beeperRestart: async (on) => { calls.push(`beeperRestart:${on}`); },
    });
    await u.update();
    for (let i = 0; i < 5; i++) await flush();
    expect(calls).toEqual(['beeperRestart:true', 'run']);   // the update is mid-tool
    expect(await u.hold(true)).toBe(false);
    expect(await u.hold(false)).toBe(false);
    expect(calls).toEqual(['beeperRestart:true', 'run']);
    expect(u.busy()).toBe(true);
    open();
    await u.idle();
    expect(calls).toEqual(['beeperRestart:true', 'run', 'beeperRestart:false']);
    expect(u.busy()).toBe(false);
  });

  it('/update beeper while held refuses with the handover line and runs nothing; the auto check skips', async () => {
    const r = rig({ method: 'auto' });
    await r.u.hold(true);
    expect(await r.u.update()).toBe('kg · a Beeper handover is under way');
    await r.u.check();
    expect(r.calls).not.toContain('dryRun');
    expect(r.calls).not.toContain('drain');
    expect(restarts(r.calls)).toEqual(['beeperRestart:true']);
    await r.u.hold(false);
  });

  it('the cap releases a hold nobody released', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const r = rig();
      await r.u.hold(true);
      await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
      expect(r.u.busy()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(r.calls).toEqual(['beeperRestart:true', 'beeperRestart:false']);
      expect(r.u.busy()).toBe(false);
      expect(r.lines).toContain('hold released by its 180 s cap');
      expect(await r.u.hold(false)).toBe(false);   // nothing left to release
    } finally { vi.useRealTimers(); }
  });

  it('a failure entering the state clears it and refuses', async () => {
    const calls = [];
    const u = createBeeperUpdate({
      getConfig: () => ({ node_name: 'kg' }), platform: 'win32', home: tmp(),
      beeperRestart: async (on) => { calls.push(`beeperRestart:${on}`); if (on) throw new Error('bridge gone'); },
    });
    expect(await u.hold(true)).toBe(false);
    expect(calls).toEqual(['beeperRestart:true', 'beeperRestart:false']);
    expect(u.busy()).toBe(false);
  });
});

describe('the lines', () => {
  it('the result line: success, failure, a connection that did not come back', () => {
    expect(resultLine('kg', { from: '4.3.176', to: '4.3.209', result: { ok: true, restartSec: 72, connections: [{ name: 'primary', status: 'ok' }, { name: 'secondary', status: 'ok' }] } }))
      .toBe('🔄 kg · Beeper 4.3.176 → 4.3.209 · restarted in 72 s · primary ✓ · secondary ✓');
    expect(resultLine('kg', { from: '4.3.176', to: '4.3.209', result: { ok: false, step: 'start', error: 'secondary no-port', restartSec: 190, connections: [{ name: 'primary', status: 'ok' }, { name: 'secondary', status: 'no-port' }] } }))
      .toBe('🔄 kg · Beeper 4.3.176 → 4.3.209 · FAILED at start: secondary no-port · restarted in 190 s · primary ✓ · secondary ✗ no-port');
    expect(resultLine('do', { from: '4.3.176', to: '4.3.209', result: { ok: false, step: 'install', error: 'installer exit 2; Beeper.exe is 4.3.176, expected 4.3.209', restartSec: 40, connections: [] } }))
      .toBe('🔄 do · Beeper 4.3.176 → 4.3.209 · FAILED at install: installer exit 2; Beeper.exe is 4.3.176, expected 4.3.209 · restarted in 40 s');
  });

  it('the peer check reads only another node\'s open, recent start line', () => {
    const line = (n) => ({ text: startLine(n, '4.3.176', '4.3.209', '⟦bu-x⟧'), ts: 1000 });
    expect(peerUpdating([line('do')], { own: new Set(['kg']), nowMs: 2000 })).toBe('do');
    expect(peerUpdating([line('kg')], { own: new Set(['kg']), nowMs: 2000 })).toBe(null);
    expect(peerUpdating([line('do')], { own: new Set(['kg']), nowMs: 1000 + 21 * 60_000 })).toBe(null);
    expect(peerUpdating([{ text: '🔄 do · Beeper 4.3.176 → 4.3.209 · restarted in 72 s · primary ✓', ts: 1000 }], { own: new Set(['kg']), nowMs: 2000 })).toBe(null);
  });

  it('the tool\'s JSON is its last JSON line', () => {
    expect(lastJson('[beeper-update] x\r\n{"ok":true,"flow":"app"}\r\n')).toEqual({ ok: true, flow: 'app' });
    expect(lastJson('[beeper-update] no json here')).toBe(null);
  });
});

describe('the ear probe while Beeper restarts for an update', () => {
  const clock = () => {
    let id = 0; const timers = new Map();
    return { set: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clear: (h) => timers.delete(h), fire: async () => { for (const [k, t] of [...timers]) { timers.delete(k); await t.fn(); } }, size: () => timers.size };
  };

  it('starts no probe while paused', async () => {
    const s = clock(); const injected = [];
    let paused = true;
    createEarProbe({ inject: async (t) => injected.push(t), restart: () => {}, everyMs: 60_000, scheduler: s, paused: () => paused });
    await s.fire();
    expect(injected).toEqual([]);
    paused = false;
    await s.fire();
    expect(injected).toHaveLength(1);
  });

  it('a probe in flight when the restart starts gives no verdict — no restart, no alarm', async () => {
    const s = clock(); const restarts = []; const lines = [];
    let paused = false;
    createEarProbe({ inject: async () => true, restart: (why) => restarts.push(why), everyMs: 60_000, timeoutMs: 45_000, scheduler: s, paused: () => paused, onLog: (m) => lines.push(m) });
    await s.fire();            // the probe goes out; its arrival window is armed
    paused = true;             // Beeper restarts for the update
    await s.fire();            // the window elapses
    expect(restarts).toEqual([]);
    expect(lines.some((l) => /EAR DEAF/.test(l))).toBe(false);
    expect(lines).toContain('ear probe: no verdict — Beeper is restarting for an update');
  });
});

// ── the PowerShell half (win32): the plan on recorded states, and the service permission ─────────
const ps = (args) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true });
const TOOL = join(ROOT, 'src', 'tools', 'beeper-update.ps1');
const LIB = join(ROOT, 'setup', 'beeper-desktop.ps1');

describe.skipIf(process.platform !== 'win32')('beeper-update.ps1 -DryRun on a recorded state (touches nothing)', () => {
  const svc = (name, running, canControl) => ({ name, running, canControl });
  const state = (over = {}) => ({
    system: false, elevated: false, installed: '4.3.176',
    pending: { installer: 'x.exe', version: '4.3.209', adminRequired: false, sha512Ok: true },
    services: [svc('egpt-beeper-primary', true, true), svc('egpt-beeper-secondary', true, true)],
    appRunning: true, ...over,
  });
  const plan = (s, extra = []) => {
    const dir = tmp();
    const f = join(dir, 'state.json');
    writeFileSync(f, JSON.stringify(s));
    const r = ps(['-File', TOOL, '-StateFile', f, '-LocalAppData', dir, ...extra]);
    rmSync(dir, { recursive: true, force: true });
    return lastJson(r.stdout);
  };

  it('services flow: stop both, close the app, install, start them one at a time, the app last', { timeout: 30_000 }, () => {
    expect(plan(state())).toEqual({ ok: true, dryRun: true, flow: 'services', from: '4.3.176', to: '4.3.209', install: true, stop: ['egpt-beeper-primary', 'egpt-beeper-secondary'], closeApp: true, start: ['egpt-beeper-primary', 'egpt-beeper-secondary'], relaunchApp: true });
  });

  it('app-only flow: no Beeper service → no stop/start and no permission check', { timeout: 30_000 }, () => {
    expect(plan(state({ services: [] }))).toEqual({ ok: true, dryRun: true, flow: 'app', from: '4.3.176', to: '4.3.209', install: true, stop: [], closeApp: true, start: [], relaunchApp: true });
    // A service that is installed but not running is left alone, and its permission is never asked.
    expect(plan(state({ services: [svc('egpt-beeper-primary', false, false)] }))).toMatchObject({ ok: true, flow: 'app', stop: [], start: [] });
  });

  it('no permission on a running service: refused before anything, the remedy is the grant launcher', { timeout: 30_000 }, () => {
    const r = plan(state({ services: [svc('egpt-beeper-primary', true, true), svc('egpt-beeper-secondary', true, false)] }));
    expect(r).toMatchObject({ ok: false, step: 'permission', error: 'this user may not stop/start egpt-beeper-secondary' });
    expect(r.remedy).toBe(`run ${join(ROOT, 'setup', 'grant-beeper-service-control.cmd')} once as administrator`);
  });

  it('refuses a stale download, a sha512 mismatch, an admin-rights installer, nothing downloaded, and SYSTEM', { timeout: 60_000 }, () => {
    expect(plan(state({ pending: { installer: 'x.exe', version: '4.3.176', adminRequired: false, sha512Ok: true } }))).toMatchObject({ ok: false, step: 'nothing-to-install' });
    expect(plan(state({ pending: { installer: 'x.exe', version: '4.3.209', adminRequired: false, sha512Ok: false } }))).toMatchObject({ ok: false, step: 'sha512' });
    expect(plan(state({ pending: { installer: 'x.exe', version: '4.3.209', adminRequired: true, sha512Ok: true } }))).toMatchObject({ ok: false, step: 'admin-rights' });
    expect(plan(state({ pending: null }))).toMatchObject({ ok: false, step: 'pending' });
    expect(plan(state({ system: true }))).toMatchObject({ ok: false, step: 'identity' });
  });

  it('-RelaunchApp: the app eGPT closed first comes back though it is not running now; -NoRelaunchGui still wins', { timeout: 30_000 }, () => {
    expect(plan(state({ appRunning: false }), ['-RelaunchApp'])).toMatchObject({ ok: true, closeApp: false, relaunchApp: true });
    expect(plan(state({ appRunning: false }))).toMatchObject({ ok: true, closeApp: false, relaunchApp: false });
    expect(plan(state({ appRunning: false }), ['-RelaunchApp', '-NoRelaunchGui'])).toMatchObject({ relaunchApp: false });
  });

  it('-RestartOnly needs no download', { timeout: 30_000 }, () => {
    expect(plan(state({ installed: '4.3.209', pending: null }), ['-RestartOnly'])).toMatchObject({ ok: true, install: false, from: '4.3.209', to: '4.3.209' });
  });

  it('-Installer/-Sha512: that file is the download in place of the pending one; every refusal still applies', { timeout: 60_000 }, () => {
    const dir = tmp();
    const exe = join(dir, FILE);
    writeFileSync(exe, BYTES);
    const own = (sha, f = exe) => ['-Installer', f, '-Sha512', sha];
    // the recorded pending (needs admin) is replaced: version from the file name, adminRequired false
    const blocked = { installer: 'x.exe', version: '4.3.209', adminRequired: true, sha512Ok: true };
    expect(plan(state({ installed: '4.3.229', pending: blocked }), own(b64(BYTES)))).toEqual({ ok: true, dryRun: true, flow: 'services', from: '4.3.229', to: '4.3.264', install: true, stop: ['egpt-beeper-primary', 'egpt-beeper-secondary'], closeApp: true, start: ['egpt-beeper-primary', 'egpt-beeper-secondary'], relaunchApp: true });
    expect(plan(state({ installed: '4.3.229', pending: null }), own(b64(Buffer.from('other'))))).toMatchObject({ ok: false, step: 'sha512' });
    expect(plan(state({ installed: '4.3.229', pending: null }), own(b64(BYTES), join(dir, 'Beeper x64 4.3.265.exe')))).toMatchObject({ ok: false, step: 'sha512' });
    expect(plan(state({ installed: '4.3.264', pending: null }), own(b64(BYTES)))).toMatchObject({ ok: false, step: 'nothing-to-install' });
    expect(plan(state({ installed: '4.3.229', pending: null, system: true }), own(b64(BYTES)))).toMatchObject({ ok: false, step: 'identity' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(process.platform !== 'win32')('the service permission — one ACE, as SDDL text', () => {
  const NSSM_DEFAULT = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)';
  const SID = 'S-1-5-21-1111-2222-3333-1001';
  const fn = (expr) => ps(['-Command', `. '${LIB}'; ${expr}`]).stdout.trim();

  it('grants query + start + stop to the user, inside the DACL, idempotently; revoke restores it', { timeout: 30_000 }, () => {
    const granted = fn(`Add-BeeperServiceAce '${NSSM_DEFAULT}' '${SID}'`);
    expect(granted).toBe(NSSM_DEFAULT.replace('S:(AU', `(A;;CCLCSWRPWPLORC;;;${SID})S:(AU`));
    expect(fn(`Add-BeeperServiceAce '${granted}' '${SID}'`)).toBe(granted);
    expect(fn(`Test-BeeperServiceAce '${granted}' '${SID}'`)).toBe('True');
    expect(fn(`Test-BeeperServiceAce '${NSSM_DEFAULT}' '${SID}'`)).toBe('False');
    expect(fn(`Remove-BeeperServiceAce '${granted}' '${SID}'`)).toBe(NSSM_DEFAULT);
  });
});

// 2026-10-21 17:02: CloseMainWindow cannot reach a window hidden in the tray, so the tool killed
// the operator's Beeper ("6 Beeper processes still up - terminating").
describe('beeper-update.ps1 never kills Beeper', () => {
  const src = readFileSync(TOOL, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  it('no Stop-Process, no CloseMainWindow; the app is closed (WM_CLOSE, hidden window included) BEFORE any service stops', () => {
    expect(code).not.toMatch(/Stop-Process|\.Kill\(|CloseMainWindow/);
    expect(code.indexOf('Close-BeeperApp ')).toBeGreaterThan(0);
    expect(code.indexOf('Close-BeeperApp ')).toBeLessThan(code.indexOf('Stop-Service $svc'));
    const lib = readFileSync(LIB, 'utf8');
    const fn = lib.slice(lib.indexOf('function Close-BeeperApp('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('Close-BeeperAppWindows');
    expect(body).not.toMatch(/Stop-Process|\.Kill\(|CloseMainWindow/);
  });
  it('-CloseAppOnly answers before any plan, refusal or service is touched', () => {
    const at = code.indexOf('if ($CloseAppOnly)');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(code.indexOf('Read-MachineState }'));
    expect(at).toBeLessThan(code.indexOf('Stop-Service'));
  });
  it('an app that hides instead of quitting: refused at close-app, nothing stopped, and the line says what to do', () => {
    expect(code).toMatch(/step = 'close-app'; error = 'the Beeper app hid instead of quitting'/);
    expect(resultLine('kg', { from: '4.3.209', to: '4.3.229', result: { ok: false, step: 'close-app', error: 'the Beeper app hid instead of quitting', remedy: 'quit Beeper from its tray icon (Quit), then update again', connections: [] } }))
      .toBe('🔄 kg · Beeper 4.3.209 → 4.3.229 · FAILED at close-app: the Beeper app hid instead of quitting — quit Beeper from its tray icon (Quit), then update again');
  });
});

describe('the service installer grants the same ACE on the service it creates', () => {
  const src = readFileSync(join(ROOT, 'setup', 'install-beeper-s0-service.ps1'), 'utf8');
  it('dot-sources the one library and grants after `nssm install`, to the user who ran it (carried through UAC)', () => {
    expect(src).toContain(". (Join-Path $PSScriptRoot 'beeper-desktop.ps1')");
    const install = src.indexOf('& $nssm install $ServiceName');
    const grant = src.indexOf('Set-BeeperServiceAccess -Name $ServiceName -Sid $GrantSid');
    expect(install).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(install);
    expect(src).toMatch(/\$GrantSid = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
    expect(src).toContain("$a += @('-GrantSid', $GrantSid)");
  });

  it('the standalone script is one file with -Revoke, behind one self-elevating launcher', () => {
    const grant = readFileSync(join(ROOT, 'setup', 'grant-beeper-service-control.ps1'), 'utf8');
    expect(grant).toContain('Set-BeeperServiceAccess -Name $s.Name -Sid $Sid -Revoke:$Revoke -DryRun:$DryRun');
    expect(grant).toContain("-Verb RunAs");
    expect(readFileSync(join(ROOT, 'setup', 'grant-beeper-service-control.cmd'), 'utf8')).toContain('grant-beeper-service-control.ps1');
  });
});
