import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  CLEAN_EXIT_CODE,
  LAST_GOOD_UPTIME_MS,
  NEVER_HEALTHY_RESCUE_AT,
  NEVER_HEALTHY_ROLLBACK_AT,
  RESTART_EXIT_CODE,
  RESTART_MIN_MS,
  RESTART_MAX_MS,
  UPGRADE_EXIT_CODE,
  createDaemonRuntime,
} from '../src/daemon-runtime.mjs';

let _nextFakePid = 1000;

class FakeChild {
  constructor() {
    this.handlers = {};
    this.killed = [];
    this.pid = _nextFakePid++;
  }
  on(event, fn) {
    this.handlers[event] = fn;
    return this;
  }
  kill(signal) {
    this.killed.push(signal);
  }
}

function makeProcess() {
  const signals = {};
  const exits = [];
  return {
    env: { PATH: 'x' },
    on: (name, fn) => { signals[name] = fn; },
    exit: (code) => exits.push(code),
    signals,
    exits,
  };
}

function makeSpawnSync({ shas = ['abc123'], status = 0 } = {}) {
  const calls = [];
  let shaIndex = 0;
  const fn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--short') {
      const sha = shas[Math.min(shaIndex, shas.length - 1)];
      shaIndex += 1;
      return { status: 0, stdout: Buffer.from(`${sha}\n`) };
    }
    if (cmd === 'git' && args[0] === 'describe') return { status: 0, stdout: Buffer.from('v-test\n') };
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { status: 0, stdout: Buffer.from('main\n') };
    return { status, stdout: Buffer.from('') };
  };
  fn.calls = calls;
  return fn;
}

function makeRuntime(extra = {}) {
  const children = [];
  const logs = [];
  const processObj = extra.processObj ?? makeProcess();
  const spawnSync = extra.spawnSync ?? makeSpawnSync();
  const runtime = createDaemonRuntime({
    root: 'C:/repo/egpt',
    egptHome: 'C:/home/.egpt',
    argv: extra.argv ?? [],
    platform: 'win32',
    stdout: { write: (m) => logs.push(m) },
    processObj,
    spawnSync,
    spawn: (cmd, args, opts) => {
      const child = new FakeChild();
      children.push({ child, cmd, args, opts });
      return child;
    },
    readFileSync: extra.readFileSync ?? (() => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }),
    statSync: extra.statSync ?? (() => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }),   // no alive.txt → beat absent (Infinity)
    unlinkSync: extra.unlinkSync ?? (() => {}),
    existsSync: extra.existsSync ?? (() => false),
    writeFileSync: extra.writeFileSync ?? (() => {}),
    liveDaemonPid: extra.liveDaemonPid ?? (() => null),
    setImmediate: extra.setImmediate ?? ((fn) => fn()),
    setTimeout: extra.setTimeout ?? (() => {}),
    setInterval: extra.setInterval ?? (() => 1),       // recording id; no real timer
    clearInterval: extra.clearInterval ?? (() => {}),
    livenessIntervalMs: extra.livenessIntervalMs,
    aliveStaleMs: extra.aliveStaleMs,
    aliveGraceMs: extra.aliveGraceMs,
    importModule: extra.importModule ?? (async () => ({})),
    now: extra.now ?? (() => Date.UTC(2026, 5, 18, 12, 0, 0)),
  });
  return { runtime, children, logs, processObj, spawnSync };
}

