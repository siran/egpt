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
    // The cross-session locks and the ingest write are fakes unless a test brings its own: a real
    // lock would open a file under C:/home/.egpt on the developer's disk.
    mkdirSync: extra.mkdirSync ?? (() => {}),
    renameSync: extra.renameSync ?? (() => {}),
    lockFile: extra.lockFile ?? (() => 1),
    unlockFile: extra.unlockFile ?? (() => {}),
    lockHeld: extra.lockHeld ?? (() => false),
    createCliHost: 'createCliHost' in extra ? extra.createCliHost : null,
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

  // contract 14.2
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

  // contract 14.2
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
    // contract 14.2
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

// =====================================================================================
// ONE RUNNER ACROSS SESSIONS (operator 2026-10-22, GENOME 6 / CONTRACTS 14.4). The Session 0
// service is resident; the Session 1 daemon claims the profile at logon (state/s1.claim) and asks
// the S0 spine to stand down; whoever has a spine holds state/runner.lock. Fake locks, fake files.
// =====================================================================================
describe('one runner across sessions', () => {
  function world({ session1 = false, files = {}, claimedByS1 = false, runnerHeldByOther = false, beatAgeMs = 10_000, sessions = 2, extra = {} } = {}) {
    const processObj = makeProcess();
    processObj.pid = session1 ? 5001 : 5000;
    if (session1) processObj.env.EGPT_SESSION1 = '1';
    const locks = new Map();   // file name → 'me:<fd>' | 'other'
    if (claimedByS1) locks.set('s1.claim', 'other');
    if (runnerHeldByOther) locks.set('runner.lock', 'other');
    let fd = 10;
    const name = (p) => String(p).replace(/\\/g, '/').split('/').pop();
    const intervals = [], timers = [], written = [], renamed = [], ended = [];
    const h = makeRuntime({
      processObj,
      now: () => CLOCK,
      statSync: () => ({ mtimeMs: CLOCK - beatAgeMs }),
      readFileSync: (p) => {
        const path = String(p).replace(/\\/g, '/');
        for (const [suffix, body] of Object.entries(files)) if (path.endsWith(suffix)) return body;
        const e = new Error('missing'); e.code = 'ENOENT'; throw e;
      },
      writeFileSync: (p, body) => written.push({ path: String(p).replace(/\\/g, '/'), body: String(body) }),
      renameSync: (a, b) => renamed.push([String(a).replace(/\\/g, '/'), String(b).replace(/\\/g, '/')]),
      liveDaemonPid: fakeLive,
      lockFile: (p) => { if (locks.has(name(p))) return null; fd += 1; locks.set(name(p), `me:${fd}`); return fd; },
      unlockFile: (f) => { for (const [k, v] of locks) if (v === `me:${f}`) locks.delete(k); },
      lockHeld: (p) => locks.has(name(p)),
      setInterval: (fn, ms) => { const t = { fn, ms, ref() { t.refd = true; return t; }, unref() { t.unrefd = true; return t; } }; intervals.push(t); return t; },
      clearInterval: (t) => { if (t) t.cleared = true; },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      createCliHost: () => ({ attach: () => {}, endAll: (why) => { ended.push(why); sessions = 0; }, get size() { return sessions; } }),
      ...extra,
    });
    const hold = () => intervals.find((t) => t.ms === 3_000 && !t.cleared);
    const ingested = () => renamed.filter(([, to]) => /\/state\/ingest\/standdown-\d+$/.test(to));
    return { ...h, processObj, locks, files, intervals, timers, written, renamed, ended, hold, ingested };
  }

  describe('the Session 0 daemon', () => {
    it('with nothing else on the profile takes state/runner.lock and spawns', () => {
      const w = world();
      w.runtime.start();
      expect(w.children).toHaveLength(1);
      expect(w.locks.get('runner.lock')).toMatch(/^me:/);
      expect(w.hold()).toBeUndefined();
    });

    // contract 14.4
    it('arriving while Session 1 holds the profile spawns nothing, stays up on a REF\'d hold timer, and takes the profile back when Session 1 lets go', () => {
      const w = world({ claimedByS1: true, files: { 'state/spine.pid': '9500\n' } });
      expect(w.runtime.start()).toBeNull();
      expect(w.children).toHaveLength(0);
      expect(w.processObj.exits).toEqual([]);
      expect(w.locks.has('runner.lock')).toBe(false);
      const t = w.hold();
      expect(t.refd).toBe(true);           // the only thing keeping a childless service process alive
      expect(t.unrefd).toBeUndefined();
      expect(w.runtime.state.holding).toMatch(/Session 1/);
      expect(w.ingested()).toEqual([]);    // Session 0 never asks anybody to leave

      t.fn();                               // still held: nothing happens
      expect(w.children).toHaveLength(0);

      w.locks.delete('s1.claim');           // logoff: the OS drops the claim, the S1 spine dies
      delete w.files['state/spine.pid'];
      t.fn();
      expect(w.children).toHaveLength(1);
      expect(t.cleared).toBe(true);
      expect(w.runtime.state.holding).toBe(null);
      expect(w.locks.get('runner.lock')).toMatch(/^me:/);
    });

    it('a live spine with no claim (an orphan, an old Session 1 daemon) is waited out, never asked to leave', () => {
      const w = world({ files: { 'state/spine.pid': '9500\n' } });
      expect(w.runtime.start()).toBeNull();
      expect(w.processObj.exits).toEqual([]);
      expect(w.ingested()).toEqual([]);
      expect(w.runtime.state.holding).toMatch(/9500/);
      delete w.files['state/spine.pid'];
      w.hold().fn();
      expect(w.children).toHaveLength(1);
    });

    it('its spine leaving with 45 while Session 1 waits: every held session ends, runner.lock goes, no respawn until Session 1 lets go', async () => {
      const w = world();
      w.runtime.start();
      w.locks.set('s1.claim', 'other');
      await w.children[0].child.handlers.exit(45, null);
      expect(w.children).toHaveLength(1);
      expect(w.ended).toHaveLength(1);
      expect(w.locks.has('runner.lock')).toBe(false);
      expect(w.hold().refd).toBe(true);
      expect(w.timers).toEqual([]);                    // not the crash backoff
      expect(w.logs.join('')).not.toMatch(/crash/);

      w.locks.delete('s1.claim');
      w.hold().fn();
      expect(w.children).toHaveLength(2);
    });

    it('ends the held sessions once per hold, not on every tick while their processes exit', async () => {
      const ended = [];
      const w = world({ extra: { createCliHost: () => ({ attach: () => {}, endAll: (why) => ended.push(why), size: 2 }) } });
      w.runtime.start();
      w.locks.set('s1.claim', 'other');
      await w.children[0].child.handlers.exit(45, null);
      w.hold().fn();
      w.hold().fn();
      expect(ended).toHaveLength(1);
    });

    for (const [what, code] of [['a /restart (43)', RESTART_EXIT_CODE], ['an /upgrade (42)', UPGRADE_EXIT_CODE], ['a crash', 1]]) {
      it(`${what} never brings a spine back while Session 1 holds the claim`, async () => {
        const w = world({ extra: { setImmediate: (fn) => fn() } });
        w.runtime.start();
        w.locks.set('s1.claim', 'other');
        await w.children[0].child.handlers.exit(code, null);
        for (const t of w.timers) t.fn();
        expect(w.children).toHaveLength(1);
        expect(w.runtime.state.holding).toMatch(/Session 1/);
      });
    }

    it('a wedge-kill never brings a spine back while Session 1 holds the claim', async () => {
      const w = world({ beatAgeMs: 200_000, extra: { aliveGraceMs: 0, aliveStaleMs: 150_000, livenessIntervalMs: 30_000 } });
      w.runtime.start();
      w.locks.set('s1.claim', 'other');
      w.runtime.checkLiveness();
      expect(w.children[0].child.killed).toEqual(['SIGTERM']);
      await w.children[0].child.handlers.exit(1, 'SIGTERM');
      for (const t of w.timers) t.fn();
      expect(w.children).toHaveLength(1);
    });

    it('45 with nobody waiting is a respawn at once, not a crash', async () => {
      const w = world();
      w.runtime.start();
      await w.children[0].child.handlers.exit(45, null);
      expect(w.children).toHaveLength(2);
      expect(w.timers).toEqual([]);
      expect(w.ended).toEqual([]);
      expect(w.logs.join('')).not.toMatch(/crash/);
    });
  });

  describe('the Session 1 daemon', () => {
    // contract 14.4
    it('arriving while the S0 spine holds the profile: claims s1.claim, asks ONCE through state/ingest (temp, then rename), spawns only once the profile is free', () => {
      const w = world({ session1: true, files: { 'state/spine.pid': '9500\n' }, runnerHeldByOther: true, sessions: 0 });
      expect(w.runtime.start()).toBeNull();
      expect(w.children).toHaveLength(0);
      expect(w.processObj.exits).toEqual([]);
      expect(w.locks.get('s1.claim')).toMatch(/^me:/);
      const [ask] = w.written.filter((x) => x.path.includes('/state/ingest/'));
      expect(ask.path).toMatch(/\/state\/ingest\/standdown-\d+\.tmp$/);
      expect(ask.body).toBe('/standdown');
      expect(w.ingested()).toEqual([[ask.path, ask.path.replace(/\.tmp$/, '')]]);

      w.hold().fn();                                    // the S0 spine is still draining
      expect(w.children).toHaveLength(0);
      expect(w.ingested()).toHaveLength(1);             // asked once, not every tick

      delete w.files['state/spine.pid'];                // it left with 45 …
      w.hold().fn();
      expect(w.children).toHaveLength(0);               // … but its daemon still holds runner.lock
      w.locks.delete('runner.lock');                    // the S0 daemon holds off and lets go
      w.hold().fn();
      expect(w.children).toHaveLength(1);
      expect(w.locks.get('runner.lock')).toMatch(/^me:/);
      expect(w.hold()).toBeUndefined();
    });

    it('runner.lock held with no live spine (the S0 daemon between spawns): waits without asking anybody', () => {
      const w = world({ session1: true, runnerHeldByOther: true });
      expect(w.runtime.start()).toBeNull();
      expect(w.ingested()).toEqual([]);
      w.locks.delete('runner.lock');
      w.hold().fn();
      expect(w.children).toHaveLength(1);
    });

    it('a second Session 1 daemon finds s1.claim held: refused after a few short retries, exit 0, no spine', () => {
      const slept = [];
      const w = world({ session1: true, claimedByS1: true, extra: { sleepSync: (ms) => slept.push(ms) } });
      expect(w.runtime.start()).toBeNull();
      expect(w.children).toHaveLength(0);
      expect(w.processObj.exits).toEqual([0]);
      expect(w.logs.join('')).toMatch(/s1\.claim/);
      expect(slept.length).toBeGreaterThan(0);
      expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2_000);
    });

    // The S0 watcher and the PowerShell scripts probe s1.claim with a share-none open of their own;
    // one landing on the logon instant must not cost the node its Session 1 daemon.
    it('a probe holding s1.claim for an instant at logon is retried, not read as a second daemon', () => {
      let probes = 2;
      const w = world({
        session1: true,
        extra: { sleepSync: () => {}, lockFile: (p) => (String(p).endsWith('s1.claim') && probes-- > 0 ? null : 7) },
      });
      w.runtime.start();
      expect(w.processObj.exits).toEqual([]);
      expect(w.children).toHaveLength(1);
    });

    it('its own spine is not a holder: after a 43 it respawns while spine.pid still names that pid', async () => {
      const w = world({ session1: true, extra: { setImmediate: (fn) => fn() } });
      w.runtime.start();
      w.files['state/spine.pid'] = `${w.children[0].child.pid}\n`;
      await w.children[0].child.handlers.exit(RESTART_EXIT_CODE, null);
      expect(w.children).toHaveLength(2);
      expect(w.ingested()).toEqual([]);
    });

    it('while it waits it says who holds the profile, once a minute, with the orphan hint', () => {
      let at = CLOCK;
      const w = world({ session1: true, files: { 'state/spine.pid': '9500\n' }, extra: { now: () => at } });
      w.runtime.start();
      const before = w.logs.length;
      at += 30_000; w.hold().fn();
      expect(w.logs.length).toBe(before);
      at += 31_000; w.hold().fn();
      expect(w.logs.slice(before).join('')).toMatch(/still waiting.*9500.*taskkill \/PID 9500 \/T \/F/);
    });
  });

  it('shutdown lets go of both locks and stops the hold timer', () => {
    const w = world({ session1: true, runnerHeldByOther: true });
    w.runtime.start();
    const t = w.hold();
    w.runtime.shutdown('SIGTERM');
    expect(t.cleared).toBe(true);
    expect(w.locks.has('s1.claim')).toBe(false);
  });

  it('startProfileDaemons counts a runtime that holds off as supervising, not failed', () => {
    const logs = [];
    const result = startProfileDaemons({
      profiles: ['C:/a'],
      processObj: { env: {}, pid: 7, on: () => {}, exit: () => {} },
      stdout: { write: (m) => logs.push(m) },
      setPriority: () => {},
      createRuntime: () => ({ start: () => null, state: { holding: 'the Session 1 daemon holds state/s1.claim' } }),
    });
    expect(result.failed).toEqual([]);
    expect(logs.join('')).not.toMatch(/did not come up/);
  });
});

