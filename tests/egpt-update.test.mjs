// egpt-update.test.mjs — keeping eGPT itself current (src/tools/egpt-update.mjs): the 6-hourly look at
// the checkout's upstream, the log_to_group notice, auto → `/upgrade full`, and the ask_on_boot line.
// Driven through a fake git runner, clock and fs home: no network, no write to a real repo (one test
// runs the real runner against throwaway repos under tmp).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemonGraph, daemonChanges } from '../src/tools/daemon-graph.mjs';
import { createEgptUpdate, egptMethod, noticeLine, askLine } from '../src/tools/egpt-update.mjs';
import { CHECK_EVERY_MS } from '../src/tools/beeper-update.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { resolveConfigKey, CONFIG_SCHEMA } from '../config/config-schema.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'egpt-egpt-update-'));
const FROM = `b14257d3${'a'.repeat(32)}`;
const TO = `1a2b3c4d${'e'.repeat(32)}`;
const TO2 = `9f8e7d6c${'b'.repeat(32)}`;
const OS_OF = { win32: 'windows', linux: 'linux', darwin: 'mac' };
const BEEPER = { from: '4.3.229', to: '4.3.334', hint: '/n update beeper' };
const NOTICE = '⬆ nu · eGPT 3 new commits on main (b14257d3 → 1a2b3c4d): feat: one; fix: two; docs: three';

// The facts git would answer, by command. `unknown` / `fetchFails` make that step fail with git's words.
function fakeGit(over = {}) {
  const s = { branch: 'main', upstream: 'origin/main', from: FROM, to: TO, behind: 3, ahead: 0, changed: ['src/daemon-runtime.mjs', 'src/spine/boot.mjs'], subjects: ['feat: one', 'fix: two', 'docs: three', 'chore: four'], unknown: null, fetchFails: null, boom: null, calls: [], ...over };
  const git = async (args) => {
    const cmd = args.join(' ');
    s.calls.push(cmd);
    if (cmd === 'rev-parse --abbrev-ref HEAD @{u}') { if (s.unknown) throw new Error(s.unknown); return `${s.branch}\n${s.upstream}`; }
    if (cmd === 'fetch --quiet') { if (s.fetchFails) throw new Error(s.fetchFails); return ''; }
    if (s.boom && cmd.startsWith('rev-parse HEAD')) throw new Error(s.boom);   // a step after the two it names
    if (cmd === 'rev-parse HEAD @{u}') return `${s.from}\n${s.to}`;
    if (cmd === 'rev-list --count HEAD..@{u}') return String(s.behind);
    if (cmd === 'rev-list --count @{u}..HEAD') return String(s.ahead);
    if (cmd === 'diff --name-only HEAD..@{u}') return s.changed.join('\n');
    if (args[0] === 'log') return s.subjects.slice(0, Math.min(s.behind, Number(args[args.indexOf('-n') + 1]))).join('\n');
    throw new Error(`unexpected git ${cmd}`);
  };
  return { s, git };
}

// One node: a fake git, a real throwaway home, a clock. `again()` is the same node after a restart.
// beeperMethod: Beeper's own auto_update method on this node's OS (its default is auto where installs are implemented), so a test says which it means.
function node({ cfg = {}, git = {}, beeper = null, beeperMethod = 'manual', restartPending = false, supervised = true, respawns = true, graph = { files: new Set(['egpt-daemon.mjs', 'src/daemon-runtime.mjs']), packages: true }, platform = 'linux', home = tmp() } = {}) {
  const g = fakeGit(git);
  const t = { cfg, clock: 0, pending: restartPending, beeper, said: [], log: [], exits: [], g, home };
  const make = () => createEgptUpdate({
    getConfig: () => ({ node_name: 'nu', limbs: { beeper: { auto_update: { [OS_OF[platform]]: { method: beeperMethod } } } }, ...t.cfg }),
    home,
    platform,
    git: g.git,
    // the state file as it is AT the moment of the exit: autoTried must already be on disk
    upgrade: async (full) => { t.exits.push({ ...JSON.parse(readFileSync(join(home, 'state', 'egpt-update.json'), 'utf8')), full }); },
    daemonRespawns: () => respawns,
    daemonFiles: async () => graph,
    restartPending: () => t.pending,
    supervised: () => supervised,
    logToGroup: async (text) => { t.said.push(text); return true; },
    hint: (cmd) => `/n ${cmd}`,
    beeperPending: async () => (typeof t.beeper === 'function' ? t.beeper() : t.beeper),
    now: () => t.clock,
    onLog: (m) => t.log.push(m),
  });
  t.u = make();
  t.again = () => { t.u = make(); return t.u; };
  return t;
}
const full = { auto_update: { egpt: 'auto-full' } };
const auto = { auto_update: { egpt: 'auto' } };
const manual = { auto_update: { egpt: 'manual' } };
const none = { auto_update: { egpt: 'none' } };

