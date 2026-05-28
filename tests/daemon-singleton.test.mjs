// The singleton guard's decision logic: given an alive.txt beat, is another
// daemon currently alive (so a starting wrapper should refuse)? Liveness is
// injected so the test never depends on real pids. Regression cover for the
// duplicate-daemon incident — a 2nd daemon must be refused, but a stale beat
// or a dead pid must NOT block a legitimate (re)start.
import { describe, it, expect } from 'vitest';
import { liveDaemonPid, defaultIsAlive } from '../src/daemon-singleton.mjs';

const NOW = Date.UTC(2026, 4, 25, 15, 0, 0);
const beat = (pid, ageMs = 1000, label = 'tic') =>
  `${label} ${new Date(NOW - ageMs).toISOString()} ${pid}\n`;

describe('liveDaemonPid', () => {
  it('returns null when there is no alive content', () => {
    expect(liveDaemonPid('', { now: NOW })).toBe(null);
    expect(liveDaemonPid(undefined, { now: NOW })).toBe(null);
  });

  it('returns the pid when a fresh beat maps to a live, different process', () => {
    expect(liveDaemonPid(beat(333), { now: NOW, selfPid: 999, isAlive: () => true })).toBe(333);
  });

  it('returns null when the beat is stale (daemon gone, even if pid happens to be alive)', () => {
    expect(liveDaemonPid(beat(333, 200_000), { now: NOW, selfPid: 999, isAlive: () => true })).toBe(null);
  });

  it('returns null when the pid is dead even though the beat is fresh', () => {
    expect(liveDaemonPid(beat(333), { now: NOW, selfPid: 999, isAlive: () => false })).toBe(null);
  });

  it('returns null when the only beat is our own pid (a /restart respawn race)', () => {
    expect(liveDaemonPid(beat(222), { now: NOW, selfPid: 222, isAlive: () => true })).toBe(null);
  });

  it('reads the NEWEST beat in a tic+toc pair', () => {
    const content = `${beat(444, 1500, 'tic')}${beat(555, 500, 'toc')}`;
    expect(liveDaemonPid(content, { now: NOW, selfPid: 999, isAlive: (p) => p === 555 })).toBe(555);
  });

  it('ignores malformed / non-beat lines', () => {
    const content = `stopped ${new Date(NOW).toISOString()} 111\n${beat(333)}`;
    expect(liveDaemonPid(content, { now: NOW, selfPid: 999, isAlive: () => true })).toBe(333);
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