describe('daemon runtime fake-world harness', () => {
  it('refuses to start when the singleton guard sees another live daemon', () => {
    const { runtime, children, processObj } = makeRuntime({ liveDaemonPid: () => 777 });

    expect(runtime.start()).toBeNull();

    expect(processObj.exits).toEqual([0]);
    expect(children).toHaveLength(0);
  });

  it('checkSingleton feeds liveDaemonPid the spine.pid content + the alive.txt beat age', () => {
    let captured = null;
    const clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime } = makeRuntime({
      now: () => clock,
      // spine.pid → "4242"; anything else (alive.txt content) is absent
      readFileSync: (p) => { if (String(p).includes('spine.pid')) return '4242\n'; const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      statSync: () => ({ mtimeMs: clock - 10_000 }),   // a 10s-old beat
      liveDaemonPid: (facts) => { captured = facts; return null; },   // observe, then allow start
    });
    runtime.start();
    expect(captured).toEqual({ pidFileContent: '4242\n', beatAgeMs: 10_000 });
  });

  it('spawns the v2 entry (node egpt-spine.mjs) from the fixed root — no role flags, stdio inherit', () => {
    const root = 'C:/repo/egpt';
    const { runtime, children } = makeRuntime({ argv: [] });

    runtime.start();

    expect(children).toHaveLength(1);
    expect(children[0].cmd).toBe('node');
    expect(children[0].args).toEqual([join(root, 'egpt-spine.mjs')]);   // no --headless, no flags
    expect(children[0].opts).toMatchObject({
      cwd: root,
      stdio: 'inherit',   // NSSM captures stdout/stderr to the service logs
      env: expect.objectContaining({ EGPT_SUPERVISED: '1' }),
    });
  });

  it('wedge check: a stale alive beat (old mtime) past the grace window restarts the child', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children } = makeRuntime({
      now: () => clock,
      statSync: () => ({ mtimeMs: Date.UTC(2026, 5, 18, 11, 0, 0) }),  // ~1h-old beat file
      aliveGraceMs: 1_000, aliveStaleMs: 60_000,
    });
    runtime.spawnShell();
    clock += 5_000;                 // past the 1s grace; beat is ~1h stale
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual(['SIGTERM']);
  });

  it('wedge check: still inside the boot grace window → child is left alone (no beat yet)', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children } = makeRuntime({
      now: () => clock,
      statSync: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },  // no alive.txt yet
      aliveGraceMs: 90_000, aliveStaleMs: 60_000,
    });
    runtime.spawnShell();
    clock += 1_000;                 // well within grace
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual([]);
  });

  it('wedge check: a fresh mtime leaves a healthy child running (content irrelevant)', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children } = makeRuntime({
      now: () => clock,
      statSync: () => ({ mtimeMs: clock - 5_000 }),  // 5s old
      aliveGraceMs: 1_000, aliveStaleMs: 60_000,
    });
    runtime.spawnShell();
    clock += 5_000;
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual([]);
  });

  it('wedge kill → child exits 0 (POSIX SIGTERM trap) → daemon respawns, does not stop', async () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const timers = [];
    const { runtime, children, processObj } = makeRuntime({
      now: () => clock,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      statSync: () => ({ mtimeMs: Date.UTC(2026, 5, 18, 11, 0, 0) }),  // ~1h-old beat file
      aliveGraceMs: 1_000, aliveStaleMs: 60_000,
    });
    runtime.spawnShell();
    clock += 5_000;                 // past grace; beat is stale
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual(['SIGTERM']);

    // POSIX: the trapped SIGTERM makes the child exit 0 — same as a clean /exit.
    // The wedge flag must route this to a respawn (after the first-wedge delay),
    // NOT stop the daemon.
    await children[0].child.handlers.exit(CLEAN_EXIT_CODE, 'SIGTERM');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(RESTART_MIN_MS);   // first wedge = RESTART_MIN_MS
    timers[0].fn();
    expect(children).toHaveLength(2);            // respawned
    expect(processObj.exits).toEqual([]);        // daemon did NOT stop
  });

  it('wedge log carries the alive.txt raw last line (freeform content) when it kills', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, logs } = makeRuntime({
      now: () => clock,
      setTimeout: () => {},   // don't respawn — we only inspect the wedge log
      statSync: () => ({ mtimeMs: Date.UTC(2026, 5, 18, 11, 0, 0) }),  // stale mtime
      readFileSync: () => 'beat\nq=5 oldest=42s\n',   // freeform content; last non-empty line surfaces
      aliveGraceMs: 1_000, aliveStaleMs: 60_000,
    });
    runtime.spawnShell();
    clock += 5_000;
    runtime.checkLiveness();
    const wedgeLog = logs.find((l) => l.includes('spine wedged'));
    expect(wedgeLog).toContain('q=5 oldest=42s');   // last-known beat content in the daemon log
  });

  it('consecutive wedge kills escalate the respawn delay; a fresh mtime resets the streak', async () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    let mtimeMs = Date.UTC(2026, 5, 18, 11, 0, 0);   // ~1h old (stale)
    const timers = [];
    const { runtime, children } = makeRuntime({
      now: () => clock,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      statSync: () => ({ mtimeMs }),
      aliveGraceMs: 1_000, aliveStaleMs: 60_000,
    });
    runtime.spawnShell();

    // wedge #1 → first-wedge delay
    clock += 5_000;
    runtime.checkLiveness();
    await children[0].child.handlers.exit(CLEAN_EXIT_CODE, 'SIGTERM');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(RESTART_MIN_MS);
    timers[0].fn();                                   // respawn child #2
    expect(children).toHaveLength(2);

    // wedge #2, still no fresh beat → escalated delay
    clock += 5_000;
    runtime.checkLiveness();
    await children[1].child.handlers.exit(CLEAN_EXIT_CODE, 'SIGTERM');
    expect(timers).toHaveLength(2);
    expect(timers[1].ms).toBe(Math.min(RESTART_MIN_MS * 2, RESTART_MAX_MS));   // doubled
    timers[1].fn();                                   // respawn child #3
    expect(children).toHaveLength(3);
    expect(runtime.state.wedgeStreak).toBe(2);

    // heartbeat restored: checkLiveness sees a fresh mtime → no kill, streak reset
    clock += 5_000;
    mtimeMs = clock;   // age 0
    runtime.checkLiveness();
    expect(children[2].child.killed).toEqual([]);
    expect(runtime.state.wedgeStreak).toBe(0);
  });

  // THE KILL SWITCH'S OTHER HALF (operator 2026-07-25). A spine that finds EGPT_HOME/STOP —
  // at boot, or on a tick while running — leaves through boot's `exit` seam with
  // CLEAN_EXIT_CODE. THIS is why the daemon needs no STOP check of its own: a plain exit 0
  // (no wedge kill) stops the whole daemon and schedules NOTHING, so a STOP file can never
  // put the supervisor in a respawn loop against a spine that refuses to start.
  it('exit code 0 (the STOP-file path) stops the daemon — no respawn, no timer', async () => {
    const timers = [];
    const { runtime, children, processObj, logs } = makeRuntime({
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      setImmediate: (fn) => timers.push({ fn, ms: 0 }),
    });
    runtime.spawnShell();

    await children[0].child.handlers.exit(CLEAN_EXIT_CODE, null);

    expect(processObj.exits).toEqual([0]);       // the daemon itself left
    expect(children).toHaveLength(1);            // …never respawned the spine
    expect(timers).toEqual([]);                  // …and armed no retry
    expect(logs.join('')).toContain('user wanted out');
  });

  it('exit code 43 restarts immediately without upgrade work', async () => {
    const { runtime, children, spawnSync } = makeRuntime();
    runtime.spawnShell();

    await children[0].child.handlers.exit(RESTART_EXIT_CODE, null);

    expect(children).toHaveLength(2);
    expect(spawnSync.calls).toEqual([]);
  });

  it('crash restart uses backoff and doubles after scheduling', async () => {
    const timers = [];
    const { runtime, children } = makeRuntime({
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
    });
    runtime.spawnShell();

    await children[0].child.handlers.exit(1, null);

    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(2000);
    expect(children).toHaveLength(1);
    timers[0].fn();
    expect(children).toHaveLength(2);
    expect(runtime.state.backoff).toBe(4000);
  });

  it('exit code 42 pulls, installs on changed sha, builds, and restarts', async () => {
    const imported = [];
    const spawnSync = makeSpawnSync({ shas: ['oldsha', 'newsha'] });
    const { runtime, children } = makeRuntime({
      spawnSync,
      importModule: async (url) => { imported.push(url); return {}; },
    });
    runtime.spawnShell();

    await children[0].child.handlers.exit(UPGRADE_EXIT_CODE, null);

    expect(spawnSync.calls.map((c) => [c.cmd, c.args?.[0]])).toContainEqual(['git', 'pull']);
    expect(spawnSync.calls.some((c) => c.cmd === 'npm install')).toBe(true);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toContain('/extension/build.mjs');
    expect(children).toHaveLength(2);
  });

  // === restart-announce sidecar — the daemon writes a fallback marker for the two exit
  // paths where the dying spine never got a chance to write its own (announceAndExit's
  // graceful path is untouched/out of scope): a genuine crash, and a wedge-kill. Same
  // sidecar shape boot.mjs already reads back: {chatId, kind, preSha, pid}. ===================
  describe('restart-announce sidecar fallback (crash/wedge exits with no prior sidecar)', () => {
    const CONFIG_YAML = 'networks:\n  whatsapp:\n    chat_ids:\n      - "!self:beeper.com"\n';
    const configReadFileSync = (p) => {
      if (String(p).includes('config.yaml')) return CONFIG_YAML;
      const e = new Error('missing'); e.code = 'ENOENT'; throw e;
    };

    it('crash branch writes {chatId, kind: "crash", preSha, pid} when no sidecar exists', async () => {
      const writes = [];
      const { runtime, children } = makeRuntime({
        readFileSync: configReadFileSync,
        writeFileSync: (p, body) => writes.push({ p: String(p), body: String(body) }),
      });
      runtime.spawnShell();
      const childPid = children[0].child.pid;

      await children[0].child.handlers.exit(1, null);   // an unrecognized code -> crash branch

      expect(writes).toHaveLength(1);
      expect(writes[0].p.replace(/\\/g, '/')).toMatch(/C:\/home\/\.egpt\/state\/restart-announce\.json$/);
      expect(JSON.parse(writes[0].body)).toEqual({ chatId: '!self:beeper.com', kind: 'crash', preSha: 'abc123', pid: childPid });
    });

    it('wedge branch writes {chatId, kind: "wedge", preSha, pid} when no sidecar exists', async () => {
      let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
      const writes = [];
      const { runtime, children } = makeRuntime({
        now: () => clock,
        readFileSync: configReadFileSync,
        statSync: () => ({ mtimeMs: Date.UTC(2026, 5, 18, 11, 0, 0) }),  // ~1h-old beat file -> wedged
        writeFileSync: (p, body) => writes.push({ p: String(p), body: String(body) }),
        aliveGraceMs: 1_000, aliveStaleMs: 60_000,
      });
      runtime.spawnShell();
      const childPid = children[0].child.pid;
      clock += 5_000;
      runtime.checkLiveness();
      expect(children[0].child.killed).toEqual(['SIGTERM']);

      await children[0].child.handlers.exit(CLEAN_EXIT_CODE, 'SIGTERM');   // POSIX: trapped SIGTERM -> exit 0

      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0].body)).toEqual({ chatId: '!self:beeper.com', kind: 'wedge', preSha: 'abc123', pid: childPid });
    });

    it('neither branch clobbers an already-existing sidecar', async () => {
      const writes = [];
      let clock = Date.UTC(2026, 5, 18, 12, 0, 0);

      // crash side
      {
        const { runtime, children } = makeRuntime({
          readFileSync: configReadFileSync,
          existsSync: (p) => String(p).includes('restart-announce.json'),
          writeFileSync: (p, body) => writes.push({ p: String(p), body: String(body) }),
        });
        runtime.spawnShell();
        await children[0].child.handlers.exit(1, null);
      }
      // wedge side
      {
        const { runtime, children } = makeRuntime({
          now: () => clock,
          readFileSync: configReadFileSync,
          existsSync: (p) => String(p).includes('restart-announce.json'),
          statSync: () => ({ mtimeMs: Date.UTC(2026, 5, 18, 11, 0, 0) }),
          writeFileSync: (p, body) => writes.push({ p: String(p), body: String(body) }),
          aliveGraceMs: 1_000, aliveStaleMs: 60_000,
        });
        runtime.spawnShell();
        clock += 5_000;
        runtime.checkLiveness();
        await children[0].child.handlers.exit(CLEAN_EXIT_CODE, 'SIGTERM');
      }

      expect(writes.filter((w) => w.p.includes('restart-announce.json'))).toHaveLength(0);
    });

    it('a chatId-resolution failure (missing/unreadable config.yaml) is swallowed — respawn still proceeds, no sidecar written', async () => {
      const timers = [];
      const writes = [];
      const { runtime, children } = makeRuntime({
        // default readFileSync throws ENOENT for every path, including config.yaml
        writeFileSync: (p, body) => writes.push({ p: String(p), body: String(body) }),
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      });
      runtime.spawnShell();

      await children[0].child.handlers.exit(1, null);

      expect(writes.filter((w) => w.p.includes('restart-announce.json'))).toHaveLength(0);
      expect(timers).toHaveLength(1);
      timers[0].fn();
      expect(children).toHaveLength(2);   // respawn still proceeds despite the resolution failure
    });
  });
});