describe('auto_update.egpt — the method', () => {
  it('defaults to auto-full; reads auto-full | auto | manual | none case-blind; anything else is none, said once', () => {
    expect(egptMethod({})).toEqual({ method: 'auto-full', note: null });
    expect(egptMethod({ auto_update: {} })).toEqual({ method: 'auto-full', note: null });
    for (const m of ['auto-full', 'auto', 'manual', 'none']) expect(egptMethod({ auto_update: { egpt: m } }).method).toBe(m);
    expect(egptMethod({ auto_update: { egpt: ' Manual ' } }).method).toBe('manual');
    const bad = egptMethod({ auto_update: { egpt: 'sometimes' } });
    expect(bad.method).toBe('none');
    expect(bad.note).toMatch(/auto_update\.egpt "sometimes" is not auto-full \| auto \| manual \| none/);
  });

  it('is a registered, documented top-level key, its leaves resolvable', () => {
    expect(CONFIG_SCHEMA).toHaveProperty('auto_update');
    expect(CONFIG_SCHEMA.auto_update).toMatch(/beeper\.auto_update/);   // says where Beeper's own method stays
    expect(resolveConfigKey('auto_update.egpt')).toEqual({ path: 'auto_update.egpt' });
    expect(resolveConfigKey('ask_on_boot')).toEqual({ path: 'auto_update.ask_on_boot' });
  });
});

describe('the notice — ONE line per upstream sha', () => {
  it('manual: names the commits, the shas and the command; a second look at the same sha says nothing', async () => {
    const n = node({ cfg: manual });
    await n.u.check();
    expect(n.said).toEqual([`${NOTICE} — send /n upgrade full`]);
    await n.u.check();
    await n.again().check();   // a restart does not repeat it either
    expect(n.said).toHaveLength(1);
    expect(n.exits).toEqual([]);
  });

  it('a newer upstream sha is a new notice; the commits beyond the cap are counted, long subjects cut', async () => {
    const n = node({ cfg: manual, git: { behind: 7, subjects: ['x'.repeat(80), 'b', 'c'] } });
    await n.u.check();
    expect(n.said[0]).toBe(`⬆ nu · eGPT 7 new commits on main (b14257d3 → 1a2b3c4d): ${'x'.repeat(59)}…; b; c (+4 more) — send /n upgrade full`);
    n.g.s.to = TO2; n.g.s.behind = 1; n.g.s.subjects = ['fix: late'];
    await n.u.check();
    expect(n.said[1]).toBe('⬆ nu · eGPT 1 new commit on main (b14257d3 → 9f8e7d6c): fix: late — send /n upgrade full');
  });

  it('nothing behind: nothing said, no state written', async () => {
    const n = node({ cfg: manual, git: { behind: 0 } });
    expect(await n.u.check()).toMatchObject({ behind: 0 });
    expect(n.said).toEqual([]);
    expect(n.log).toEqual([]);
  });

  it('the notice line itself', () => {
    const r = { branch: 'main', upstream: 'origin/main', from: FROM, to: TO, behind: 1, ahead: 0, subjects: ['a'] };
    expect(noticeLine('nu', { ...r, how: 'auto-full' }, '/n upgrade full')).toBe('⬆ nu · eGPT 1 new commit on main (b14257d3 → 1a2b3c4d): a — upgrading (/upgrade full) at the next quiet moment');
    expect(noticeLine('nu', { ...r, how: 'auto' }, '/n upgrade')).toBe('⬆ nu · eGPT 1 new commit on main (b14257d3 → 1a2b3c4d): a — upgrading (/upgrade) at the next quiet moment');
    expect(noticeLine('nu', { ...r, how: 'manual' }, '/n upgrade full')).toBe('⬆ nu · eGPT 1 new commit on main (b14257d3 → 1a2b3c4d): a — send /n upgrade full');
  });
});