// =====================================================================================
// THE SINGLETON: one daemon per profile per session, and none beside a live spine.
// =====================================================================================
describe('daemon runtime: the singleton is session-scoped', () => {
  function makeSessioned({ session1 = false, files = {}, beatAgeMs = 10_000, extra = {} } = {}) {
    const processObj = makeProcess();
    processObj.pid = 4242;
    if (session1) processObj.env.EGPT_SESSION1 = '1';
    const written = [];
    const unlinked = [];
    const read = [];
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
      ...extra,
    });
    return { ...h, processObj, written, unlinked, read, intervals, timers };
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

  // No daemon spawns into a held profile (2026-10-17); since 2026-10-22 it waits instead of exiting
  // (the 'one runner across sessions' block below).
  describe('a live spine on the profile', () => {
    for (const session1 of [false, true]) {
      it(`the ${session1 ? 's1' : 's0'} daemon claims its session, spawns nothing and does not exit`, () => {
        const h = makeSessioned({ session1, files: { 'state/spine.pid': '9500\n' } });

        expect(h.runtime.start()).toBeNull();

        expect(h.children).toHaveLength(0);
        expect(h.processObj.exits).toEqual([]);
        expect(h.written.some((w) => w.path.endsWith(`daemon-s${session1 ? 1 : 0}.pid`))).toBe(true);
        expect(h.logs.join('')).toContain('9500');
      });
    }

    it('a dead spine (stale beat) does not block — it spawns as it always did', () => {
      const h = makeSessioned({ session1: true, files: { 'state/spine.pid': '9500\n' }, beatAgeMs: 200_000 });
      expect(h.runtime.start()).not.toBeNull();
      expect(h.children).toHaveLength(1);
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
      start() { r.started += 1; return script.start === undefined ? {} : script.start; },
      shutdown() {},
    };
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
      lockFile: () => 1, unlockFile: () => {}, lockHeld: () => false, createCliHost: null,
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
      lockFile: () => 1, unlockFile: () => {}, lockHeld: () => false, createCliHost: null,
      setInterval: () => 1,
      setTimeout: () => 1,
      livenessIntervalMs: 0,
    });
    expect(opened).toEqual([]);
    expect(spawned[0].stdio).toBe('inherit');
  });
});