// ============================================================================================
// THE BOOT-FAILURE RECOVERY LADDER (operator 2026-08-30)
//
// The incident: ~/bin/egpt is both the production checkout and an agent's working dir. An
// agent left 9 files uncommitted, one with markdown backticks inside a template literal in
// config/config-schema.mjs; the spine died at MODULE LOAD with a SyntaxError, before it could
// boot or beat. This daemon restarted it every few seconds for 33 minutes, never escalated,
// never told anyone, and grew daemon-startup-err.log to 2.8 MB of the identical stack trace.
// Ruling, verbatim: "if the problem was a dirty tree, every[thing] can be archived to a
// branch or whatever, try 3 more restarts, the rollback... a spine being down, with a
// watcher, is just unjustifiable."
//
// Everything below runs against the injected spawn/spawnSync/fs/timer seams — no real git,
// no real spine, no real clock.
// ============================================================================================

const LADDER_CONFIG_YAML = 'networks:\n  whatsapp:\n    chat_ids:\n      - "!self:beeper.com"\n';

// A fake `git` (plus a no-op `npm install`) whose failure points are individually switchable,
// so each rung of the ladder can be driven off a cliff on purpose.
function makeGitWorld({ dirty = true, fail = {} } = {}) {
  const calls = [];
  let committed = false;
  const ok = (s = '') => ({ status: 0, stdout: Buffer.from(s), stderr: Buffer.from('') });
  const bad = (m) => ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from(`${m}\n`) });
  const fn = (cmd, args, opts) => {
    const argv = Array.isArray(args) ? args : [];
    calls.push({ cmd, args: argv, opts: Array.isArray(args) ? opts : args });
    if (cmd !== 'git') return ok();          // `npm install` is spawnSync('npm install', opts)
    const a = argv.join(' ');
    if (a === 'rev-parse --short HEAD') return ok('abc123\n');
    if (a === 'describe --tags --abbrev=0') return ok('v-test\n');
    if (a === 'rev-parse --abbrev-ref HEAD') return ok('main\n');
    if (a === 'status --porcelain') {
      if (fail.status) return bad('fatal: not a git repository');
      return ok(dirty && !committed ? ' M config/config-schema.mjs\n' : '');
    }
    if (argv[0] === 'checkout' && argv[1] === '-b') return fail.branch ? bad('cannot create branch') : ok();
    if (a === 'add -A') return fail.add ? bad('permission denied') : ok();
    if (argv[0] === 'commit') {
      if (fail.commit) return bad('nothing to commit, working tree clean');
      if (!fail.commitNoop) committed = true;   // commitNoop: exit 0 but the work never lands
      return ok();
    }
    if (argv[0] === 'rev-parse' && argv[1] === '--verify') return fail.verify ? bad('unknown revision') : ok('deadbeefcafe\n');
    if (argv[0] === 'push') return fail.push ? bad('no upstream configured') : ok();
    if (argv[0] === 'checkout') return fail.checkoutBack ? bad('checkout failed') : ok();
    return ok();
  };
  fn.calls = calls;
  fn.sigs = () => calls.map((c) => [c.cmd, ...c.args].join(' '));
  return fn;
}