describe('auto — /upgrade full once per upstream sha, through the existing exit', () => {
  it('says so in the notice, and exits once, the state already on disk', async () => {
    const n = node({ cfg: full });
    await n.u.check();
    expect(n.said).toEqual([`${NOTICE} — upgrading (/upgrade full) at the next quiet moment`]);
    expect(n.exits).toEqual([{ noticed: TO, autoTried: TO, full: true }]);
  });

  it('never loops: the pull left it behind, so the next look and the next boot do not exit again', async () => {
    const n = node({ cfg: full });
    await n.u.check();
    n.clock += CHECK_EVERY_MS;
    await n.u.check();
    await n.again().check();   // the respawned node, still behind
    await n.again().check();
    expect(n.exits).toHaveLength(1);
    expect(n.said).toHaveLength(1);
  });

  it('a newer upstream sha is tried once more', async () => {
    const n = node({ cfg: full });
    await n.u.check();
    n.g.s.to = TO2;
    await n.u.check();
    await n.u.check();
    expect(n.exits.map((e) => e.autoTried)).toEqual([TO, TO2]);
  });

  it('a restart already pending: no exit, and the sha is not spent', async () => {
    const n = node({ cfg: full, restartPending: true });
    await n.u.check();
    expect(n.exits).toEqual([]);
    expect(n.said).toHaveLength(1);   // still noticed
    n.pending = false;
    await n.again().check();
    expect(n.exits).toHaveLength(1);
  });

  it('turned on after the sha was noticed under manual: it applies then', async () => {
    const n = node({ cfg: manual });
    await n.u.check();
    n.cfg = full;
    await n.u.check();
    expect(n.said).toHaveLength(1);
    expect(n.exits).toHaveLength(1);
  });

  it('auto with no daemon to respawn the spine: noticed as manual, never exits', async () => {
    const n = node({ cfg: full, supervised: false });
    await n.u.check();
    expect(n.exits).toEqual([]);
    expect(n.said).toHaveLength(1);
    expect(n.said[0]).not.toContain('upgrading');
  });

  it('manual never exits, and none looks at nothing', async () => {
    const m = node({ cfg: manual });
    await m.u.check(); m.clock += CHECK_EVERY_MS; await m.u.check();
    expect(m.exits).toEqual([]);
    const o = node({ cfg: none });
    expect(await o.u.check()).toBeNull();
    expect(o.g.s.calls).toEqual([]);
    expect(o.said).toEqual([]);
    expect(o.exits).toEqual([]);
  });

  it('a diverged checkout (ahead of its upstream): the notice says so, auto does not fire', async () => {
    const n = node({ cfg: full, git: { ahead: 2 } });
    await n.u.check();
    expect(n.said).toEqual([`${NOTICE} — not upgrading: this checkout has 2 commits origin/main lacks, so /upgrade (git pull --ff-only) would fail`]);
    expect(n.exits).toEqual([]);
  });
});

describe('the modes — what each applies', () => {
  it('auto-full is the default (no auto_update at all)', async () => {
    const n = node({});
    await n.u.check();
    expect(n.exits.map((e) => e.full)).toEqual([true]);
  });

  it('auto: plain /upgrade, whatever changed; the notice says so', async () => {
    const n = node({ cfg: auto });   // changed includes a daemon file
    await n.u.check();
    expect(n.said).toEqual([`${NOTICE} — upgrading (/upgrade) at the next quiet moment`]);
    expect(n.exits).toEqual([{ noticed: TO, autoTried: TO, full: false }]);
    expect(n.log).toEqual([n.said[0]]);   // the notice only: auto does not look at the daemon's files
  });

  it('auto without a daemon (unsupervised): manual, hinting plain /upgrade', async () => {
    const n = node({ cfg: auto, supervised: false });
    await n.u.check();
    expect(n.exits).toEqual([]);
    expect(n.said[0]).toMatch(/ — send \/n upgrade$/);
  });

  it('manual still hints /upgrade full, and never reads the graph', async () => {
    const n = node({ cfg: manual, graph: null });
    await n.u.check();
    expect(n.said[0]).toMatch(/ — send \/n upgrade full$/);
  });
});

