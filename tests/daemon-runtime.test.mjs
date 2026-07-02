import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  CLEAN_EXIT_CODE,
  RESTART_EXIT_CODE,
  RESTART_MIN_MS,
  RESTART_MAX_MS,
  UPGRADE_EXIT_CODE,
  createDaemonRuntime,
} from '../src/daemon-runtime.mjs';

class FakeChild {
  constructor() {
    this.handlers = {};
    this.killed = [];
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

  it('spawns the v2 entry (node egpt.mjs) from the fixed root — no role flags, stdio inherit', () => {
    const root = 'C:/repo/egpt';
    const { runtime, children } = makeRuntime({ argv: [] });

    runtime.start();

    expect(children).toHaveLength(1);
    expect(children[0].cmd).toBe('node');
    expect(children[0].args).toEqual([join(root, 'egpt.mjs')]);   // no --headless, no flags
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
});
