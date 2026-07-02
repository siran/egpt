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

  // PER-RUN IDLE OVERRIDE (operator 2026-07-02): a per-conversation config.yaml can
  // set its own warm idle TTL; brainpool passes it as run()'s `idleTtlMs`. It beats
  // the class TTL for that entry; 0 = never evict; omitted = class TTL; a later run
  // with a different value re-stamps the entry (takes effect next turn).
  it('per-run idleTtlMs overrides the class TTL (arms with the override, not the class)', async () => {
    const { makeSession, made } = fakeFactory();
    const pool = createWarmPool({ makeSession, idleTtlByClass: { conversation: 0 } });   // class = never
    await pool.run('k', 'a', () => {}, { klass: 'conversation', idleTtlMs: 20 });          // override = 20ms
    expect(pool.has('k')).toBe(true);
    await sleep(60);
    expect(pool.has('k')).toBe(false);          // evicted by the override despite class 0
    expect(made[0].closed).toBe(true);
  });

  it('idleTtlMs: 0 never arms the idle timer (keep-always-warm override)', async () => {
    const { makeSession } = fakeFactory();
    const pool = createWarmPool({ makeSession, idleTtlByClass: { conversation: 20 } });   // class would evict
    await pool.run('k', 'a', () => {}, { klass: 'conversation', idleTtlMs: 0 });           // override = never
    await sleep(60);
    expect(pool.has('k')).toBe(true);
  });

  it('omitted idleTtlMs falls back to the class TTL', async () => {
    const { makeSession } = fakeFactory();
    const pool = createWarmPool({ makeSession, idleTtlByClass: { conversation: 20 } });
    await pool.run('k', 'a', () => {}, { klass: 'conversation' });   // no override
    await sleep(60);
    expect(pool.has('k')).toBe(false);          // class TTL applied
  });

  it('a later run with a different override updates the entry (next turn re-stamps)', async () => {
    const { makeSession } = fakeFactory();
    const pool = createWarmPool({ makeSession, idleTtlByClass: { conversation: 0 } });
    await pool.run('k', 'a', () => {}, { klass: 'conversation', idleTtlMs: 0 });   // keep warm
    await sleep(30);
    expect(pool.has('k')).toBe(true);
    await pool.run('k', 'b', () => {}, { klass: 'conversation', idleTtlMs: 20 });   // now short TTL
    await sleep(60);
    expect(pool.has('k')).toBe(false);          // the changed override evicted it
  });

  it('a later run that OMITS idleTtlMs keeps the stamped override (compactor path)', async () => {
    const { makeSession } = fakeFactory();
    const pool = createWarmPool({ makeSession, idleTtlByClass: { conversation: 20 } });
    await pool.run('k', 'a', () => {}, { klass: 'conversation', idleTtlMs: 0 });   // stamp keep-warm
    await pool.run('k', 'b', () => {}, { klass: 'conversation' });                  // omit → keep the stamp
    await sleep(60);
    expect(pool.has('k')).toBe(true);           // still warm; the omit did NOT revert to class TTL
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

  // CONTRACT (operator 2026-06-21): the conversation/E warm key omits the
  // session id, so a re-pin on the same key (e.g. `/e new` nulling the thread,
  // or the compactor reseeding to a new session) must EVICT the stale open
  // session instead of silently resuming it (the SPOILER bug). A session that
  // reports a `sessionId` is compared against what the caller now requests.
  function sessionIdFactory() {
    const made = [];
    const makeSession = (opts) => {
      const s = {
        opts, closed: false, turns: [],
        get sessionId() { return opts.sessionId ?? null; },
        close() { this.closed = true; },
        turn(msg) { this.turns.push(msg); return Promise.resolve({ text: `echo:${msg}`, sessionId: this.sessionId }); },
      };
      made.push(s);
      return s;
    };
    return { makeSession, made };
  }

  it('evicts + reopens when the same key is re-pinned to a DIFFERENT session', async () => {
    const { makeSession, made } = sessionIdFactory();
    const pool = createWarmPool({ makeSession });
    await pool.run('e:ccode:wa:slug', 'a', () => {}, { brainOptions: { sessionId: 'OLD12345' } });
    await pool.run('e:ccode:wa:slug', 'b', () => {}, { brainOptions: { sessionId: 'NEW67890' } });
    expect(made.length).toBe(2);                 // stale session not reused
    expect(made[0].closed).toBe(true);           // old one evicted/closed
    expect(made[0].opts.sessionId).toBe('OLD12345');
    expect(made[1].opts.sessionId).toBe('NEW67890');
  });

  it('evicts + reopens FRESH when the thread is reset to null (/e new)', async () => {
    const { makeSession, made } = sessionIdFactory();
    const pool = createWarmPool({ makeSession });
    await pool.run('e:ccode:wa:slug', 'a', () => {}, { brainOptions: { sessionId: 'OLD12345' } });
    await pool.run('e:ccode:wa:slug', 'b', () => {}, { brainOptions: { sessionId: null } });
    expect(made.length).toBe(2);
    expect(made[0].closed).toBe(true);
    expect(made[1].opts.sessionId).toBe(null);   // brand-new session
  });

  it('reuses the warm session when the SAME session id is requested', async () => {
    const { makeSession, made } = sessionIdFactory();
    const pool = createWarmPool({ makeSession });
    await pool.run('k', 'a', () => {}, { brainOptions: { sessionId: 'SAME0001' } });
    await pool.run('k', 'b', () => {}, { brainOptions: { sessionId: 'SAME0001' } });
    expect(made.length).toBe(1);                  // no churn on steady state
    expect(made[0].turns).toEqual(['a', 'b']);
  });

  it('does NOT guard callers that omit sessionId (no churn)', async () => {
    const { makeSession, made } = sessionIdFactory();
    const pool = createWarmPool({ makeSession });
    await pool.run('k', 'a');                     // no brainOptions.sessionId at all
    await pool.run('k', 'b');
    expect(made.length).toBe(1);
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