describe('auto-full = auto, unless the daemon itself changed', () => {
  it('a changed file in the daemon graph: /upgrade full, one log line naming it', async () => {
    const n = node({ cfg: full, git: { changed: ['README.md', 'src/daemon-runtime.mjs'] } });
    await n.u.check();
    expect(n.exits).toEqual([{ noticed: TO, autoTried: TO, full: true }]);
    expect(n.said).toEqual([`${NOTICE} — upgrading (/upgrade full) at the next quiet moment`]);
    expect(n.log).toEqual([n.said[0], 'daemon files changed: src/daemon-runtime.mjs → full']);
  });

  it('only files outside the graph: plain /upgrade, spine only', async () => {
    const n = node({ cfg: full, git: { changed: ['src/spine/boot.mjs', 'tests/x.test.mjs'] } });
    await n.u.check();
    expect(n.exits).toEqual([{ noticed: TO, autoTried: TO, full: false }]);
    expect(n.said).toEqual([`${NOTICE} — upgrading (/upgrade) at the next quiet moment`]);
    expect(n.log).toEqual([n.said[0], 'daemon unchanged → spine-only upgrade']);
  });

  it('package.json counts when the daemon imports a package, and not when it imports none', async () => {
    const yes = node({ cfg: full, git: { changed: ['package-lock.json'] } });
    await yes.u.check();
    expect(yes.exits.map((e) => e.full)).toEqual([true]);
    const no = node({ cfg: full, git: { changed: ['package.json'] }, graph: { files: new Set(['egpt-daemon.mjs']), packages: false } });
    await no.u.check();
    expect(no.exits.map((e) => e.full)).toEqual([false]);
  });

  it('full needed but nothing respawns the daemon: spine-only, and ONE line says /upgrade full is still needed by hand', async () => {
    const n = node({ cfg: full, respawns: false });
    await n.u.check();
    expect(n.exits).toEqual([{ noticed: TO, autoTried: TO, full: false }]);
    expect(n.said).toHaveLength(2);
    expect(n.said[0]).toMatch(/ — upgrading \(\/upgrade\) at the next quiet moment$/);
    expect(n.said[1]).toBe('⬆ nu · daemon files changed: src/daemon-runtime.mjs → /upgrade full needed, but nothing respawns the daemon here (EGPT_DAEMON_RESPAWNS unset): spine-only upgrade now, send /n upgrade full by hand to renew the daemon');
    await n.again().check();   // the same sha: nothing more is said
    expect(n.said).toHaveLength(2);
  });

  it('no respawn but the daemon is unchanged: plain, and no "still needed" line', async () => {
    const n = node({ cfg: full, respawns: false, git: { changed: ['src/spine/boot.mjs'] } });
    await n.u.check();
    expect(n.exits.map((e) => e.full)).toEqual([false]);
    expect(n.said).toHaveLength(1);
  });

  it('the safeguards hold in auto-full: once per sha, a pending restart, diverged, unsupervised', async () => {
    const a = node({ cfg: full, git: { changed: ['src/spine/boot.mjs'] } });
    await a.u.check(); a.clock += CHECK_EVERY_MS; await a.u.check(); await a.again().check();
    expect(a.exits).toHaveLength(1);
    const b = node({ cfg: full, restartPending: true });
    await b.u.check();
    expect(b.exits).toEqual([]);
    const c = node({ cfg: full, git: { ahead: 1 } });
    await c.u.check();
    expect(c.exits).toEqual([]);
    const d = node({ cfg: full, supervised: false });
    await d.u.check();
    expect(d.exits).toEqual([]);
    expect(d.said[0]).toMatch(/ — send \/n upgrade full$/);
  });
});

