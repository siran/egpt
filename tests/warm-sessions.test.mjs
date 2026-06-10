import { describe, it, expect } from 'vitest';
import { createWarmPool } from '../src/warm-sessions.mjs';

// Fake warm session: records turns, can hang, tracks close().
function fakeFactory() {
  const made = [];
  const makeSession = (opts) => {
    const s = {
      opts, closed: false, turns: [], hang: false,
      close() { this.closed = true; },
      turn(msg) {
        this.turns.push(msg);
        if (this.hang) return new Promise(() => {});   // never resolves
        return Promise.resolve({ text: `echo:${msg}`, sessionId: 'sid' });
      },
    };
    made.push(s);
    return s;
  };
  return { makeSession, made };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('warm-session pool', () => {
  it('reuses a warm session across turns (no respawn) and keeps context handle', async () => {
    const { makeSession, made } = fakeFactory();
    const pool = createWarmPool({ makeSession });
    const r1 = await pool.run('k', 'a');
    const r2 = await pool.run('k', 'b');
    expect(r1.text).toBe('echo:a');
    expect(r2.text).toBe('echo:b');
    expect(made.length).toBe(1);              // one session, reused
    expect(made[0].turns).toEqual(['a', 'b']);
  });

  it('opens distinct sessions per key', async () => {
    const { makeSession, made } = fakeFactory();
    const pool = createWarmPool({ makeSession });
    await pool.run('k1', 'x');
    await pool.run('k2', 'y');
    expect(made.length).toBe(2);
    expect(pool.stats().size).toBe(2);
  });

  it('serializes turns on the same key (one at a time)', async () => {
    const { makeSession, made } = fakeFactory();
    const pool = createWarmPool({ makeSession });
    const [a, b] = await Promise.all([pool.run('k', '1'), pool.run('k', '2')]);
    expect(a.text).toBe('echo:1');
    expect(b.text).toBe('echo:2');
    expect(made.length).toBe(1);
    expect(made[0].turns).toEqual(['1', '2']);   // ordered, not interleaved
  });

  it('LRU-evicts beyond maxWarm', async () => {
    const { makeSession, made } = fakeFactory();
    const pool = createWarmPool({ makeSession, max: 2 });
    await pool.run('k1', 'a');
    await sleep(2);
    await pool.run('k2', 'b');
    await sleep(2);
    await pool.run('k3', 'c');                 // forces eviction of LRU (k1)
    expect(pool.stats().size).toBe(2);
    expect(pool.has('k1')).toBe(false);
    expect(made[0].closed).toBe(true);          // k1's session was closed
    expect(pool.has('k2')).toBe(true);
    expect(pool.has('k3')).toBe(true);
  });

  it('idle-evicts after the per-class TTL and closes the session', async () => {
    const { makeSession, made } = fakeFactory();
    const pool = createWarmPool({ makeSession, idleTtlByClass: { conversation: 20 } });
    await pool.run('k', 'a', () => {}, { klass: 'conversation' });
    expect(pool.has('k')).toBe(true);
    await sleep(60);
    expect(pool.has('k')).toBe(false);
    expect(made[0].closed).toBe(true);
  });

  it('never idle-evicts a class with ttl 0 (system persistent)', async () => {
    const { makeSession } = fakeFactory();
    const pool = createWarmPool({ makeSession, idleTtlByClass: { system: 0 } });
    await pool.run('self', 'a', () => {}, { klass: 'system' });
    await sleep(40);
    expect(pool.has('self')).toBe(true);
  });

  it('times out a hung turn, fails it, and evicts the session', async () => {
    const factory = fakeFactory();
    const pool = createWarmPool({
      dispatchTimeoutMs: 30,
      makeSession: (o) => { const s = factory.makeSession(o); s.hang = true; return s; },
    });
    await expect(pool.run('k', 'a')).rejects.toThrow(/timeout/);
    expect(pool.has('k')).toBe(false);                // evicted
    expect(factory.made[0].closed).toBe(true);        // closed on timeout
  });

  it('reopens a fresh session after a failure', async () => {
    const factory = fakeFactory();
    let first = true;
    const pool = createWarmPool({
      dispatchTimeoutMs: 30,
      makeSession: (o) => { const s = factory.makeSession(o); if (first) { s.hang = true; first = false; } return s; },
    });
    await expect(pool.run('k', 'a')).rejects.toThrow();   // first hangs → timeout → evict
    const r = await pool.run('k', 'b');                   // reopens a fresh (non-hanging) one
    expect(r.text).toBe('echo:b');
    expect(factory.made.length).toBe(2);
  });
});
