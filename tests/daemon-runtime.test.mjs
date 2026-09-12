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
    // Anything not named above reaches the runtime as-is. Without this the list was an
    // ALLOWLIST that silently dropped seams a test passed — and a dropped fs seam is not an
    // inert test bug: mkdirSync fell through to the real one and made C:\home\.egpt\state on
    // the developer's disk. Spread LAST so an explicit key above is the default, not the law.
    ...extra,
  });
  return { runtime, children, logs, processObj, spawnSync };
}

// The clock every fake world here runs on — the same instant makeRuntime's default `now`
// returns, so a test can compute an alive.txt mtime that is exactly N ms old.
const CLOCK = Date.UTC(2026, 5, 18, 12, 0, 0);

// A faithful stand-in for the real liveDaemonPid: any parsable positive pid is LIVE, and the
// beat gate is the real 120s one. Keeps the tests off real pids while preserving the predicate.
// Shared by the singleton suite and the stand-down watch, because they now ask the SAME
// question of the SAME file — "is anybody holding this profile?" — and a second stand-in that
// drifted from this one would let the two disagree in tests while agreeing in production.
const fakeLive = ({ pidFileContent, beatAgeMs }) => {
  const n = Number(String(pidFileContent ?? '').trim());
  return Number.isInteger(n) && n > 0 && beatAgeMs < 120_000 ? n : null;
};

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
  // `answers` is what the PORT says; `state.spinePid` is who state/spine.pid names. Both are
  // test-mutable, because the two signals must be able to disagree — that disagreement is the
  // whole subject of this suite now.
  function makeStandingDown({ answers = true, sidecar = null, configPort = null, spinePid = null, beatAgeMs = 10_000, extra = {} } = {}) {
    const state = { answers, spinePid };
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
        // WHO HOLDS THE PROFILE. Absent unless a test puts a pid there, so every case written
        // before the pid became half of the answer still models "nobody is holding it".
        if (path.includes('spine.pid') && state.spinePid != null) return `${state.spinePid}\n`;
        const e = new Error('missing'); e.code = 'ENOENT'; throw e;
      },
      // alive.txt's mtime — the OTHER half of livePidIn, and fresh by default so a test that
      // moves state.spinePid mid-run gets a LIVE pid rather than a live pid behind a dead beat.
      // A profile with no pid file is unheld whatever the beat says, so this changes nothing
      // for the cases written before the pid became half of the answer.
      statSync: () => ({ mtimeMs: CLOCK - beatAgeMs }),
      liveDaemonPid: fakeLive,
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

  // "THE PEER ANSWERING" IS ITS spine.pid, not its port. These two were written when the port
  // WAS the question; the observation they are about — an alive peer is never displaced, and it
  // takes three consecutive dead readings to claim — is unchanged, it is just being asked of the
  // signal that actually names a holder.
  it('a peer that keeps holding the profile is never displaced, however long the watch runs', async () => {
    const h = makeStandingDown({ sidecar: '23375', answers: true, spinePid: 11924 });
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
    const h = makeStandingDown({ sidecar: '23375', answers: false, spinePid: 11924 });
    h.runtime.spawnShell();
    await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

    await h.tick(1);                    // alive
    h.state.spinePid = null;
    await h.tick(1);                    // one miss
    expect(h.children).toHaveLength(1);
    await h.tick(1);                    // two misses — still not enough
    expect(h.children).toHaveLength(1);

    h.state.spinePid = 11924;           // it is back: the dead streak resets
    await h.tick(1);
    h.state.spinePid = null;
    await h.tick(2);                    // two fresh misses — still not enough
    expect(h.children).toHaveLength(1);

    await h.tick(1);                    // the third consecutive miss
    expect(h.children).toHaveLength(2);
  });

  // =====================================================================================
  // THE PORT IS NOT THE MUTEX (reve, 2026-09-11 logon — two spines on one profile, ~2 min).
  // =====================================================================================
  // The S0→S1 handover worked: exit 45, the S0 daemon stood down, the S1 spine took ~/.egpt.
  // Then Beeper — which claims the first free port upward from 23373 — took 23375 the instant
  // the departing spine released it, so the successor never bound its console port at all
  // (`SPINE 11924 session=1 listening=-`). The watch asked the PORT "has the peer released the
  // profile?", the port eventually said yes, and spawnShell() started a SECOND spine onto a
  // profile that was already held. A spine that is alive but cannot bind its port must not be
  // invisible to the mutex — so the watch reads state/spine.pid through the same liveDaemonPid
  // predicate checkSingleton uses, and claims only when BOTH signals say nobody is there.
  describe('what "the peer released the profile" means', () => {
    it('a LIVE spine.pid holds the profile even while the console port is dead silent — no second spine', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: false, spinePid: 11924 });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      await h.tick(20);                                  // six times over the claim streak

      expect(h.children).toHaveLength(1);                // the S0 spine stayed down
      expect(h.runtime.state.standingDown).toBe(true);
      expect(h.logs.join('')).toContain('names LIVE pid 11924');
    });

    it('says which signal is holding it — the line names the quiet port AND the live pid', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: false, spinePid: 11924 });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      await h.tick(1);
      const said = h.logs.join('');
      expect(said).toContain('127.0.0.1:23475 is quiet');
      expect(said).toContain('the profile IS held');

      // …once, on the transition — a stand-down can last a workday and this must not become
      // the log's whole texture.
      const before = h.logs.length;
      await h.tick(5);
      expect(h.logs.length).toBe(before);
    });

    // ===================================================================================
    // THE REVERSE DISAGREEMENT — AND THE PORT DOES NOT GET A VETO (operator, that same night).
    // ===================================================================================
    // 03be7c0 read a busy port with no live pid as "still held", on the argument that a dead
    // pid is a routine false negative after a suspend (beatAge is wall-clock). The operator
    // rejected the consequence — "A squatter on the console port now keeps the daemon stood
    // down indefinitely?! we are at the mercy of a squatter?" — and two measurements say the
    // argument was wrong: the suspend case already has checkLiveness's resume grace, and the
    // console port is not load-bearing for serving (the S1 spine logged EADDRINUSE 16 times
    // and served 6 real turns in the same window). So: spine.pid decides, the port reports.
    it('a busy port with NO live spine is CLAIMED — a squatter cannot keep this node down', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: true, spinePid: null });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      await h.tick(2);
      expect(h.children).toHaveLength(1);                // the asymmetry is unchanged: two prove nothing
      await h.tick(1);
      expect(h.children).toHaveLength(2);                // the third claims, busy port and all
      expect(h.runtime.state.standingDown).toBe(false);
    });

    it('says what it saw on the port and that it respawned anyway — not that the port was quiet', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: true, spinePid: null });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      await h.tick(3);
      const said = h.logs.join('');
      expect(said).toContain('that is a squatter, not the peer');       // observed, on the transition
      expect(said).toContain('does not get a vote');                    // and what was done about it
      expect(said).toContain('is still BUSY');
      expect(said).not.toContain('23475 is quiet');                     // the claim line must not lie
    });

    // The other half of the same honesty: the respawned spine walking into a squatted console
    // is a NORMAL outcome now, so the line that starts it says so rather than leaving a human
    // to discover it in the spine's log.
    it('warns that the respawned spine will probably not get its console, and that this is expected', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: true, spinePid: null });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      await h.tick(3);
      expect(h.logs.join('')).toContain('will say so and keep serving');
    });

    // A LIVE pid with a BUSY port is the ordinary held case — the two signals agree, so there
    // is nothing to explain and the watch must not invent a disagreement line for it.
    it('a live pid with a busy port is held silently — no disagreement to report', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: true, spinePid: 11924 });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      const before = h.logs.length;
      await h.tick(10);
      expect(h.children).toHaveLength(1);
      expect(h.logs.length).toBe(before);
    });

    // THE RESUME GRACE IS REUSED, NOT RE-DERIVED. checkLiveness owns the "the machine slept"
    // observation (its comment: 45 restarts in one night), and while its grace is open a
    // dead-looking pid is the expected reading of a healthy peer, not evidence of a departure.
    // The grace is armed by the child-liveness sweep, so what this covers is a stand-down
    // entered while a grace opened by the OUTGOING child is still running.
    it('does not believe a dead pid while checkLiveness\'s resume grace is still open', async () => {
      let clock = CLOCK;
      const h = makeStandingDown({
        sidecar: '23475', answers: false, spinePid: null,
        extra: { now: () => clock, aliveGraceMs: 90_000, aliveStaleMs: 150_000, livenessIntervalMs: 30_000 },
      });
      h.runtime.spawnShell();
      // The machine slept: the sweep's own loop skipped, so it arms the grace instead of
      // killing a healthy spine. This is the ONLY writer of that grace — one ordinary tick to
      // set the mark, then the gap.
      h.runtime.checkLiveness();
      clock += 3_600_000;
      h.runtime.checkLiveness();
      expect(h.logs.join('')).toContain('the machine slept');

      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      // Ticks advance the clock the way real ones do — 5s apart. A test that jumped the clock
      // between ticks would be staging a SECOND sleep, and the watch would rightly re-arm the
      // grace forever; that is behaviour, not a test artefact, so the test has to tick.
      const step = async (n) => { for (let k = 0; k < n; k += 1) { clock += 5_000; await h.tick(1); } };

      await step(5);                                     // well past the three-miss streak
      expect(h.children).toHaveLength(1);                // …but the grace says do not believe it
      expect(h.logs.join('')).toContain('resume grace');

      await step(25);                                    // the 90s grace lapses, then three misses
      expect(h.children).toHaveLength(2);                // and now a dead pid is believed
    });

    // =====================================================================================
    // A SLEEP THAT SPANS THE WHOLE STAND-DOWN — the case the port veto used to cover.
    // =====================================================================================
    // Timers do not fire in Modern Standby, so on resume the 5s stand-down tick and the 30s
    // liveness sweep are BOTH overdue; libuv runs expired timers by due time, so the 5s one
    // goes first. Three of its misses land at ~+10s, the sweep's first tick at ~+30s. With the
    // resume observation reachable only from the sweep, the watch would claim before the sweep
    // ever spoke — onto a peer that is alive and whose overdue heartbeat has not landed yet.
    // That is the unrecoverable direction, and until 03be7c0's port veto was removed it was
    // covered only by the peer happening to hold its console port.
    it('a sleep spanning the whole stand-down does not claim — the WATCH takes the resume observation', async () => {
      let clock = CLOCK;
      const h = makeStandingDown({
        sidecar: '23475', answers: false, spinePid: 11924,
        extra: { now: () => clock, aliveGraceMs: 90_000, aliveStaleMs: 150_000, livenessIntervalMs: 30_000 },
      });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      await h.tick(1);                                   // one ordinary tick: the peer holds it

      // An hour of Modern Standby. Nothing ticks — not this watch, not the liveness sweep.
      // On resume alive.txt is an hour old, so pid 11924 reads DEAD even though it is alive.
      clock += 3_600_000;
      await h.tick(3);                                   // the three misses that would claim

      expect(h.children).toHaveLength(1);                // no second spine onto the live peer
      expect(h.logs.join('')).toContain('the machine slept');
      expect(h.logs.join('')).toContain('resume grace');
    });

    // …and it is a GRACE, not an amnesty: a peer that really did depart over the sleep is
    // still claimed, just one grace-length later.
    it('a peer that really is gone is still claimed once the resume grace lapses', async () => {
      let clock = CLOCK;
      const h = makeStandingDown({
        sidecar: '23475', answers: false, spinePid: null,
        extra: { now: () => clock, aliveGraceMs: 90_000, aliveStaleMs: 150_000, livenessIntervalMs: 30_000 },
      });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      await h.tick(1);
      clock += 3_600_000;
      await h.tick(3);
      expect(h.children).toHaveLength(1);                // held open by the grace

      // …and then the clock runs normally again, 5s per tick, so nothing looks like a second
      // sleep. The 90s grace lapses and the three misses land.
      for (let k = 0; k < 25; k += 1) { clock += 5_000; await h.tick(1); }
      expect(h.children).toHaveLength(2);
    });

    // The resume line must not describe a spine this daemon does not have. It supervises no
    // child at all while stood down — that is the whole reason the measurement had to move.
    it('the resume line says what is actually true when there is no child to excuse', async () => {
      let clock = CLOCK;
      const h = makeStandingDown({
        sidecar: '23475', answers: false, spinePid: 11924,
        extra: { now: () => clock, aliveGraceMs: 90_000, aliveStaleMs: 150_000, livenessIntervalMs: 30_000 },
      });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      await h.tick(1);
      clock += 3_600_000;
      await h.tick(1);

      const said = h.logs.join('');
      expect(said).toContain('the machine slept');
      expect(said).toContain('no spine of its own');            // …not "giving the spine 90s to beat again"
      expect(said).not.toContain('giving the spine 90s to beat again');
    });

    // LOCK: a genuinely departed peer is still claimed, on the same three misses as before.
    it('both signals gone claims after three misses, exactly as before', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: true, spinePid: 11924 });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      await h.tick(3);
      expect(h.children).toHaveLength(1);                // held by both — nothing happens

      h.state.answers = false;
      h.state.spinePid = null;                           // the session ended and took the spine
      await h.tick(2);
      expect(h.children).toHaveLength(1);                // two misses still prove nothing
      await h.tick(1);
      expect(h.children).toHaveLength(2);                // the third claims
    });

    // LOCK: one live observation still yields instantly, and now the PID is enough to be that
    // observation — a peer whose port never comes back but whose pid reappears resets the streak.
    it('a live pid mid-streak yields instantly, exactly as a live port does', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: false, spinePid: null });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      await h.tick(2);                                   // two misses
      h.state.spinePid = 11924;                          // the successor's pid write lands
      await h.tick(1);                                   // one live observation
      h.state.spinePid = null;
      await h.tick(2);                                   // two fresh misses — short of three
      expect(h.children).toHaveLength(1);
      await h.tick(1);
      expect(h.children).toHaveLength(2);
    });

    // LOCK: pid reuse. liveDaemonPid pairs the pid with the beat for exactly this reason, and
    // the watch must inherit that — a pid file left behind by a spine that died an hour ago
    // names a number the OS has since handed to something else.
    it('a stale spine.pid with a stale beat is dead, and the profile is claimed', async () => {
      const h = makeStandingDown({ sidecar: '23475', answers: false, spinePid: 11924, beatAgeMs: 200_000 });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);

      await h.tick(3);
      expect(h.children).toHaveLength(2);
    });
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
    // The line reports BOTH observations rather than asserting a story about one of them: the
    // old text ("went quiet — the peer released the profile") was the very inference that put
    // two spines on one profile.
    expect(h.logs.join('')).toContain('names no live spine and 127.0.0.1:23375 is quiet');

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

    // The fallback must be the number the SPINE binds when it configures nothing
    // (shell-port.mjs's SHELL_WS_PORT), or the supervisor watches a port nothing serves.
    it('falls back to 23475 when neither the exit nor the config names one', async () => {
      const h = makeStandingDown({ sidecar: null });
      h.runtime.spawnShell();
      await h.children[0].child.handlers.exit(STANDDOWN_EXIT_CODE, null);
      expect(h.probedPorts).toEqual([23475]);
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
      expect(h.probedPorts).toEqual([23475]);
      expect(h.logs.join('')).toContain('9500');
    });

    it('that watch respawns on the same terms as a stand-down: only once NOTHING holds the profile', async () => {
      const answers = { up: true };
      const files = { 'state/spine.pid': '9500\n' };
      const h = makeSessioned({ files, extra: { peerProbe: () => async () => answers.up } });
      h.runtime.start();
      // start() arms the watch first and the liveness sweep after it; the watch is the one on
      // peer-liveness's 5s cadence.
      const watch = h.intervals.find((i) => i.ms === 5_000);
      const tick = async (n) => { for (let k = 0; k < n; k += 1) await watch.fn(); };

      await tick(5);
      expect(h.children).toHaveLength(0);                    // it answers: never displaced

      // The port going quiet is NO LONGER ENOUGH — pid 9500 is still on the profile, and that
      // is the incident this watch was rebuilt around (reve, 2026-09-11).
      answers.up = false;
      await tick(5);
      expect(h.children).toHaveLength(0);

      delete files['state/spine.pid'];                       // the session ended, the spine with it
      await tick(2);
      expect(h.children).toHaveLength(0);                    // two misses prove nothing
      await tick(1);
      expect(h.children).toHaveLength(1);                    // the third claims
    });

    // …and the port has no veto here either. Same watch, same rule: a daemon that arrives into
    // a profile nobody holds must come up even if some other program owns the console number.
    it('a squatted console port does not keep an arriving daemon down when no spine holds the profile', async () => {
      const files = { 'state/spine.pid': '9500\n' };
      // The port answers for the WHOLE run — a squatter took the console number and is never
      // going to let go of it.
      const h = makeSessioned({ files, extra: { peerProbe: () => async () => true } });
      h.runtime.start();
      const watch = h.intervals.find((i) => i.ms === 5_000);
      const tick = async (n) => { for (let k = 0; k < n; k += 1) await watch.fn(); };
      expect(h.children).toHaveLength(0);                    // pid 9500 holds it: stood down

      delete files['state/spine.pid'];                       // the incumbent is gone; only the squatter is left
      await tick(2);
      expect(h.children).toHaveLength(0);
      await tick(1);
      expect(h.children).toHaveLength(1);                    // the third miss claims anyway
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

// =====================================================================================
// EACH SUPERVISED PROFILE GETS ITS OWN LOG AGAIN.
// =====================================================================================
// `stdio: 'inherit'` hands the child the SERVICE's handles, which is exactly right for one
// node — NSSM captures them, rotates them at 10 MB, and the file is that node's log. With two
// profiles in one process it stops being true: both children inherit the same two handles, so
// kg2's lines land in ~/.egpt/config/logs/service-stderr.log under kg's name and
// ~/.egpt-secondary's log goes dead. MEASURED on reve 2026-09-11 after the merge: two
// `connection 'primary'` lines on two different ports in one file, and the secondary's file
// frozen at 16:23. A file carrying another node's lines under this node's name is the same
// diagnostic hole 298750d closed with timestamps, reopened from the other side.
//
// So: only in the multi-profile case, the daemon opens <EGPT_HOME>/config/logs/service-
// {stdout,stderr}.log itself and hands THOSE to the child. One node keeps 'inherit' and NSSM,
// byte for byte.
describe('daemon runtime: per-profile child logs', () => {
  const CLOCK = Date.UTC(2026, 5, 18, 12, 0, 0);
  const MB = 1024 * 1024;

  function makeLogged({ perProfileLogs = true, logTag = null, sizes = {}, extra = {} } = {}) {
    const opened = [];
    const closed = [];
    const renamed = [];
    let nextFd = 100;
    const h = makeRuntime({
      now: () => CLOCK,
      perProfileLogs,
      logTag,
      statSync: (p) => {
        const path = String(p).replace(/\\/g, '/');
        for (const [suffix, size] of Object.entries(sizes)) if (path.endsWith(suffix)) return { size, mtimeMs: CLOCK - 10_000 };
        if (path.endsWith('.log')) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
        return { mtimeMs: CLOCK - 10_000 };
      },
      openSync: (p, flags) => { opened.push({ path: String(p).replace(/\\/g, '/'), flags }); return nextFd++; },
      closeSync: (fd) => closed.push(fd),
      renameSync: (from, to) => renamed.push({ from: String(from).replace(/\\/g, '/'), to: String(to).replace(/\\/g, '/') }),
      mkdirSync: () => {},
      liveDaemonPid: () => null,
      setInterval: () => 1,
      setTimeout: () => 1,
      ...extra,
    });
    return { ...h, opened, closed, renamed };
  }

  // THE LOCK. One profile must be untouched: the child keeps the service's own handles, NSSM
  // keeps capturing and rotating them, and the daemon opens nothing at all.
  it('a single-profile node still inherits the service handles and opens no file of its own', () => {
    const h = makeLogged({ perProfileLogs: false });
    h.runtime.spawnShell();
    expect(h.children[0].opts.stdio).toBe('inherit');
    expect(h.opened).toEqual([]);
    expect(h.closed).toEqual([]);
  });

  it("hands the child THIS profile's own two files, opened for append", () => {
    const h = makeLogged();
    h.runtime.spawnShell();
    expect(h.opened.map((o) => o.path)).toEqual([
      'C:/home/.egpt/config/logs/service-stdout.log',
      'C:/home/.egpt/config/logs/service-stderr.log',
    ]);
    expect(h.opened.every((o) => o.flags === 'a')).toBe(true);
    // stdin is dropped: a supervised spine never reads a console, and inheriting fd 0 from a
    // service is how you get a child blocked on a handle nobody owns.
    expect(h.children[0].opts.stdio).toEqual(['ignore', 100, 101]);
  });

  it('does not accumulate a handle per respawn — the previous pair is closed before the next open', async () => {
    const h = makeLogged();
    h.runtime.spawnShell();
    await h.children[0].child.handlers.exit(RESTART_EXIT_CODE, null);
    expect(h.children).toHaveLength(2);

    expect(h.opened).toHaveLength(4);              // two spawns, two files each
    expect(h.closed).toEqual([100, 101]);          // …and exactly the first pair closed
    expect(h.children[1].opts.stdio).toEqual(['ignore', 102, 103]);
  });

  it('closes them on shutdown', () => {
    const h = makeLogged();
    h.runtime.spawnShell();
    h.runtime.shutdown('SIGTERM');
    expect(h.closed).toEqual([100, 101]);
  });

  // NSSM rotated what it captured; a file the daemon opens itself is rotated by nothing. So
  // the daemon does it, at the one moment it safely can — while no child holds the handle —
  // and to NSSM's own naming, so the rotated files sit in the same directory looking the same.
  describe('rotation', () => {
    it('rolls a file past the cap before opening it, using NSSM\u2019s naming', () => {
      const h = makeLogged({ sizes: { 'config/logs/service-stderr.log': 11 * MB } });
      h.runtime.spawnShell();
      expect(h.renamed).toHaveLength(1);
      expect(h.renamed[0].from).toBe('C:/home/.egpt/config/logs/service-stderr.log');
      expect(h.renamed[0].to).toMatch(/config\/logs\/service-stderr-\d{8}T\d{6}\.\d{3}\.log$/);
      expect(h.logs.join('')).toContain('rolled');
    });

    it('leaves a file under the cap alone', () => {
      const h = makeLogged({ sizes: { 'config/logs/service-stderr.log': 3 * MB } });
      h.runtime.spawnShell();
      expect(h.renamed).toEqual([]);
    });

    it('says so ONCE when the live file passes the cap between respawns — nothing rotates it until then', () => {
      const h = makeLogged({
        sizes: { 'config/logs/service-stdout.log': 40 * MB },
        extra: { aliveGraceMs: 0 },
      });
      // alive.txt fresh so the wedge check does not fire; the log file is oversize.
      h.runtime.spawnShell();
      h.runtime.checkLiveness();
      h.runtime.checkLiveness();
      const said = h.logs.join('').split('nothing rotates it').length - 1;
      expect(said).toBe(1);
    });
  });

  // THE COLLISION. Under the merged service NSSM captures the DAEMON's stdout into the primary
  // profile's service-stdout.log. If the daemon then opened that same file for the primary's
  // spine there would be two appenders on one file, and NSSM's rotation would rename it out
  // from under our handle — every later line silently going to a file nobody tails.
  it('refuses to open a second handle on the file the service is already capturing into, and says why', () => {
    const h = makeLogged({
      extra: {
        statSync: (p) => (String(p).endsWith('.log') ? { size: 10, ino: 4242, dev: 7 } : { mtimeMs: CLOCK - 10_000 }),
        fstatSync: () => ({ ino: 4242, dev: 7 }),
      },
    });
    h.runtime.spawnShell();
    expect(h.opened).toEqual([]);
    expect(h.children[0].opts.stdio).toBe('inherit');
    expect(h.logs.join('')).toContain('already capturing');
  });

  it('falls back to the service handles — loudly — when its own log cannot be opened', () => {
    const h = makeLogged({ extra: { openSync: () => { throw new Error('EACCES'); } } });
    h.runtime.spawnShell();
    expect(h.children[0].opts.stdio).toBe('inherit');
    expect(h.logs.join('')).toContain('EACCES');
    expect(h.logs.join('')).toContain('mixed in with the other profiles');
  });

  // The supervisor's own narrative stays in ONE place (it is about the supervisor), so every
  // line of it has to name the profile it is about.
  describe('the daemon\u2019s own lines', () => {
    it('carry the profile tag when this daemon shares a process with others', () => {
      const h = makeLogged({ logTag: 'egpt-secondary' });
      h.runtime.spawnShell();
      expect(h.logs.join('')).toContain('] [egpt-secondary] starting node egpt-spine.mjs');
    });

    it('are byte-for-byte unchanged when it does not', () => {
      const h = makeLogged({ perProfileLogs: false });
      h.runtime.spawnShell();
      // exactly one bracket group, the timestamp one — no tag wedged in after it
      expect(h.logs.join('')).toMatch(/\[egpt-daemon [^\]]+\] starting node egpt-spine\.mjs/);
    });
  });
});

describe('startProfileDaemons: a line from each profile lands in that profile\u2019s own file', () => {
  it('opens each profile\u2019s own two files and gives each child only its own', () => {
    const opened = [];
    const spawned = [];
    let nextFd = 200;
    startProfileDaemons({
      profiles: ['C:/a', 'C:/b'],
      root: 'C:/repo',
      processObj: { env: {}, pid: 7, on: () => {}, exit: () => {} },
      stdout: { write: () => {} },
      now: () => 0,
      spawn: (cmd, args, opts) => { spawned.push(opts); return { on: () => {} }; },
      spawnSync: () => ({ status: 0, stdout: Buffer.from('') }),
      readFileSync: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      statSync: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      openSync: (p) => { opened.push(String(p).replace(/\\/g, '/')); return nextFd++; },
      closeSync: () => {},
      mkdirSync: () => {},
      writeFileSync: () => {},
      liveDaemonPid: () => null,
      setInterval: () => 1,
      setTimeout: () => 1,
      livenessIntervalMs: 0,
    });

    expect(opened).toEqual([
      'C:/a/config/logs/service-stdout.log',
      'C:/a/config/logs/service-stderr.log',
      'C:/b/config/logs/service-stdout.log',
      'C:/b/config/logs/service-stderr.log',
    ]);
    // …and no child was handed a handle belonging to the other profile.
    expect(spawned.map((o) => o.stdio)).toEqual([['ignore', 200, 201], ['ignore', 202, 203]]);
  });

  it('one profile alone keeps inherit — the merge is the only thing that changes', () => {
    const opened = [];
    const spawned = [];
    startProfileDaemons({
      profiles: ['C:/a'],
      root: 'C:/repo',
      processObj: { env: {}, pid: 7, on: () => {}, exit: () => {} },
      stdout: { write: () => {} },
      now: () => 0,
      spawn: (cmd, args, opts) => { spawned.push(opts); return { on: () => {} }; },
      spawnSync: () => ({ status: 0, stdout: Buffer.from('') }),
      readFileSync: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      statSync: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      openSync: (p) => { opened.push(String(p)); return 1; },
      closeSync: () => {},
      mkdirSync: () => {},
      writeFileSync: () => {},
      liveDaemonPid: () => null,
      setInterval: () => 1,
      setTimeout: () => 1,
      livenessIntervalMs: 0,
    });
    expect(opened).toEqual([]);
    expect(spawned[0].stdio).toBe('inherit');
  });
});