describe('daemonGraph — the daemon\'s files from its imports, not a list', () => {
  const tree = {
    'egpt-daemon.mjs': "import { run } from './src/rt.mjs';",
    'src/rt.mjs': "import { a } from './lib/a.mjs';\nconst m = await import('./dyn.mjs');\nconst args = ['tool.ps1'];\nimport 'node:fs';",
    'src/lib/a.mjs': "export * from '../shared.mjs';",
    'src/dyn.mjs': 'export const x = 1;',
    'src/shared.mjs': "import YAML from 'yaml';",
    'src/unrelated.mjs': 'export const y = 1;',
    'setup/tool.ps1': '# script',
  };
  const read = async (p) => { if (!(p in tree)) throw new Error('ENOENT'); return tree[p]; };

  it('follows static, re-export and dynamic imports, names the scripts, notes a package import', async () => {
    const g = await daemonGraph('/x', { read });
    expect([...g.files].sort()).toEqual(['egpt-daemon.mjs', 'setup/tool.ps1', 'src/dyn.mjs', 'src/lib/a.mjs', 'src/rt.mjs', 'src/shared.mjs']);
    expect(g.packages).toBe(true);
    expect(daemonChanges(['src/unrelated.mjs', 'src/dyn.mjs', 'setup/tool.ps1', 'package.json'], g)).toEqual(['src/dyn.mjs', 'setup/tool.ps1', 'package.json']);
  });

  it('the real checkout: the daemon entry, its runtime and the setup scripts it runs are in; the spine is not', async () => {
    const g = await daemonGraph(process.cwd());
    for (const f of ['egpt-daemon.mjs', 'src/daemon-runtime.mjs', 'src/cli-host.mjs', 'setup/beeper-window.ps1']) expect(g.files.has(f), f).toBe(true);
    expect(g.files.has('src/spine/boot.mjs')).toBe(false);
    expect(g.files.has('egpt-spine.mjs')).toBe(false);
  });
});


describe('when the state is unknown, it is a log line and nothing else', () => {
  it('no upstream / detached HEAD: git\'s words in the log, nothing posted, nothing fetched', async () => {
    const n = node({ cfg: full, git: { unknown: 'fatal: no upstream configured for branch \'main\'' } });
    expect(await n.u.check()).toBeNull();
    expect(n.log).toEqual(['state unknown — fatal: no upstream configured for branch \'main\'']);
    expect(n.said).toEqual([]);
    expect(n.exits).toEqual([]);
    expect(n.g.s.calls).not.toContain('fetch --quiet');
  });

  it('a failed fetch: the log only, and the stale remote refs are not trusted', async () => {
    const n = node({ cfg: full, git: { fetchFails: 'fatal: unable to access the remote' } });
    expect(await n.u.check()).toBeNull();
    expect(n.log).toEqual(['fetch failed — fatal: unable to access the remote']);
    expect(n.said).toEqual([]);
    expect(n.exits).toEqual([]);
    expect(n.g.s.calls).toEqual(['rev-parse --abbrev-ref HEAD @{u}', 'fetch --quiet']);
  });
});

describe('tick — at boot, then every 6 h, the method read fresh', () => {
  it('the first tick looks; ticks inside 6 h do not; one after it does', async () => {
    const n = node({ cfg: manual, git: { behind: 0 } });
    await n.u.tick(0);
    await n.u.tick(CHECK_EVERY_MS - 1);
    expect(n.g.s.calls.filter((c) => c === 'fetch --quiet')).toHaveLength(1);
    await n.u.tick(CHECK_EVERY_MS);
    expect(n.g.s.calls.filter((c) => c === 'fetch --quiet')).toHaveLength(2);
  });

  it('a config edit applies at the next look', async () => {
    const n = node({ cfg: none });
    await n.u.tick(0);
    expect(n.g.s.calls).toEqual([]);
    n.cfg = manual;
    await n.u.tick(CHECK_EVERY_MS);
    expect(n.said).toHaveLength(1);
  });

  it('a throwing look is a log line, and the tick promise still settles', async () => {
    const n = node({ cfg: manual, git: { boom: 'git went away' } });
    await n.u.tick(0);
    expect(n.log).toEqual(['check: git went away']);
    expect(n.said).toEqual([]);
  });

  it('an invalid method is said once, never acted on', async () => {
    const n = node({ cfg: { auto_update: { egpt: 'sometimes' } } });
    await n.u.tick(0); await n.u.tick(CHECK_EVERY_MS);
    expect(n.log.filter((l) => /not auto-full \| auto \| manual \| none/.test(l))).toHaveLength(1);
    expect(n.g.s.calls).toEqual([]);
  });
});

// The boot line, as boot gets it: the spine's first tick looks, the line after the back-up line waits for it.
const ask = (n, u = n.u) => { u.tick(0); return u.askOnBoot(); };