function ladderReadFileSync({ lastGood = null, config = true } = {}) {
  return (p) => {
    const s = String(p);
    if (config && s.includes('config.yaml')) return LADDER_CONFIG_YAML;
    if (s.includes('last-good.json')) {
      if (lastGood == null) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return typeof lastGood === 'string' ? lastGood : JSON.stringify(lastGood);
    }
    const e = new Error('missing'); e.code = 'ENOENT'; throw e;
  };
}

// beats === null → alive.txt never exists (the SyntaxError case: the spine never gets far
// enough to write a beat). Otherwise `beats.mtimeMs` is a live, test-mutable mtime.
function makeLadder({ git = {}, lastGood = null, beats = null, extra = {} } = {}) {
  const timers = [];
  const writes = [];
  const spawnSync = makeGitWorld(git);
  const h = makeRuntime({
    spawnSync,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    writeFileSync: (p, body) => writes.push({ p: String(p), body: String(body) }),
    readFileSync: ladderReadFileSync({ lastGood }),
    statSync: beats ? (() => ({ mtimeMs: beats.mtimeMs })) : undefined,
    ...extra,
  });
  return { ...h, timers, writes, spawnSync };
}

// One never-healthy crash cycle: the child dies with an unrecognised code, then the scheduled
// respawn is fired so the next child exists.
async function crashOnce(h, { respawn = true, code = 1 } = {}) {
  const i = h.children.length - 1;
  await h.children[i].child.handlers.exit(code, null);
  if (respawn) h.timers.pop()?.fn();
}

