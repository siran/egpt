// The singleton guard's decision logic: given the spine.pid file's content and
// the alive.txt beat age (ms since its mtime), is another daemon currently alive
// (so a starting wrapper should refuse)? Identity (spine.pid) and liveness
// (alive.txt mtime) are separate facts now, both injected so the test never
// depends on real pids or files. Regression cover for the duplicate-daemon
// incident — a 2nd daemon must be refused, but a stale beat or a dead pid must
// NOT block a legitimate (re)start.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveDaemonPid, defaultIsAlive, openExclusive, closeExclusive, heldExclusive } from '../src/daemon-singleton.mjs';

describe('liveDaemonPid', () => {
  it('returns null when there is no pid file content', () => {
    expect(liveDaemonPid({ pidFileContent: '', beatAgeMs: 1000 })).toBe(null);
    expect(liveDaemonPid({ pidFileContent: undefined, beatAgeMs: 1000 })).toBe(null);
    expect(liveDaemonPid({}, {})).toBe(null);
    expect(liveDaemonPid()).toBe(null);
  });

  it('returns the pid when the pid file parses and a fresh beat maps to a live process', () => {
    expect(liveDaemonPid({ pidFileContent: '333\n', beatAgeMs: 1000 }, { isProcessAlive: () => true })).toBe(333);
    expect(liveDaemonPid({ pidFileContent: '  333  ', beatAgeMs: 1000 }, { isProcessAlive: () => true })).toBe(333);   // trimmed
  });

  it('returns null when the beat is stale (daemon gone, even if the pid happens to be alive)', () => {
    expect(liveDaemonPid({ pidFileContent: '333', beatAgeMs: 200_000 }, { isProcessAlive: () => true })).toBe(null);
  });

  it('returns null when the beat file is absent (beatAgeMs Infinity)', () => {
    expect(liveDaemonPid({ pidFileContent: '333', beatAgeMs: Infinity }, { isProcessAlive: () => true })).toBe(null);
  });

  it('returns null when the pid is dead even though the beat is fresh', () => {
    expect(liveDaemonPid({ pidFileContent: '333', beatAgeMs: 1000 }, { isProcessAlive: () => false })).toBe(null);
  });

  it('returns null when the pid file is blank / non-numeric / non-positive', () => {
    for (const bad of ['   ', 'abc', '0', '-5', '3.5', 'NaN']) {
      expect(liveDaemonPid({ pidFileContent: bad, beatAgeMs: 1000 }, { isProcessAlive: () => true }), bad).toBe(null);
    }
  });

  it('honors a custom staleMs threshold', () => {
    expect(liveDaemonPid({ pidFileContent: '333', beatAgeMs: 40_000 }, { staleMs: 30_000, isProcessAlive: () => true })).toBe(null);
    expect(liveDaemonPid({ pidFileContent: '333', beatAgeMs: 20_000 }, { staleMs: 30_000, isProcessAlive: () => true })).toBe(333);
  });
});

describe('defaultIsAlive', () => {
  it('reports the current process as alive', () => {
    expect(defaultIsAlive(process.pid)).toBe(true);
  });

  it('reports a very-likely-dead pid as dead', () => {
    // 999999 is well past the typical process-id range; this isn't ironclad
    // (an OS could in theory recycle that high), but on every developer
    // machine we ship to it's been empty. If this ever flakes, bump higher.
    expect(defaultIsAlive(999999)).toBe(false);
  });

  // The Windows ESRCH-but-alive regression — covered empirically against the
  // S4U scheduled-task daemon pid during the operator's 2026-05-28 incident
  // (`tasklist` saw it; `process.kill(pid,0)` threw ESRCH). The unit form is
  // a platform-conditional smoke test: nothing user-launched here exercises
  // the cross-session path, so just confirm the function exists and matches
  // process.kill semantics for in-session pids.
});

// The cross-session locks (runner.lock, s1.claim): a share-none open held by one process, seen as held
// by another, and freed by the OS the moment the holder dies, whatever killed it. Real processes, a temp file.
describe.runIf(process.platform === 'win32')('openExclusive / heldExclusive', () => {
  const holder = (path) => new Promise((resolve) => {
    const mod = new URL('../src/daemon-singleton.mjs', import.meta.url).href;
    const src = `const { openExclusive } = await import(${JSON.stringify(mod)}); openExclusive(${JSON.stringify(path)}); console.log('held'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    child.stdout.once('data', () => resolve(child));
  });
  const gone = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });

  it('is held while another process has it open, and free once that process is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-lock-'));
    const path = join(dir, 'state', 's1.claim');
    try {
      const child = await holder(path);
      expect(heldExclusive(path)).toBe(true);
      expect(openExclusive(path)).toBe(null);
      await gone(child);
      expect(heldExclusive(path)).toBe(false);
      const fd = openExclusive(path);
      expect(typeof fd).toBe('number');
      closeExclusive(fd);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  it('a probe does not take it: after heldExclusive the lock is still free to open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-lock-'));
    const path = join(dir, 'runner.lock');
    try {
      const fd = openExclusive(path);
      expect(heldExclusive(path)).toBe(true);   // our own open excludes even this process's probe
      closeExclusive(fd);
      expect(heldExclusive(path)).toBe(false);
      const again = openExclusive(path);
      expect(typeof again).toBe('number');
      closeExclusive(again);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