describe('ask_on_boot — one line of what is pending', () => {
  it('eGPT commits, manual: the command and the question', async () => {
    const n = node({ cfg: manual });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — /n upgrade full. Apply now?');
  });

  it('eGPT and Beeper both: each with its own command, ONE question', async () => {
    const n = node({ cfg: manual, beeper: BEEPER, beeperMethod: 'manual' });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — /n upgrade full · Beeper 4.3.229 → 4.3.334 — /n update beeper. Apply now?');
  });

  it('Beeper alone', async () => {
    const n = node({ cfg: manual, git: { behind: 0 }, beeper: BEEPER, beeperMethod: 'manual' });
    expect(await ask(n)).toBe('⬆ pending: Beeper 4.3.229 → 4.3.334 — /n update beeper. Apply now?');
  });

  it('under auto, eGPT says the next quiet moment instead of asking', async () => {
    const n = node({ cfg: full });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — at the next quiet moment');
    expect(n.exits).toHaveLength(1);   // and it was the same look that started it
  });

  it('under auto with a Beeper update still to ask for: only that is asked', async () => {
    const n = node({ cfg: full, beeper: BEEPER, beeperMethod: 'manual' });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — at the next quiet moment · Beeper 4.3.229 → 4.3.334 — /n update beeper. Apply now?');
  });

  it('a Beeper under its own auto method applies by itself too: nothing is asked', async () => {
    const n = node({ cfg: full, beeper: BEEPER, beeperMethod: 'auto' });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — at the next quiet moment · Beeper 4.3.229 → 4.3.334 — at the next quiet moment');
  });

  it('eGPT manual, Beeper auto: only eGPT is asked for', async () => {
    const n = node({ cfg: manual, beeper: BEEPER, beeperMethod: 'auto' });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — /n upgrade full · Beeper 4.3.229 → 4.3.334 — at the next quiet moment. Apply now?');
  });

  it('auto already tried this sha and the pull left it behind: it is asked for again, by hand', async () => {
    const n = node({ cfg: full });
    await n.u.check();
    expect(await ask(n, n.again())).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — /n upgrade full. Apply now?');
    expect(n.exits).toHaveLength(1);
  });

  it('a diverged checkout is said, not asked', async () => {
    const n = node({ cfg: manual, git: { ahead: 1 } });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — this checkout has 1 commit origin/main lacks: /upgrade would not fast-forward');
  });

  it('nothing pending: no line', async () => {
    const n = node({ cfg: manual, git: { behind: 0 }, beeper: null });
    expect(await ask(n)).toBeNull();
  });

  it('ask_on_boot false: no line, even with things pending', async () => {
    for (const off of [false, 'false']) {
      const n = node({ cfg: { auto_update: { egpt: 'manual', ask_on_boot: off } }, beeper: BEEPER });
      expect(await ask(n)).toBeNull();
    }
  });

  it('egpt none: no eGPT item, the Beeper one stays', async () => {
    const n = node({ cfg: none, beeper: BEEPER, beeperMethod: 'manual' });
    expect(await ask(n)).toBe('⬆ pending: Beeper 4.3.229 → 4.3.334 — /n update beeper. Apply now?');
    expect(n.g.s.calls).toEqual([]);
  });

  it('a Beeper that has no pending() yet, or fails to answer, costs the eGPT item nothing', async () => {
    const without = node({ cfg: manual });
    expect(await ask(without)).toMatch(/^⬆ pending: eGPT 3 commits/);
    const failing = node({ cfg: manual, beeper: () => { throw new Error('feed down'); } });
    expect(await ask(failing)).toMatch(/^⬆ pending: eGPT 3 commits/);
    expect(failing.log.join('\n')).toMatch(/feed down/);
  });

  it('waits for the spine\'s first tick and never looks by itself: one fetch for the tick and the boot line', async () => {
    const n = node({ cfg: manual });
    let line;
    const asked = n.u.askOnBoot().then((l) => { line = l; });
    await new Promise((r) => setTimeout(r, 20));
    expect(line).toBeUndefined();
    expect(n.g.s.calls).toEqual([]);
    await n.u.tick(0);
    await asked;
    await n.u.tick(1);
    expect(n.g.s.calls.filter((c) => c === 'fetch --quiet')).toHaveLength(1);
    expect(line).toMatch(/Apply now\?$/);
    expect(n.said).toHaveLength(1);
  });

  it('asks Beeper only after the boot look: a node whose spine never ticks reaches for nothing', async () => {
    let asked = 0;
    const n = node({ cfg: manual, beeper: () => { asked += 1; return BEEPER; }, beeperMethod: 'manual' });
    const line = n.u.askOnBoot();
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toBe(0);
    await n.u.tick(0);
    expect(await line).toMatch(/Beeper 4\.3\.229 → 4\.3\.334 — \/n update beeper\. Apply now\?$/);
    expect(asked).toBe(1);
  });

  it('ask_on_boot false does not wait for anything, nor ask Beeper', async () => {
    let asked = 0;
    const n = node({ cfg: { auto_update: { ask_on_boot: false } }, beeper: () => { asked += 1; return BEEPER; } });
    expect(await n.u.askOnBoot()).toBeNull();
    expect(asked).toBe(0);
  });

  it('the line itself', () => {
    expect(askLine([{ text: 'a — x', ask: true }, { text: 'b — y', ask: false }])).toBe('⬆ pending: a — x · b — y. Apply now?');
    expect(askLine([{ text: 'b — y', ask: false }])).toBe('⬆ pending: b — y');
    expect(askLine([])).toBeNull();
  });
});

