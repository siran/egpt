// Auto-compaction service: after a cooling period following the last bot turn in a
// conversation, /compact its warm session (native, in place) if it's over ratio.
// Manual scheduler + fake pool + injected dueFor — no timers, no session files.
import { describe, it, expect } from 'vitest';
import { createCompaction } from '../src/spine/compaction.mjs';

function makeScheduler() {
  const s = {
    fn: null, setCount: 0, clearCount: 0,
    set(fn) { s.setCount++; s.fn = fn; return { id: s.setCount }; },
    clear() { s.clearCount++; s.fn = null; },
    async fire() { const f = s.fn; s.fn = null; if (f) await f(); },
  };
  return s;
}
function fakePool() { const runs = []; return { runs, run(key, msg, _onP, opts) { runs.push({ key, msg, opts }); return Promise.resolve({ text: '' }); } }; }

const TARGET = { key: 'e:ccode:whatsapp:hfm-1', sessionId: 'sid-1', model: 'haiku', cwd: '/c', allowedTools: 'all' };

describe('compaction service', () => {
  it('debounces the cooling period, then sends native /compact through the warm pool when over ratio', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }) });
    c.afterTurn(TARGET);
    expect(sched.setCount).toBe(1);
    expect(pool.runs).toHaveLength(0);          // still cooling — nothing sent yet
    await sched.fire();
    expect(pool.runs).toHaveLength(1);
    expect(pool.runs[0].key).toBe(TARGET.key);  // SAME warm key → compacts in place
    expect(pool.runs[0].msg).toBe('/compact');
    expect(pool.runs[0].opts.brainOptions).toMatchObject({ sessionId: 'sid-1', cwd: '/c' });
  });

  it('does NOT compact when the session is under ratio', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: false, tokens: 1000, threshold: 40000 }) });
    c.afterTurn(TARGET);
    await sched.fire();
    expect(pool.runs).toHaveLength(0);
  });

  it('re-arms the cooling timer on each turn (a busy chat keeps deferring)', () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true }) });
    c.afterTurn(TARGET);
    c.afterTurn(TARGET);
    expect(sched.setCount).toBe(2);
    expect(sched.clearCount).toBe(1);           // the prior timer was reset
  });

  it('disabled → never arms, never compacts', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({ compaction: { enabled: false } }), scheduler: sched, dueFor: () => ({ due: true }) });
    c.afterTurn(TARGET);
    expect(sched.setCount).toBe(0);
    expect(pool.runs).toHaveLength(0);
  });
});

// ── ARMING THE IDENTITY FEED ON COMPACTION (operator 2026-09-10) ─────────────────────────────
// The ruling is that the identity feeds at START, REFRESH, RETHREAD and COMPACTION. The first
// three were built on 2026-09-10 (e4c299e); this is the fourth. A native /compact rewrites the
// session's context IN PLACE, so the kickoff feed can be summarised away and a being keeps its
// thread while losing who it is.
//
// WHO DOES WHAT: this service is the only place that knows a compact actually SUCCEEDED, so it
// arms; brainpool owns conversations.yaml, so it hands the arming gesture in on afterTurn as
// `armIdentityRefresh` (frozen onto the target beside ratio/window, for the same reason those
// are frozen). The gesture itself is `/agents refresh`'s — an explicit null identityInjectedAt —
// so there is no second feed path.
//
// ONLY ON SUCCESS. Arming after a compact that did not happen costs a re-feed for nothing and,
// worse, leaves the log saying one thing and the state another.
describe('compaction: arming the identity re-feed', () => {
  it('arms after a compact that actually ran', async () => {
    const pool = fakePool(), sched = makeScheduler();
    let armed = 0;
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }) });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async () => { armed++; } });
    await sched.fire();
    expect(pool.runs).toHaveLength(1);
    expect(armed).toBe(1);
  });

  it('does NOT arm when the session is under ratio — nothing was compacted', async () => {
    const pool = fakePool(), sched = makeScheduler();
    let armed = 0;
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: false, tokens: 1000, threshold: 40000 }) });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async () => { armed++; } });
    await sched.fire();
    expect(pool.runs).toHaveLength(0);
    expect(armed).toBe(0);
  });

  it('does NOT arm when the /compact itself THREW', async () => {
    const sched = makeScheduler();
    const logs = [];
    let armed = 0;
    const pool = { run: async () => { throw new Error('session is gone'); } };
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }), onLog: (m) => logs.push(m) });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async () => { armed++; } });
    await sched.fire();
    expect(armed).toBe(0);
    expect(logs.join('\n')).toMatch(/session is gone/);   // loud, never swallowed
  });

  it('an arming that fails is LOGGED as such — the compact still happened, and the log says both', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const logs = [];
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }), onLog: (m) => logs.push(m) });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async () => { throw new Error('state is locked'); } });
    await sched.fire();
    expect(pool.runs).toHaveLength(1);                                       // the compact DID run
    expect(logs.join('\n')).toMatch(/identity re-feed/i);
    expect(logs.join('\n')).toMatch(/state is locked/);
  });

  it('a target with NO armIdentityRefresh compacts exactly as before (nothing to arm)', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }) });
    c.afterTurn(TARGET);
    await expect(sched.fire()).resolves.toBeUndefined();
    expect(pool.runs).toHaveLength(1);
  });
});