async function crashTimes(h, n, o) {
  if (!h.children.length) h.runtime.spawnShell();
  for (let k = 0; k < n; k += 1) await crashOnce(h, o);
}

const announceWrites = (h) => h.writes.filter((w) => w.p.includes('restart-announce.json')).map((w) => JSON.parse(w.body));

describe('boot-failure recovery ladder (never-healthy crash loop)', () => {
  describe('never-healthy detection — the thing that separates it from every other failure', () => {
    it('a child that never advanced alive.txt is never-healthy; the streak climbs and no escalation fires yet', async () => {
      const h = makeLadder();                       // no alive.txt at all → never beat
      await crashTimes(h, 2);

      expect(h.runtime.state.neverHealthyStreak).toBe(2);
      expect(h.spawnSync.sigs()).not.toContain('git status --porcelain');   // below the rung
      expect(h.logs.join('')).toContain('never-healthy #2/3');
    });

    it("a child that BEAT and then crashed keeps today's plain backoff and clears the ladder", async () => {
      const beats = { mtimeMs: 1_000 };
      const h = makeLadder({ beats });
      await crashTimes(h, 2);                        // arm the ladder: two never-healthy crashes
      expect(h.runtime.state.neverHealthyStreak).toBe(2);

      // this child boots, beats for an hour, then dies — the beat file moved
      beats.mtimeMs = 9_999_999;
      await crashOnce(h);

      expect(h.runtime.state.neverHealthyStreak).toBe(0);
      expect(h.logs.join('')).toContain('crash — restarting in');   // the untouched old line
      expect(h.spawnSync.sigs()).not.toContain('git status --porcelain');
    });

    it('the streak clears the moment checkLiveness observes a beat, without waiting for an exit', async () => {
      const beats = { mtimeMs: 1_000 };
      const h = makeLadder({ beats, extra: { aliveGraceMs: 1_000, aliveStaleMs: 60_000 } });
      await crashTimes(h, 2);
      expect(h.runtime.state.neverHealthyStreak).toBe(2);

      beats.mtimeMs = 2_000;             // the freshly spawned child finally beat
      h.runtime.checkLiveness();

      expect(h.runtime.state.neverHealthyStreak).toBe(0);
      expect(h.logs.join('')).toContain('clearing the never-healthy streak (was 2)');
    });
  });

  describe('rung 2 — after 3 never-healthy crashes, archive and clean a dirty tree', () => {
    it('does not fire at 2 and does fire at 3', async () => {
      const h = makeLadder();
      await crashTimes(h, 2);
      expect(h.spawnSync.sigs().some((s) => s.startsWith('git checkout -b rescue/'))).toBe(false);

      await crashTimes(h, 1);
      expect(h.runtime.state.neverHealthyStreak).toBe(NEVER_HEALTHY_RESCUE_AT);
      expect(h.spawnSync.sigs().some((s) => s.startsWith('git checkout -b rescue/'))).toBe(true);
    });

    it('archives the dirty tree to a rescue BRANCH, verifies it, and only THEN checks the original branch back out', async () => {
      const h = makeLadder();
      await crashTimes(h, 3);

      const sigs = h.spawnSync.sigs();
      const at = (pred) => sigs.findIndex(pred);
      const iBranch = at((s) => s.startsWith('git checkout -b rescue/'));
      const iAdd = at((s) => s === 'git add -A');
      const iCommit = at((s) => s.startsWith('git commit -m rescue: dirty tree at boot failure'));
      const iVerify = at((s) => s.startsWith('git rev-parse --verify rescue/'));
      const iBack = at((s) => s === 'git checkout main');

      expect(iBranch).toBeGreaterThanOrEqual(0);
      expect(iAdd).toBeGreaterThan(iBranch);
      expect(iCommit).toBeGreaterThan(iAdd);
      expect(iVerify).toBeGreaterThan(iCommit);
      expect(iBack).toBeGreaterThan(iVerify);          // destructive step LAST, behind the gate
      expect(sigs.some((s) => s.startsWith('git push -u origin rescue/'))).toBe(true);
      expect(h.logs.join('')).toContain('and the working copy cleaned');
    });

    it('a push failure never blocks the recovery — the branch exists locally, that is the guarantee', async () => {
      const h = makeLadder({ git: { fail: { push: true } } });
      await crashTimes(h, 3);

      expect(h.spawnSync.sigs()).toContain('git checkout main');   // still cleaned
      expect(h.logs.join('')).toContain('could not be pushed');
      expect(h.logs.join('')).toContain('recovery continues');
    });

    it('ARCHIVE FAILURE DOES NOT CLEAN THE TREE: an unverifiable rescue branch checks nothing out', async () => {
      const h = makeLadder({ git: { fail: { verify: true } } });
      await crashTimes(h, 3);

      const sigs = h.spawnSync.sigs();
      expect(sigs.some((s) => s.startsWith('git rev-parse --verify rescue/'))).toBe(true);
      // nothing is checked out after the branch was created — not even back
      expect(sigs.filter((s) => s.startsWith('git checkout') && !s.includes(' -b '))).toEqual([]);
      expect(h.logs.join('')).toContain('REFUSING to clean the working tree');
      expect(announceWrites(h).at(-1).note).toContain('did not complete');
    });

    it('a commit that silently leaves work behind is caught by the post-commit status check', async () => {
      const h = makeLadder({ git: { fail: { commitNoop: true } } });
      await crashTimes(h, 3);

      expect(h.logs.join('')).toContain('work is STILL uncommitted after the archive commit');
      expect(h.spawnSync.sigs().filter((s) => s.startsWith('git checkout') && !s.includes(' -b '))).toEqual([]);
    });

    it('a failed commit restores the original branch (provably lossless: nothing is committed yet) and reports no clean', async () => {
      const h = makeLadder({ git: { fail: { commit: true } } });
      await crashTimes(h, 3);

      const sigs = h.spawnSync.sigs();
      expect(sigs).toContain('git checkout main');                        // restored…
      expect(sigs.some((s) => s.startsWith('git rev-parse --verify'))).toBe(false);   // …never claimed success
      expect(sigs.some((s) => s.startsWith('git push'))).toBe(false);
      expect(h.logs.join('')).toContain('REFUSING to clean the working tree');
      expect(h.logs.join('')).toContain('left exactly as it was');
    });

    it('a git status that cannot even be run is treated as "cannot tell" — nothing destructive happens', async () => {
      const h = makeLadder({ git: { fail: { status: true } } });
      await crashTimes(h, 3);

      expect(h.spawnSync.sigs().some((s) => s.startsWith('git checkout -b'))).toBe(false);
      expect(h.logs.join('')).toContain('git status --porcelain failed');
    });

    it('a CLEAN tree skips the archive entirely and just keeps counting towards the rollback', async () => {
      const h = makeLadder({ git: { dirty: false } });
      await crashTimes(h, 3);

      expect(h.spawnSync.sigs()).toContain('git status --porcelain');
      expect(h.spawnSync.sigs().some((s) => s.startsWith('git checkout -b'))).toBe(false);
      expect(h.logs.join('')).toContain('working tree is clean');
      expect(h.runtime.state.neverHealthyStreak).toBe(NEVER_HEALTHY_RESCUE_AT);
    });
  });

  describe('rung 3 — 3 more never-healthy crashes roll the code back', () => {
    it('rolls back at exactly the 6th crash, through runRewind, aimed at the recorded sha', async () => {
      const imported = [];
      const h = makeLadder({
        git: { dirty: false },
        lastGood: { sha: 'goodsha', at: '2026-08-29T10:00:00.000Z' },
        extra: { importModule: async (u) => { imported.push(u); return {}; } },
      });

      await crashTimes(h, 5);
      expect(h.spawnSync.sigs()).not.toContain('git checkout goodsha');

      await crashTimes(h, 1);
      expect(h.runtime.state.neverHealthyStreak).toBe(NEVER_HEALTHY_ROLLBACK_AT);
      expect(h.spawnSync.sigs()).toContain('git checkout goodsha');       // the existing rewind path
      expect(h.spawnSync.calls.some((c) => c.cmd === 'npm install')).toBe(true);
      expect(imported.some((u) => u.includes('/extension/build.mjs'))).toBe(true);
      expect(h.logs.join('')).toContain('rolling the code back to last-known-good goodsha');
      expect(announceWrites(h).at(-1).note).toContain('rolled back to last-known-good goodsha');
    });

    it('a MISSING last-good marker falls through to "keep restarting" instead of guessing a ref', async () => {
      const h = makeLadder({ git: { dirty: false } });     // no last-good.json on disk
      await crashTimes(h, 6);

      expect(h.spawnSync.sigs().some((s) => s.startsWith('git checkout ') && !s.includes(' -b '))).toBe(false);
      expect(h.logs.join('')).toContain('NOT guessing');
      expect(announceWrites(h).at(-1).note).toContain('no last-known-good marker');
      expect(h.children.length).toBe(7);                   // and it respawned regardless
    });

    it('an unreadable/garbage last-good marker is treated the same as missing', async () => {
      const h = makeLadder({ git: { dirty: false }, lastGood: '{not json' });
      await crashTimes(h, 6);

      expect(h.logs.join('')).toContain('NOT guessing');
      expect(h.children.length).toBe(7);
    });
  });

  describe('rung 4 — it NEVER stops trying', () => {
    it('keeps respawning past the rollback, loudly, with the capped backoff', async () => {
      const h = makeLadder({ git: { dirty: false }, lastGood: { sha: 'goodsha' } });
      await crashTimes(h, 12);

      expect(h.children.length).toBe(13);                       // still spawning
      expect(h.runtime.state.backoff).toBe(RESTART_MAX_MS);     // capped, never zero, never given up
      expect(h.processObj.exits).toEqual([]);                   // the daemon itself never left
      expect(h.logs.join('')).toContain('I will not stop');
    });
  });

  describe('the last-known-good marker', () => {
    it('records {sha, at} once a beating child has been up for LAST_GOOD_UPTIME_MS', () => {
      let clock = Date.UTC(2026, 7, 30, 12, 0, 0);
      const beats = { mtimeMs: clock };
      const h = makeLadder({ beats, extra: { now: () => clock } });
      h.runtime.spawnShell();

      clock += 120_000; beats.mtimeMs = clock;   // 2 min up: past boot, but not trusted yet
      h.runtime.checkLiveness();
      expect(h.writes.some((w) => w.p.includes('last-good.json'))).toBe(false);

      clock += LAST_GOOD_UPTIME_MS; beats.mtimeMs = clock;
      h.runtime.checkLiveness();
      const w = h.writes.filter((x) => x.p.includes('last-good.json'));
      expect(w).toHaveLength(1);
      expect(JSON.parse(w[0].body)).toEqual({ sha: 'abc123', at: new Date(clock).toISOString() });

      clock += LAST_GOOD_UPTIME_MS; beats.mtimeMs = clock;   // once per child, not every tick
      h.runtime.checkLiveness();
      expect(h.writes.filter((x) => x.p.includes('last-good.json'))).toHaveLength(1);
    });

    it('is not recorded for a child that is up but NOT beating (that is the wedge path)', () => {
      let clock = Date.UTC(2026, 7, 30, 12, 0, 0);
      const beats = { mtimeMs: clock };
      const h = makeLadder({ beats, extra: { now: () => clock, aliveGraceMs: 1_000, aliveStaleMs: 60_000 } });
      h.runtime.spawnShell();

      clock += LAST_GOOD_UPTIME_MS;              // up long enough, but the beat froze
      h.runtime.checkLiveness();

      expect(h.children[0].child.killed).toEqual(['SIGTERM']);       // wedge path, unchanged
      expect(h.writes.some((w) => w.p.includes('last-good.json'))).toBe(false);
    });
  });

  describe('escalations reach the operator', () => {
    it('force-overwrites a stale crash marker so the rescue branch is what the next boot announces', async () => {
      const h = makeLadder({ extra: { existsSync: () => true } });   // a sidecar already sits there
      await crashTimes(h, 3);

      const notes = announceWrites(h);
      expect(notes).toHaveLength(1);                       // routine crashes respected the guard…
      expect(notes[0].kind).toBe('rescue');                // …the escalation did not
      expect(notes[0].chatId).toBe('!self:beeper.com');
      expect(notes[0].note).toMatch(/archived on branch rescue\//);
    });

    it('every escalation logs at a louder volume than a routine respawn', async () => {
      const h = makeLadder({ lastGood: { sha: 'goodsha' } });
      await crashTimes(h, 2);
      expect(h.logs.some((l) => l.includes('!!!!'))).toBe(false);    // routine so far

      await crashTimes(h, 1);
      expect(h.logs.some((l) => l.includes('!!!!'))).toBe(true);
    });
  });

  describe('regression: the paths the ladder must not have disturbed', () => {
    it('exit code 44 still rewinds from the sidecar the SPINE wrote, and consumes it', async () => {
      const unlinked = [];
      const { runtime, children, spawnSync } = makeRuntime({
        spawnSync: makeGitWorld(),
        readFileSync: (p) => { if (String(p).includes('rewind-target.txt')) return 'v1.2.3\n'; const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
        unlinkSync: (p) => unlinked.push(String(p)),
      });
      runtime.spawnShell();

      await children[0].child.handlers.exit(44, null);

      expect(spawnSync.sigs()).toContain('git checkout v1.2.3');
      expect(unlinked.some((p) => p.includes('rewind-target.txt'))).toBe(true);
      expect(children).toHaveLength(2);
    });

    it('a wedge kill is still a wedge, not a never-healthy crash', async () => {
      let clock = Date.UTC(2026, 7, 30, 12, 0, 0);
      const h = makeLadder({ extra: { now: () => clock, aliveGraceMs: 1_000, aliveStaleMs: 60_000 } });
      h.runtime.spawnShell();
      clock += 5_000;
      h.runtime.checkLiveness();
      await h.children[0].child.handlers.exit(CLEAN_EXIT_CODE, 'SIGTERM');

      expect(h.runtime.state.wedgeStreak).toBe(1);
      expect(h.runtime.state.neverHealthyStreak).toBe(0);
      expect(h.spawnSync.sigs().some((s) => s.startsWith('git checkout -b'))).toBe(false);
    });
  });
});

// ── SLEEP IS NOT A WEDGE (operator 2026-09-03) ────────────────────────────────
// beatAge() is WALL-CLOCK age, which says nothing across a suspend: in Modern Standby the
// spine's timers do not fire, so alive.txt stops moving. reve wakes every 5 min, and 300s
// of sleep always exceeds the 150s stale threshold - so on EVERY resume the watchdog killed
// a healthy spine. 45 restarts in one night, each dropping every warm CLI.
//
// The tell is that the watchdog's OWN loop stopped ticking too. A watchdog that was itself
// frozen has no business blaming the thing it watches.
describe('daemon runtime: a sleep is not a wedge', () => {
  const OLD_BEAT = Date.UTC(2026, 5, 18, 11, 0, 0);   // ~1h before the clock starts: always stale

  it('a long gap between liveness ticks is a RESUME, not a wedge - the child survives', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children, logs } = makeRuntime({
      now: () => clock,
      statSync: () => ({ mtimeMs: OLD_BEAT }),
      aliveGraceMs: 1_000, aliveStaleMs: 60_000, livenessIntervalMs: 30_000,
    });
    runtime.spawnShell();
    clock += 500;                 // inside the boot grace: establishes the first tick, no kill
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual([]);

    clock += 300_000;             // the machine slept for 5 minutes
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual([]);                        // NOT killed
    expect(logs.join(' ')).toMatch(/machine slept/);                     // and it said why
  });

  // After a resume the spine genuinely needs a moment: the heartbeat is ~60s against a 150s
  // threshold, so merely skipping one 30s tick would not be enough.
  it('the post-resume grace protects a still-stale beat for a while', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children } = makeRuntime({
      now: () => clock,
      statSync: () => ({ mtimeMs: OLD_BEAT }),
      aliveGraceMs: 90_000, aliveStaleMs: 60_000, livenessIntervalMs: 30_000,
    });
    runtime.spawnShell();
    clock += 500;  runtime.checkLiveness();          // first tick
    clock += 300_000; runtime.checkLiveness();       // slept -> resume grace starts
    clock += 30_000;  runtime.checkLiveness();       // normal tick, inside the grace
    clock += 30_000;  runtime.checkLiveness();       // still inside
    expect(children[0].child.killed).toEqual([]);
  });

  // …but the grace is not indefinite: a spine that is REALLY wedged still gets restarted.
  // Each step here is one interval, so none of them looks like a sleep.
  it('once the post-resume grace expires, a genuinely stale beat is still a wedge', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children } = makeRuntime({
      now: () => clock,
      statSync: () => ({ mtimeMs: OLD_BEAT }),
      aliveGraceMs: 60_000, aliveStaleMs: 60_000, livenessIntervalMs: 30_000,
    });
    runtime.spawnShell();
    clock += 500;  runtime.checkLiveness();
    clock += 300_000; runtime.checkLiveness();       // slept -> 60s of resume grace
    clock += 30_000;  runtime.checkLiveness();       // +30s, inside grace
    expect(children[0].child.killed).toEqual([]);
    clock += 31_000;  runtime.checkLiveness();       // past the grace, beat still ancient
    expect(children[0].child.killed).toEqual(['SIGTERM']);
  });

  // Back-compat: with the watchdog ticking normally, nothing about the old behaviour moves.
  it('normal ticking still restarts a wedged child on the first stale check', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children } = makeRuntime({
      now: () => clock,
      statSync: () => ({ mtimeMs: OLD_BEAT }),
      aliveGraceMs: 1_000, aliveStaleMs: 60_000, livenessIntervalMs: 30_000,
    });
    runtime.spawnShell();
    clock += 5_000;               // past grace, one ordinary gap, beat ~1h stale
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual(['SIGTERM']);
  });

  // A disabled watchdog interval must not turn every tick into a "resume".
  it('livenessIntervalMs = 0 disables the sleep heuristic rather than firing it constantly', () => {
    let clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime, children } = makeRuntime({
      now: () => clock,
      statSync: () => ({ mtimeMs: OLD_BEAT }),
      aliveGraceMs: 1_000, aliveStaleMs: 60_000, livenessIntervalMs: 0,
    });
    runtime.spawnShell();
    clock += 300_000;             // a gap that WOULD look like sleep if the heuristic were on
    runtime.checkLiveness();
    expect(children[0].child.killed).toEqual(['SIGTERM']);   // treated as a wedge, as before
  });
});
