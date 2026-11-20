// egpt-update.test.mjs — keeping eGPT itself current (src/tools/egpt-update.mjs): the 6-hourly look at
// the checkout's upstream, the log_to_group notice, auto → `/upgrade full`, and the ask_on_boot line.
// Driven through a fake git runner, clock and fs home: no network, no write to a real repo (one test
// runs the real runner against throwaway repos under tmp).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEgptUpdate, egptMethod, noticeLine, askLine } from '../src/tools/egpt-update.mjs';
import { CHECK_EVERY_MS } from '../src/tools/beeper-update.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { resolveConfigKey, CONFIG_SCHEMA } from '../config/config-schema.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'egpt-egpt-update-'));
const FROM = `b14257d3${'a'.repeat(32)}`;
const TO = `1a2b3c4d${'e'.repeat(32)}`;
const TO2 = `9f8e7d6c${'b'.repeat(32)}`;
const BEEPER = { from: '4.3.229', to: '4.3.334', hint: '/n update beeper' };
const NOTICE = '⬆ nu · eGPT 3 new commits on main (b14257d3 → 1a2b3c4d): feat: one; fix: two; docs: three';

// The facts git would answer, by command. `unknown` / `fetchFails` make that step fail with git's words.
function fakeGit(over = {}) {
  const s = { branch: 'main', upstream: 'origin/main', from: FROM, to: TO, behind: 3, ahead: 0, subjects: ['feat: one', 'fix: two', 'docs: three', 'chore: four'], unknown: null, fetchFails: null, boom: null, calls: [], ...over };
  const git = async (args) => {
    const cmd = args.join(' ');
    s.calls.push(cmd);
    if (cmd === 'rev-parse --abbrev-ref HEAD @{u}') { if (s.unknown) throw new Error(s.unknown); return `${s.branch}\n${s.upstream}`; }
    if (cmd === 'fetch --quiet') { if (s.fetchFails) throw new Error(s.fetchFails); return ''; }
    if (s.boom && cmd.startsWith('rev-parse HEAD')) throw new Error(s.boom);   // a step after the two it names
    if (cmd === 'rev-parse HEAD @{u}') return `${s.from}\n${s.to}`;
    if (cmd === 'rev-list --count HEAD..@{u}') return String(s.behind);
    if (cmd === 'rev-list --count @{u}..HEAD') return String(s.ahead);
    if (args[0] === 'log') return s.subjects.slice(0, Math.min(s.behind, Number(args[args.indexOf('-n') + 1]))).join('\n');
    throw new Error(`unexpected git ${cmd}`);
  };
  return { s, git };
}

// One node: a fake git, a real throwaway home, a clock. `again()` is the same node after a restart.
function node({ cfg = {}, git = {}, beeper = null, restartPending = false, supervised = true, platform = 'linux', home = tmp() } = {}) {
  const g = fakeGit(git);
  const t = { cfg, clock: 0, pending: restartPending, beeper, said: [], log: [], exits: [], g, home };
  const make = () => createEgptUpdate({
    getConfig: () => ({ node_name: 'nu', ...t.cfg }),
    home,
    platform,
    git: g.git,
    // the state file as it is AT the moment of the exit: autoTried must already be on disk
    upgradeFull: async () => { t.exits.push(JSON.parse(readFileSync(join(home, 'state', 'egpt-update.json'), 'utf8'))); },
    restartPending: () => t.pending,
    supervised: () => supervised,
    logToGroup: async (text) => { t.said.push(text); return true; },
    hint: () => '/n upgrade full',
    beeperPending: async () => (typeof t.beeper === 'function' ? t.beeper() : t.beeper),
    now: () => t.clock,
    onLog: (m) => t.log.push(m),
  });
  t.u = make();
  t.again = () => { t.u = make(); return t.u; };
  return t;
}
const auto = { auto_update: { egpt: 'auto' } };
const manual = { auto_update: { egpt: 'manual' } };
const none = { auto_update: { egpt: 'none' } };

describe('auto_update.egpt — the method', () => {
  it('defaults to auto; reads auto | manual | none case-blind; anything else is none, said once', () => {
    expect(egptMethod({})).toEqual({ method: 'auto', note: null });
    expect(egptMethod({ auto_update: {} })).toEqual({ method: 'auto', note: null });
    for (const m of ['auto', 'manual', 'none']) expect(egptMethod({ auto_update: { egpt: m } }).method).toBe(m);
    expect(egptMethod({ auto_update: { egpt: ' Manual ' } }).method).toBe('manual');
    const bad = egptMethod({ auto_update: { egpt: 'sometimes' } });
    expect(bad.method).toBe('none');
    expect(bad.note).toMatch(/auto_update\.egpt "sometimes" is not auto \| manual \| none/);
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
    expect(noticeLine('nu', { ...r, how: 'auto' }, '/n upgrade full')).toBe('⬆ nu · eGPT 1 new commit on main (b14257d3 → 1a2b3c4d): a — upgrading (/upgrade full) at the next quiet moment');
    expect(noticeLine('nu', { ...r, how: 'manual' }, '/n upgrade full')).toBe('⬆ nu · eGPT 1 new commit on main (b14257d3 → 1a2b3c4d): a — send /n upgrade full');
  });
});

