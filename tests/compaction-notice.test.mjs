// The chat notice a compaction leaves behind (operator 2026-09-24: "i'll just let the conversations
// compact on its own. can the bridge emit notice of this when it happens?"). brainpool hands a
// closure out on afterTurn, bound to the turn's chat; the service freezes it onto the target and
// calls it once a /compact has SUCCEEDED, never otherwise, and a notice that fails is logged and is
// never a failed compact.
import { describe, it, expect } from 'vitest';
import { createCompaction, compactedNotice } from '../src/spine/compaction.mjs';

function makeScheduler() {
  const s = {
    fn: null,
    set(fn) { s.fn = fn; return { id: 1 }; },
    clear() { s.fn = null; },
    async fire() { const f = s.fn; s.fn = null; if (f) await f(); },
  };
  return s;
}

const TURN = { key: 'egpt:ccode:whatsapp:acim', sessionId: 'sid-1', model: 'opus', cwd: '/c', allowedTools: 'all' };

function arm({ due = true, tokens = 480_000, runFails = false, noticeFails = false } = {}) {
  const order = [], logs = [];
  const sched = makeScheduler();
  const pool = { run: async () => { order.push('compact'); if (runFails) throw new Error('warm session died'); return { text: '' }; } };
  const c = createCompaction({
    pool, scheduler: sched, getConfig: () => ({}), onLog: (m) => logs.push(m),
    dueFor: () => ({ due, tokens, threshold: 160_000 }),
  });
  c.afterTurn({
    ...TURN,
    armIdentityRefresh: async () => { order.push('arm'); },
    noticeCompacted: async (arg) => { order.push(['notice', arg]); if (noticeFails) throw new Error('bridge down'); },
  });
  return { sched, order, logs };
}

describe('compaction: the chat notice', () => {
  it('REPRODUCE: a compact that succeeded tells the chat, with the size it was compacted at', async () => {
    const a = arm();
    await a.sched.fire();
    expect(a.order).toContainEqual(['notice', { tokens: 480_000 }]);
  });

  it('comes AFTER the compact and after the identity is re-armed - it reports what already happened', async () => {
    const a = arm();
    await a.sched.fire();
    expect(a.order).toEqual(['compact', 'arm', ['notice', { tokens: 480_000 }]]);
  });

  it('says nothing when the session was not due', async () => {
    const a = arm({ due: false });
    await a.sched.fire();
    expect(a.order).toEqual([]);
  });

  it('says nothing when the compact itself failed - a notice never claims a compact that did not happen', async () => {
    const a = arm({ runFails: true });
    await a.sched.fire();
    expect(a.order).toEqual(['compact']);
    expect(a.logs.join('\n')).toMatch(/warm session died/);
  });

  it('a notice that fails is logged as a notice, never as a failed compact, and never throws', async () => {
    const a = arm({ noticeFails: true });
    await expect(a.sched.fire()).resolves.toBeUndefined();
    expect(a.order).toEqual(['compact', 'arm', ['notice', { tokens: 480_000 }]]);
    expect(a.logs.join('\n')).toMatch(/compacted, but the chat notice failed: bridge down/);
  });

  it('a turn that hands no notice compacts exactly as before', async () => {
    const order = [];
    const sched = makeScheduler();
    const c = createCompaction({ pool: { run: async () => { order.push('compact'); } }, scheduler: sched, getConfig: () => ({}), dueFor: () => ({ due: true, tokens: 1, threshold: 0 }) });
    c.afterTurn({ ...TURN });
    await sched.fire();
    expect(order).toEqual(['compact']);
  });
});

describe('compactedNotice: the line itself', () => {
  it('names the being and the size, and says where the history is', () => {
    expect(compactedNotice('E', 480_000)).toBe('🗜️ E compacted its context (was 480k tokens). The full history stays in transcript.md.');
  });
  it('rounds to thousands', () => {
    expect(compactedNotice('Ken', 213_499)).toBe('🗜️ Ken compacted its context (was 213k tokens). The full history stays in transcript.md.');
  });
  it('an unknown size is left out rather than invented', () => {
    expect(compactedNotice('E', undefined)).toBe('🗜️ E compacted its context. The full history stays in transcript.md.');
    expect(compactedNotice('E', 0)).toBe('🗜️ E compacted its context. The full history stays in transcript.md.');
  });
});
