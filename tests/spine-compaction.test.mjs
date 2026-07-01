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
