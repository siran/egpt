import { describe, it, expect } from 'vitest';
import { createWarmPool } from '../src/warm-sessions.mjs';

// Fake warm session: records turns, can hang, tracks close().
function fakeFactory() {
  const made = [];
  const makeSession = (opts) => {
    const s = {
      opts, closed: false, turns: [], hang: false, fail: false,
      close() { this.closed = true; },
      turn(msg) {
        this.turns.push(msg);
        if (this.fail) return Promise.reject(new Error('session boom'));
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

  // CONTRACT (operator 2026-06-12): a warm claude session can stay open
  // INDEFINITELY (like the CLI). There is NO turn timeout — a long/thinking turn
  // is never guillotined, and warmth is never evicted for being slow.
  it('does NOT time out a long/hung turn — no fake guillotine, warmth survives', async () => {
    const factory = fakeFactory();
    const pool = createWarmPool({
      dispatchTimeoutMs: 20,   // the OLD pool would have killed + evicted at 20ms
      makeSession: (o) => { const s = factory.makeSession(o); s.hang = true; return s; },
    });
    const turn = pool.run('k', 'a');
    const state = await Promise.race([
      turn.then(() => 'settled', () => 'rejected'),
      sleep(60).then(() => 'pending'),
    ]);
    expect(state).toBe('pending');        // no timeout rejection ever fires
    expect(pool.has('k')).toBe(true);     // session stays WARM — not evicted
  });

  // CONTRACT (operator 2026-06-13): a message that arrives while a turn is
  // already streaming on a key is INJECTED into that running turn (woven in
  // mid-flight), NOT queued as a fresh turn behind it. The in-flight turn's
  // single result carries the combined reply; the injected call resolves with
  // an `injected` marker so the caller emits nothing separately.
  function injectableFactory() {
    const made = [];
    const makeSession = (opts) => {
      const s = {
        opts, closed: false, turns: [], injected: [], _resolve: null,
        close() { this.closed = true; },
        turn(msg) {
          this.turns.push(msg);
          return new Promise((resolve) => { this._resolve = resolve; });   // stays in flight
        },
        inject(msg) { if (!this._resolve) return false; this.injected.push(msg); return true; },
        finish(v) { const r = this._resolve; this._resolve = null; r(v); },
      };
      made.push(s);
      return s;
    };
    return { makeSession, made };
  }

  it('injects a mid-turn message into the running turn (no second turn)', async () => {
    const { makeSession, made } = injectableFactory();
    const pool = createWarmPool({ makeSession });
    const p1 = pool.run('k', 'first');
    await sleep(2);                                  // let _doTurn start → e.busy
    const r2 = await pool.run('k', 'second');        // arrives mid-turn
    expect(r2.injected).toBe(true);                  // woven in, not queued
    expect(made[0].injected).toEqual(['second']);
    expect(made[0].turns).toEqual(['first']);        // NOT a second turn
    made[0].finish({ text: 'first+second', sessionId: 'sid' });
    expect((await p1).text).toBe('first+second');    // one combined reply
    expect(made.length).toBe(1);
  });

  it('does NOT inject when the key is idle — runs a normal turn', async () => {
    const { makeSession, made } = injectableFactory();
    const pool = createWarmPool({ makeSession });
    const p1 = pool.run('k', 'first');
    await sleep(2);
    made[0].finish({ text: 'a', sessionId: 'sid' });
    await p1;                                         // turn ended → key idle
    const p2 = pool.run('k', 'second');
    await sleep(2);
    expect(made[0].turns).toEqual(['first', 'second']);   // a real second turn
    expect(made[0].injected).toEqual([]);
    made[0].finish({ text: 'b', sessionId: 'sid' });
    expect((await p2).text).toBe('b');
  });

  it('injectWhileBusy:false preserves serialize-behind behavior', async () => {
    const { makeSession, made } = injectableFactory();
    const pool = createWarmPool({ makeSession, injectWhileBusy: false });
    const p1 = pool.run('k', 'first');
    await sleep(2);
    const p2 = pool.run('k', 'second');              // queues behind, not injected
    expect(made[0].injected).toEqual([]);
    made[0].finish({ text: 'a', sessionId: 'sid' });
    await sleep(2);
    made[0].finish({ text: 'b', sessionId: 'sid' }); // second turn now runs
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.text).toBe('a');
    expect(r2.text).toBe('b');
    expect(made[0].turns).toEqual(['first', 'second']);
  });

  it('reopens a fresh session after a genuine session error (not a timeout)', async () => {
    const factory = fakeFactory();
    let first = true;
    const pool = createWarmPool({
      makeSession: (o) => { const s = factory.makeSession(o); if (first) { s.fail = true; first = false; } return s; },
    });
    await expect(pool.run('k', 'a')).rejects.toThrow(/boom/);   // real error → evict
    const r = await pool.run('k', 'b');                         // reopens a fresh one
    expect(r.text).toBe('echo:b');
    expect(factory.made.length).toBe(2);
  });
});