describe('the real git runner, against throwaway repos', () => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, name) => { writeFileSync(join(cwd, name), name); git(cwd, 'add', name); git(cwd, 'commit', '-qm', `add ${name}`); };

  it('counts what an ff-only pull would take, names the diverged and the detached', async () => {
    const root = tmp(), remote = join(root, 'remote.git'), mine = join(root, 'mine'), other = join(root, 'other');
    mkdirSync(remote);
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(root, 'clone', '-q', remote, mine);
    git(mine, 'checkout', '-q', '-B', 'main');
    commit(mine, 'one');
    git(mine, 'push', '-q', '-u', 'origin', 'main');
    git(root, 'clone', '-q', remote, other);
    commit(other, 'two'); commit(other, 'three');
    git(other, 'push', '-q', 'origin', 'main');

    const make = (cfg) => { const t = { said: [], log: [] }; t.u = createEgptUpdate({ getConfig: () => ({ node_name: 'nu', ...cfg }), home: tmp(), repoRoot: mine, logToGroup: async (x) => { t.said.push(x); }, onLog: (m) => t.log.push(m) }); return t; };

    const behind = make(manual);
    const r = await behind.u.check();
    expect(r).toMatchObject({ branch: 'main', upstream: 'origin/main', behind: 2, ahead: 0, how: 'manual' });
    expect(r.from).toBe(git(mine, 'rev-parse', 'HEAD').trim());
    expect(r.to).toBe(git(other, 'rev-parse', 'HEAD').trim());
    expect(behind.said[0]).toMatch(/^⬆ nu · eGPT 2 new commits on main \([0-9a-f]{8} → [0-9a-f]{8}\): add three; add two — send /);

    commit(mine, 'mine');
    const diverged = make(manual);
    expect(await diverged.u.check()).toMatchObject({ behind: 2, ahead: 1, how: 'diverged' });

    git(mine, 'checkout', '-q', '--detach');
    const detached = make(manual);
    expect(await detached.u.check()).toBeNull();
    expect(detached.log[0]).toMatch(/^state unknown — fatal: /);
    expect(detached.said).toEqual([]);
  });
});

describe('the spine ticks it beside the Beeper check', () => {
  it('egptUpdate.tick(now) rides the spine tick, and is optional', () => {
    const base = {
      bridge: { onMessage() {}, send() {}, stop() {} },
      brain: { async turn() { return { text: '' }; } },
      identity: { build: (m) => m },
      router: { resolve: () => ({ being: 'e' }) },
      gating: { async decide() { return { mode: 'off', receives: false, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false },
      sender: { open: () => ({ update() {}, async finish() {}, async fail() {} }) },
      transcript: { async log() {} },
      heartbeats: { runDue() {} },
      clock: { now: () => 1234 },
    };
    const ticks = [];
    createSpine({ ...base, egptUpdate: { tick: (ms) => ticks.push(ms) } }).tick();
    expect(ticks).toEqual([1234]);
    expect(() => createSpine(base).tick()).not.toThrow();
  });
});