describe('auto — /upgrade full once per upstream sha, through the existing exit', () => {
  it('says so in the notice, and exits once, the state already on disk', async () => {
    const n = node({ cfg: auto });
    await n.u.check();
    expect(n.said).toEqual([`${NOTICE} — upgrading (/upgrade full) at the next quiet moment`]);
    expect(n.exits).toEqual([{ noticed: TO, autoTried: TO }]);
  });

  it('never loops: the pull left it behind, so the next look and the next boot do not exit again', async () => {
    const n = node({ cfg: auto });
    await n.u.check();
    n.clock += CHECK_EVERY_MS;
    await n.u.check();
    await n.again().check();   // the respawned node, still behind
    await n.again().check();
    expect(n.exits).toHaveLength(1);
    expect(n.said).toHaveLength(1);
  });

  it('a newer upstream sha is tried once more', async () => {
    const n = node({ cfg: auto });
    await n.u.check();
    n.g.s.to = TO2;
    await n.u.check();
    await n.u.check();
    expect(n.exits.map((e) => e.autoTried)).toEqual([TO, TO2]);
  });

  it('a restart already pending: no exit, and the sha is not spent', async () => {
    const n = node({ cfg: auto, restartPending: true });
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
    n.cfg = auto;
    await n.u.check();
    expect(n.said).toHaveLength(1);
    expect(n.exits).toHaveLength(1);
  });

  it('auto with no daemon to respawn the spine: noticed as manual, never exits', async () => {
    const n = node({ cfg: auto, supervised: false });
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
    const n = node({ cfg: auto, git: { ahead: 2 } });
    await n.u.check();
    expect(n.said).toEqual([`${NOTICE} — not upgrading: this checkout has 2 commits origin/main lacks, so /upgrade (git pull --ff-only) would fail`]);
    expect(n.exits).toEqual([]);
  });
});

describe('when the state is unknown, it is a log line and nothing else', () => {
  it('no upstream / detached HEAD: git\'s words in the log, nothing posted, nothing fetched', async () => {
    const n = node({ cfg: auto, git: { unknown: 'fatal: no upstream configured for branch \'main\'' } });
    expect(await n.u.check()).toBeNull();
    expect(n.log).toEqual(['state unknown — fatal: no upstream configured for branch \'main\'']);
    expect(n.said).toEqual([]);
    expect(n.exits).toEqual([]);
    expect(n.g.s.calls).not.toContain('fetch --quiet');
  });

  it('a failed fetch: the log only, and the stale remote refs are not trusted', async () => {
    const n = node({ cfg: auto, git: { fetchFails: 'fatal: unable to access the remote' } });
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
    expect(n.log.filter((l) => /not auto \| manual \| none/.test(l))).toHaveLength(1);
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
    const n = node({ cfg: manual, beeper: BEEPER });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — /n upgrade full · Beeper 4.3.229 → 4.3.334 — /n update beeper. Apply now?');
  });

  it('Beeper alone', async () => {
    const n = node({ cfg: manual, git: { behind: 0 }, beeper: BEEPER });
    expect(await ask(n)).toBe('⬆ pending: Beeper 4.3.229 → 4.3.334 — /n update beeper. Apply now?');
  });

  it('under auto, eGPT says the next quiet moment instead of asking', async () => {
    const n = node({ cfg: auto });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — at the next quiet moment');
    expect(n.exits).toHaveLength(1);   // and it was the same look that started it
  });

  it('under auto with a Beeper update still to ask for: only that is asked', async () => {
    const n = node({ cfg: auto, beeper: BEEPER });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — at the next quiet moment · Beeper 4.3.229 → 4.3.334 — /n update beeper. Apply now?');
  });

  it('a Beeper under its own auto method applies by itself too', async () => {
    const n = node({ cfg: { ...auto, limbs: { beeper: { auto_update: { windows: { method: 'auto' } } } } }, beeper: BEEPER, platform: 'win32' });
    expect(await ask(n)).toBe('⬆ pending: eGPT 3 commits (b14257d3 → 1a2b3c4d) — at the next quiet moment · Beeper 4.3.229 → 4.3.334 — at the next quiet moment');
  });

  it('auto already tried this sha and the pull left it behind: it is asked for again, by hand', async () => {
    const n = node({ cfg: auto });
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
    const n = node({ cfg: none, beeper: BEEPER });
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

  it('ask_on_boot false does not wait for anything', async () => {
    const n = node({ cfg: { auto_update: { ask_on_boot: false } }, beeper: BEEPER });
    expect(await n.u.askOnBoot()).toBeNull();
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
