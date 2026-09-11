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
  REWIND_EXIT_CODE,
  STANDDOWN_EXIT_CODE,
  UPGRADE_EXIT_CODE,
  createDaemonRuntime,
  resolveProfiles,
  startProfileDaemons,
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
    peerProbe: extra.peerProbe,
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

  it('feeds liveDaemonPid a pid file content + the alive.txt beat age — for its own session marker, then for the incumbent spine', () => {
    const captured = [];
    const clock = Date.UTC(2026, 5, 18, 12, 0, 0);
    const { runtime } = makeRuntime({
      now: () => clock,
      // this session's daemon marker → "77"; spine.pid → "4242"; anything else is absent
      readFileSync: (p) => {
        const path = String(p);
        if (path.includes('daemon-s0.pid')) return '77\n';
        if (path.includes('spine.pid')) return '4242\n';
        const e = new Error('missing'); e.code = 'ENOENT'; throw e;
      },
      statSync: () => ({ mtimeMs: clock - 10_000 }),   // a 10s-old beat
      liveDaemonPid: (facts) => { captured.push(facts); return null; },   // observe, then allow start
    });
    runtime.start();
    expect(captured).toEqual([
      { pidFileContent: '77\n', beatAgeMs: 10_000 },      // checkSingleton: my session, this profile
      { pidFileContent: '4242\n', beatAgeMs: 10_000 },    // start(): is somebody already holding it?
    ]);
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

// ── THE STAND-DOWN WATCH (the Session 0 → Session 1 handover) ──────────────────────────────
// Exit 45 is the one lifecycle code that does NOT respawn: a peer spine has taken the profile
// (two spines share one EGPT_HOME here, so exactly one may hold it). The daemon is the only
// thing alive across the handover, so it watches the console port and brings the Session 0
// spine back when that port goes quiet — logoff or crash, the session ended.
//
// Everything below runs on the injected timer + prober seams: no real network, no real spine.
describe('daemon runtime: the stand-down watch (exit 45 — a peer took the profile)', () => {
  // A world where the probe's answer is a test-mutable boolean and the watch interval is
  // captured rather than armed, so every observation is driven by hand.
  function makeStandingDown({ answers = true, sidecar = null, configPort = null, extra = {} } = {}) {
    const state = { answers };
    const intervals = [];         // every setInterval the runtime armed
    const cleared = [];
    const probedPorts = [];
    const unlinked = [];
    const timers = [];            // setTimeout — a stand-down must arm NONE of these
    const h = makeRuntime({
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval: (id) => cleared.push(id),
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      unlinkSync: (p) => unlinked.push(String(p)),
      readFileSync: (p) => {
        const path = String(p);
        if (path.includes('standdown-target.txt')) {
          if (sidecar == null) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
          return sidecar;
        }
        if (path.includes('config.yaml') && configPort != null) return `shell:\n  port: ${configPort}\n`;
        const e = new Error('missing'); e.code = 'ENOENT'; throw e;
      },
      peerProbe: ({ port }) => { probedPorts.push(port); return async () => state.answers; },
      ...extra,
    });
    // Drive the watch interval the runtime armed (the last one — start() also arms liveness).
    const tick = async (n = 1) => { for (let k = 0; k < n; k += 1) await intervals.at(-1).fn(); };
    return { ...h, state, intervals, cleared, probedPorts, unlinked, timers, tick };
  }

  it('exit 45 does NOT respawn — it stands down and watches the port the departing spine named', async () => {
    const h = makeStandingDown({ sidecar: '23999\n' });
    h.runtime.spawnShell();

    await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

    expect(h.children).toHaveLength(1);                 // no respawn
    expect(h.timers).toEqual([]);                       // and no backoff timer armed either
    expect(h.processObj.exits).toEqual([]);             // the daemon itself stayed up
    expect(h.runtime.state.standingDown).toBe(true);
    expect(h.probedPorts).toEqual([23999]);             // the port the exit carried
    expect(h.unlinked.some((p) => p.includes('standdown-target.txt'))).toBe(true);   // consumed
    expect(h.logs.join('')).toContain('stood down — a peer has taken the profile on 127.0.0.1:23999');
  });

  it('a peer that keeps answering is never displaced, however long the watch runs', async () => {
    const h = makeStandingDown({ sidecar: '23375', answers: true });
    h.runtime.spawnShell();
    await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

    await h.tick(20);

    expect(h.children).toHaveLength(1);
    expect(h.runtime.state.standingDown).toBe(true);
  });

  // THE HYSTERESIS IS THE SAFETY ARGUMENT (peer-liveness.mjs): believing the peer dead when it
  // is alive would put TWO spines on one EGPT_HOME — two Beeper connections, two answers, both
  // writing conversations.yaml. So one missed probe, or two, proves nothing.
  it('a single missed probe does not respawn — it takes claimAfter CONSECUTIVE misses', async () => {
    const h = makeStandingDown({ sidecar: '23375', answers: true });
    h.runtime.spawnShell();
    await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

    await h.tick(1);                    // alive
    h.state.answers = false;
    await h.tick(1);                    // one miss
    expect(h.children).toHaveLength(1);
    await h.tick(1);                    // two misses — still not enough
    expect(h.children).toHaveLength(1);

    h.state.answers = true;             // it answered again: the dead streak resets
    await h.tick(1);
    h.state.answers = false;
    await h.tick(2);                    // two fresh misses — still not enough
    expect(h.children).toHaveLength(1);

    await h.tick(1);                    // the third consecutive miss
    expect(h.children).toHaveLength(2);
  });

  it('the port going quiet respawns EXACTLY ONCE and tears the watch down — no storm', async () => {
    const h = makeStandingDown({ sidecar: '23375', answers: false });
    h.runtime.spawnShell();
    await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
    const watchId = h.intervals.length;   // the id the fake setInterval handed back

    await h.tick(3);
    expect(h.children).toHaveLength(2);                 // the Session 0 spine is back
    expect(h.cleared).toContain(watchId);               // …and the watch is gone
    expect(h.runtime.state.standingDown).toBe(false);
    expect(h.logs.join('')).toContain('127.0.0.1:23375 went quiet');

    await h.tick(10);                                   // late ticks must not spawn a second
    expect(h.children).toHaveLength(2);
  });

  it('the respawn after a hand-back is a clean start, not the next rung of the crash backoff', async () => {
    const h = makeStandingDown({ sidecar: '23375', answers: false });
    h.runtime.spawnShell();
    await h.children[0].child.handlers.exit(1, null);   // a crash first: the backoff doubles
    h.timers.pop().fn();
    expect(h.runtime.state.backoff).toBe(RESTART_MIN_MS * 2);

    await h.children[1].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
    await h.tick(3);

    expect(h.children).toHaveLength(3);
    expect(h.runtime.state.backoff).toBe(RESTART_MIN_MS);
  });

  describe('which port gets watched', () => {
    it("falls back to this profile's own console port when the exit named none", async () => {
      const h = makeStandingDown({ sidecar: null, configPort: 24001 });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      expect(h.probedPorts).toEqual([24001]);
    });

    it('falls back to 23375 when neither the exit nor the config names one', async () => {
      const h = makeStandingDown({ sidecar: null });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      expect(h.probedPorts).toEqual([23375]);
    });

    it('a garbage sidecar is consumed and ignored rather than probed', async () => {
      const h = makeStandingDown({ sidecar: 'not-a-port\n', configPort: 24002 });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      expect(h.probedPorts).toEqual([24002]);
      expect(h.unlinked.some((p) => p.includes('standdown-target.txt'))).toBe(true);
    });
  });

  // REGRESSION LOCK: 45 is additive. Every other code keeps the behaviour it had, and none of
  // them stands anything down or probes anything.
  describe('regression: no other exit code stands down', () => {
    it('42 / 43 / 44 respawn immediately and start no watch', async () => {
      for (const code of [UPGRADE_EXIT_CODE, RESTART_EXIT_CODE, REWIND_EXIT_CODE]) {
        const h = makeStandingDown({ extra: { spawnSync: makeGitWorld() } });
        h.runtime.spawnShell();
        await h.children[0].child.handlers.exit(code, null);
        expect(h.children).toHaveLength(2);                 // respawned, as before
        expect(h.runtime.state.standingDown).toBe(false);
        expect(h.probedPorts).toEqual([]);                  // nothing was ever probed
      }
    });

    it('0 still stops the daemon and 1 still takes the backoff ladder — neither watches a port', async () => {
      const clean = makeStandingDown();
      clean.runtime.spawnShell();
      await clean.children[0].child.handlers.exit(CLEAN_EXIT_CODE, null);
      expect(clean.processObj.exits).toEqual([0]);
      expect(clean.children).toHaveLength(1);
      expect(clean.probedPorts).toEqual([]);

      const crash = makeStandingDown();
      crash.runtime.spawnShell();
      await crash.children[0].child.handlers.exit(1, null);
      expect(crash.timers).toHaveLength(1);
      expect(crash.timers[0].ms).toBe(RESTART_MIN_MS);
      crash.timers[0].fn();
      expect(crash.children).toHaveLength(2);
      expect(crash.runtime.state.backoff).toBe(RESTART_MIN_MS * 2);
      expect(crash.probedPorts).toEqual([]);
      expect(crash.runtime.state.standingDown).toBe(false);
    });
  });
});

// =====================================================================================
// THE SINGLETON IS SCOPED TO THE SESSION, NOT TO THE PROFILE.
// =====================================================================================
// The Session 0 -> Session 1 handover needs TWO daemons alive on ONE EGPT_HOME: the NSSM
// service in session 0 and the logon daemon in session 1. The old guard read state/spine.pid
// under the SHARED profile, so at logon the successor's daemon always met a fresh beat and a
// live pid and exited before spawning anything (setup/register-session1-autostart.ps1's
// DECISION 1 is a page about exactly this). What must STILL be refused is a second daemon in
// the SAME session on the SAME profile — that is the invariant protecting one EGPT_HOME from
// two supervisors, and through them from two spines.
describe('daemon runtime: the singleton is session-scoped', () => {
  const CLOCK = Date.UTC(2026, 5, 18, 12, 0, 0);

  // A faithful stand-in for the real liveDaemonPid: any parsable positive pid is LIVE, and the
  // beat gate is the real 120s one. Keeps the test off real pids while preserving the predicate.
  const fakeLive = ({ pidFileContent, beatAgeMs }) => {
    const n = Number(String(pidFileContent ?? '').trim());
    return Number.isInteger(n) && n > 0 && beatAgeMs < 120_000 ? n : null;
  };

  function makeSessioned({ session1 = false, files = {}, beatAgeMs = 10_000, extra = {} } = {}) {
    const processObj = makeProcess();
    processObj.pid = 4242;
    if (session1) processObj.env.EGPT_SESSION1 = '1';
    const written = [];
    const unlinked = [];
    const read = [];
    const probedPorts = [];
    const intervals = [];
    const timers = [];
    const h = makeRuntime({
      processObj,
      now: () => CLOCK,
      statSync: () => ({ mtimeMs: CLOCK - beatAgeMs }),
      readFileSync: (p) => {
        const path = String(p).replace(/\\/g, '/');
        read.push(path);
        for (const [suffix, body] of Object.entries(files)) if (path.endsWith(suffix)) return body;
        const e = new Error('missing'); e.code = 'ENOENT'; throw e;
      },
      writeFileSync: (p, body) => written.push({ path: String(p).replace(/\\/g, '/'), body: String(body) }),
      unlinkSync: (p) => unlinked.push(String(p).replace(/\\/g, '/')),
      mkdirSync: () => {},
      liveDaemonPid: fakeLive,
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      peerProbe: ({ port }) => { probedPorts.push(port); return async () => true; },
      ...extra,
    });
    return { ...h, processObj, written, unlinked, read, probedPorts, intervals, timers };
  }

  describe('what is still refused', () => {
    it('a SECOND daemon in the SAME session on the SAME profile is refused', () => {
      const h = makeSessioned({ files: { 'state/daemon-s0.pid': '9001\n' } });

      expect(h.runtime.start()).toBeNull();

      expect(h.children).toHaveLength(0);
      expect(h.processObj.exits).toEqual([0]);
      expect(h.logs.join('')).toContain('another egpt daemon is already alive');
      expect(h.logs.join('')).toContain('9001');
    });

    it('two SESSION 1 daemons refuse each other too — the rule is per session, not "s0 only"', () => {
      const h = makeSessioned({ session1: true, files: { 'state/daemon-s1.pid': '9002\n' } });

      expect(h.runtime.start()).toBeNull();
      expect(h.children).toHaveLength(0);
      expect(h.processObj.exits).toEqual([0]);
    });

    it('a stale beat still clears the field, exactly as before', () => {
      const h = makeSessioned({ files: { 'state/daemon-s0.pid': '9001\n' }, beatAgeMs: 200_000 });
      h.runtime.start();
      expect(h.children).toHaveLength(1);
    });
  });

  describe('what is now allowed — and it is the whole point', () => {
    it('a daemon in a DIFFERENT session on the same profile starts', () => {
      // The logon daemon: session 0's daemon marker is live and the profile is beating.
      const h = makeSessioned({
        session1: true,
        files: { 'state/daemon-s0.pid': '9001\n', 'state/spine.pid': '9500\n' },
      });

      const child = h.runtime.start();

      expect(child).not.toBeNull();
      expect(h.children).toHaveLength(1);
      expect(h.processObj.exits).toEqual([]);
    });

    it("the successor's daemon is not blocked by the incumbent SPINE either", () => {
      const h = makeSessioned({ session1: true, files: { 'state/spine.pid': '9500\n' } });
      h.runtime.start();
      expect(h.children).toHaveLength(1);
      expect(h.probedPorts).toEqual([]);          // it spawns; it does not stand down
      expect(h.runtime.state.standingDown).toBe(false);
    });
  });

  describe('the marker each daemon writes for its own session', () => {
    it('is read and written under state/daemon-s0.pid in the service session', () => {
      const h = makeSessioned();
      h.runtime.start();
      expect(h.read.some((p) => p.endsWith('state/daemon-s0.pid'))).toBe(true);
      expect(h.written.map((w) => w.path)).toContain('C:/home/.egpt/state/daemon-s0.pid');
      expect(h.written.find((w) => w.path.endsWith('daemon-s0.pid')).body).toBe('4242');
    });

    it('is state/daemon-s1.pid in the logon session — different file, different session', () => {
      const h = makeSessioned({ session1: true });
      h.runtime.start();
      expect(h.read.some((p) => p.endsWith('state/daemon-s1.pid'))).toBe(true);
      expect(h.written.map((w) => w.path)).toContain('C:/home/.egpt/state/daemon-s1.pid');
      expect(h.read.some((p) => p.endsWith('state/daemon-s0.pid'))).toBe(false);
    });

    it('is removed on shutdown, so the next daemon in this session is not blocked by a ghost', () => {
      const h = makeSessioned();
      h.runtime.start();
      h.runtime.shutdown('SIGTERM');
      expect(h.unlinked.some((p) => p.endsWith('state/daemon-s0.pid'))).toBe(true);
    });

    it('says so — never silently — when the marker cannot be written', () => {
      const h = makeSessioned({ extra: { writeFileSync: () => { throw new Error('EACCES'); } } });
      h.runtime.start();
      expect(h.logs.join('')).toContain('would NOT be refused');
      expect(h.children).toHaveLength(1);        // …and it still supervises
    });
  });

  // The session scoping opens a door the profile-scoped guard used to hold shut: a daemon
  // arriving while somebody ELSE already holds this profile. Only the SUCCESSOR may do that
  // (its spine announces the stand-down and takes the port). Anyone else must not put a second
  // spine on the profile — so it takes the seat the departing daemon would have taken: it
  // watches the port and comes back when it goes quiet.
  describe('arriving into a profile somebody else is holding', () => {
    it('a non-successor daemon does NOT spawn beside a live incumbent spine — it stands down and watches', () => {
      const h = makeSessioned({ files: { 'state/spine.pid': '9500\n' } });

      const child = h.runtime.start();

      expect(child).toBeNull();
      expect(h.children).toHaveLength(0);                    // no second spine on this EGPT_HOME
      expect(h.processObj.exits).toEqual([]);                // and the daemon did NOT exit
      expect(h.runtime.state.standingDown).toBe(true);
      expect(h.probedPorts).toEqual([23375]);
      expect(h.logs.join('')).toContain('9500');
    });

    it('that watch respawns on the same terms as a stand-down: only after the port goes quiet', async () => {
      const answers = { up: true };
      const h = makeSessioned({
        files: { 'state/spine.pid': '9500\n' },
        extra: { peerProbe: () => async () => answers.up },
      });
      h.runtime.start();
      // start() arms the watch first and the liveness sweep after it; the watch is the one on
      // peer-liveness's 5s cadence.
      const watch = h.intervals.find((i) => i.ms === 5_000);
      const tick = async (n) => { for (let k = 0; k < n; k += 1) await watch.fn(); };

      await tick(5);
      expect(h.children).toHaveLength(0);                    // it answers: never displaced

      answers.up = false;
      await tick(2);
      expect(h.children).toHaveLength(0);                    // two misses prove nothing
      await tick(1);
      expect(h.children).toHaveLength(1);                    // the third claims
    });

    it('an ordinary boot with no live spine spawns immediately, as it always did', () => {
      const h = makeSessioned({ files: { 'state/spine.pid': '9500\n' }, beatAgeMs: 200_000 });
      expect(h.runtime.start()).not.toBeNull();
      expect(h.children).toHaveLength(1);
      expect(h.probedPorts).toEqual([]);
    });
  });

  it('every spawned spine carries ITS OWN profile in EGPT_HOME', () => {
    const h = makeSessioned();
    h.runtime.start();
    expect(h.children[0].opts.env).toMatchObject({ EGPT_HOME: 'C:/home/.egpt', EGPT_SUPERVISED: '1' });
  });
});

// =====================================================================================
// ONE DAEMON, N PROFILES — the supervision axis is the SESSION, so the session 0 daemon
// supervises every session 0 profile (kg's ~/.egpt AND kg2's ~/.egpt-secondary) instead of
// there being one service per account.
// =====================================================================================
describe('resolveProfiles', () => {
  it('is a one-element list from EGPT_HOME when EGPT_HOMES says nothing', () => {
    expect(resolveProfiles({ EGPT_HOME: 'C:/home/.egpt' })).toEqual(['C:/home/.egpt']);
  });

  it('splits EGPT_HOMES on ; and trims', () => {
    expect(resolveProfiles({ EGPT_HOMES: ' C:/a ; C:/b ' })).toEqual(['C:/a', 'C:/b']);
  });

  it('drops empties and duplicates rather than supervising one profile twice', () => {
    expect(resolveProfiles({ EGPT_HOMES: 'C:/a;;C:/a/;C:/b' })).toEqual(['C:/a', 'C:/b']);
  });

  it('falls back to EGPT_HOME when EGPT_HOMES is present but empty', () => {
    expect(resolveProfiles({ EGPT_HOMES: '   ;  ', EGPT_HOME: 'C:/home/.egpt' })).toEqual(['C:/home/.egpt']);
  });
});

describe('startProfileDaemons: one daemon, several profiles', () => {
  function fakeRuntime(opts, script = {}) {
    const r = {
      opts,
      started: 0,
      state: { standingDown: false },
      start() { r.started += 1; return script.start === undefined ? {} : script.start; },
      shutdown() {},
    };
    if (script.standingDown) r.state.standingDown = true;
    return r;
  }

  function harness({ env = {}, profiles, script = () => ({}) } = {}) {
    const logs = [];
    const exits = [];
    const made = [];
    const processObj = { env, pid: 7, on: () => {}, exit: (c) => exits.push(c) };
    const result = startProfileDaemons({
      profiles,
      processObj,
      stdout: { write: (m) => logs.push(m) },
      now: () => Date.UTC(2026, 5, 18, 12, 0, 0),
      createRuntime: (o) => { const r = fakeRuntime(o, script(o.egptHome)); made.push(r); return r; },
    });
    return { result, logs, exits, made, processObj };
  }

  it('creates one runtime per profile, each pinned to its own EGPT_HOME', () => {
    const h = harness({ profiles: ['C:/a', 'C:/b'] });
    expect(h.made.map((r) => r.opts.egptHome)).toEqual(['C:/a', 'C:/b']);
    expect(h.made.every((r) => r.started === 1)).toBe(true);
    expect(h.logs.join('')).toContain('supervising 2 profile(s): C:/a, C:/b');
  });

  it('reads the profile list off the environment when it is not told one', () => {
    const h = harness({ env: { EGPT_HOMES: 'C:/a;C:/b' } });
    expect(h.made.map((r) => r.opts.egptHome)).toEqual(['C:/a', 'C:/b']);
  });

  it('a clean exit on ONE profile does not take the process (and the other profile) down', () => {
    const h = harness({ profiles: ['C:/a', 'C:/b'] });
    h.made[0].opts.processObj.exit(0);
    expect(h.exits).toEqual([]);
    expect(h.logs.join('')).toContain('C:/a is no longer supervised');
    expect(h.logs.join('')).toContain('still supervising C:/b');
  });

  it('the process exits only when the LAST profile is gone', () => {
    const h = harness({ profiles: ['C:/a', 'C:/b'] });
    h.made[0].opts.processObj.exit(0);
    h.made[1].opts.processObj.exit(0);
    expect(h.exits).toEqual([0]);
  });

  it('each profile gets its own exit seam — one refusing does not retire the other twice', () => {
    const h = harness({ profiles: ['C:/a', 'C:/b'] });
    h.made[0].opts.processObj.exit(0);
    h.made[0].opts.processObj.exit(0);
    expect(h.exits).toEqual([]);
  });

  // INTENT.md: half-alive is worse than down. A node asked for two profiles that came up with
  // one must not look healthy.
  it('says LOUDLY when it comes up supervising fewer profiles than it was asked for', () => {
    const h = harness({
      profiles: ['C:/a', 'C:/b'],
      script: (home) => (home === 'C:/b' ? { start: null } : {}),
    });
    const out = h.logs.join('');
    expect(out).toContain('!!');
    expect(out).toContain('C:/b');
    expect(out).toContain('supervising 1 of 2');
  });

  it('a profile that STOOD DOWN counts as supervised — the watch is the supervision', () => {
    const h = harness({
      profiles: ['C:/a', 'C:/b'],
      script: (home) => (home === 'C:/b' ? { start: null, standingDown: true } : {}),
    });
    expect(h.logs.join('')).not.toContain('!!');
  });

  it('a runtime that THROWS is reported and the other profiles still come up', () => {
    const logs = [];
    const made = [];
    const result = startProfileDaemons({
      profiles: ['C:/a', 'C:/b'],
      processObj: { env: {}, pid: 7, on: () => {}, exit: () => {} },
      stdout: { write: (m) => logs.push(m) },
      now: () => 0,
      createRuntime: (o) => {
        const r = {
          opts: o,
          state: { standingDown: false },
          start() { if (o.egptHome === 'C:/a') throw new Error('boom'); return {}; },
        };
        made.push(r);
        return r;
      },
    });
    expect(made).toHaveLength(2);
    expect(logs.join('')).toContain('boom');
    expect(result.failed).toEqual(['C:/a']);
  });
});