// The Session-1 daemon HOLDS the group Chromes (src/chrome-host.mjs): its spine gets an IPC slot and the
// flag that tells it a host is on the other end; orphans are swept once, before the first spine.
describe('the S1 daemon holds the group Chromes', () => {
  const fakeHost = () => {
    const seen = [];
    const create = (o) => { seen.push(['create', o.profilesRoot]); return { sweepOrphans: () => seen.push(['sweep']), attach: (child) => seen.push(['attach', child]) }; };
    return { seen, create };
  };

  it('S1: sweeps orphans, then spawns the spine with an ipc slot + EGPT_CHROME_HOST and hands the host every child', () => {
    const h = fakeHost();
    const { runtime, children } = makeRuntime({ session1: true, createChromeHost: h.create });
    runtime.start();
    runtime.spawnShell();
    expect(children).toHaveLength(2);
    expect(children[0].opts.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
    expect(children[0].opts.env).toMatchObject({ EGPT_CHROME_HOST: '1' });
    expect(h.seen).toEqual([['create', join('C:/home/.egpt', 'chrome', 'profiles')], ['sweep'], ['attach', children[0].child], ['attach', children[1].child]]);
  });

  it('S1 with per-profile logs keeps its log fds and adds the ipc slot', () => {
    const h = fakeHost();
    let fd = 300;
    const { runtime, children } = makeRuntime({ session1: true, createChromeHost: h.create, perProfileLogs: true, openSync: () => fd++, fstatSync: () => ({ ino: 0, dev: 0 }), mkdirSync: () => {}, closeSync: () => {} });
    runtime.start();
    expect(children[0].opts.stdio).toEqual(['ignore', 300, 301, 'ipc']);
  });

  it('S0: no host, no ipc slot, no flag', () => {
    const h = fakeHost();
    const { runtime, children } = makeRuntime({ createChromeHost: h.create });
    runtime.start();
    expect(children[0].opts.stdio).toBe('inherit');
    expect(children[0].opts.env.EGPT_CHROME_HOST).toBeUndefined();
    expect(h.seen).toEqual([]);
  });
});

// …and every being's claude session (src/cli-host.mjs): the same IPC slot, its own flag, every spine
// attached. Only the exits whose next spine cannot adopt them end what it holds.
describe('the S1 daemon holds the claude sessions', () => {
  const fakeCliHost = () => {
    const seen = [];
    const create = () => ({ attach: (child) => seen.push(['attach', child]), endAll: (why) => seen.push(['endAll', why]) });
    return { seen, create };
  };

  it('S1: the spine gets the ipc slot + EGPT_CLI_HOST, and the host every child', () => {
    const h = fakeCliHost();
    const { runtime, children } = makeRuntime({ session1: true, createChromeHost: null, createCliHost: h.create });
    runtime.start();
    runtime.spawnShell();
    expect(children[0].opts.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
    expect(children[0].opts.env).toMatchObject({ EGPT_CLI_HOST: '1' });
    expect(children[0].opts.env.EGPT_CHROME_HOST).toBeUndefined();
    expect(h.seen).toEqual([['attach', children[0].child], ['attach', children[1].child]]);
  });

  // Operator 2026-10-22: a session needs no desktop, so the Session 0 daemon holds them too.
  it('S0 holds them too: the ipc slot + EGPT_CLI_HOST, no browser flag', () => {
    const h = fakeCliHost();
    const { runtime, children } = makeRuntime({ createCliHost: h.create });
    runtime.start();
    expect(children[0].opts.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
    expect(children[0].opts.env).toMatchObject({ EGPT_CLI_HOST: '1' });
    expect(children[0].opts.env.EGPT_CHROME_HOST).toBeUndefined();
    expect(h.seen).toEqual([['attach', children[0].child]]);
  });

  it('42, 43 and a crash (45 included) keep them for the next spine; 44 (/rewind) ends them', async () => {
    const ended = async (code) => {
      const h = fakeCliHost();
      const { runtime, children } = makeRuntime({ session1: true, createChromeHost: null, createCliHost: h.create, existsSync: () => false });
      runtime.start();
      await children[0].child.handlers.exit(code, null);
      return h.seen.filter(([what]) => what === 'endAll').length;
    };
    expect(await ended(UPGRADE_EXIT_CODE)).toBe(0);
    expect(await ended(RESTART_EXIT_CODE)).toBe(0);
    expect(await ended(1)).toBe(0);
    expect(await ended(REWIND_EXIT_CODE)).toBe(1);
    expect(await ended(45)).toBe(0);
  });
});
