// THE CRITICAL RATIO (operator 2026-09-14: "10 minutes of quiet or a critical .9"). The cooling
// timer is RE-ARMED on every turn, so a conversation that stays busy never goes quiet and never
// compacts -- and a session that overshoots the window is not compacted late, it is LOST
// (brainpool's overflow backstop RESETS it to a fresh session). `critical_ratio` is the second
// trigger: past it, the same compaction is armed with NO wait.
//
// What this file locks is the ARMING DELAY, because that is the whole feature -- the compaction
// itself is unchanged and stays locked in spine-compaction.test.mjs. Manual scheduler, fake
// pool, injected probes: no timers, no warm pool, no filesystem.
import { describe, it, expect } from 'vitest';
import { createCompaction } from '../src/spine/compaction.mjs';
import { tailContextTokens, criticallyOver, TAIL_PROBE_BYTES } from '../src/tools/compact-being.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeScheduler() {
  const s = {
    fn: null, ms: null, setCount: 0,
    set(fn, ms) { s.setCount++; s.fn = fn; s.ms = ms; return { id: s.setCount }; },
    clear() { s.fn = null; },
    async fire() { const f = s.fn; s.fn = null; if (f) await f(); },
  };
  return s;
}
const fakePool = () => ({ runs: [], run(key, msg, _p, opts) { this.runs.push({ key, msg, opts }); return Promise.resolve({ text: '' }); } });
const TURN = { key: 'wren:ccode:agent:agent/wren', sessionId: 'sid-1', model: 'opus', cwd: '/c', allowedTools: 'all' };
const NODE_COOLING = 600_000;

function armWith({ node = {}, over = undefined, criticalOver = () => false } = {}) {
  const scheduler = makeScheduler();
  const svc = createCompaction({
    pool: fakePool(),
    getConfig: () => ({ compaction: { cooling_ms: NODE_COOLING, ratio: 0.5, ...node } }),
    scheduler,
    dueFor: () => ({ due: false }),
    criticalOver,
  });
  svc.afterTurn({ ...TURN, compaction: over });
  return scheduler;
}

describe('critical_ratio arms with no wait', () => {
  it('waits the full cooling period when nothing is configured', () => {
    expect(armWith().ms).toBe(NODE_COOLING);
  });

  it('is DISABLED when unset at both tiers, even if the session is enormous', () => {
    // The probe would say yes; it must never be consulted, because no critical ratio was stated.
    expect(armWith({ criticalOver: () => true }).ms).toBe(NODE_COOLING);
  });

  it('arms immediately when the node-global critical ratio is passed', () => {
    expect(armWith({ node: { critical_ratio: 0.9 }, criticalOver: () => true }).ms).toBe(0);
  });

  it('still waits when a critical ratio is set but the session is under it', () => {
    expect(armWith({ node: { critical_ratio: 0.9 }, criticalOver: () => false }).ms).toBe(NODE_COOLING);
  });

  it('lets a per-conversation critical ratio override the node-global one', () => {
    const seen = [];
    const s = armWith({
      node: { critical_ratio: 0.9 },
      over: { critical_ratio: 0.7 },
      criticalOver: (_t, o) => { seen.push(o.ratio); return true; },
    });
    expect(seen).toEqual([0.7]);
    expect(s.ms).toBe(0);
  });

  it('rejects a boolean critical ratio rather than reading true as 1', () => {
    // Number(true) === 1 would mean "compact at 100% of the window" -- i.e. never, which is the
    // exact outcome this feature exists to prevent. Unusable => fall back to the node tier.
    const s = armWith({ node: { critical_ratio: true }, criticalOver: () => true });
    expect(s.ms).toBe(NODE_COOLING);
  });

  it('rejects a critical ratio above 1, which could never fire', () => {
    expect(armWith({ node: { critical_ratio: 1.5 }, criticalOver: () => true }).ms).toBe(NODE_COOLING);
  });

  it('falls back to the cooling wait when the probe THROWS, never dropping the timer', () => {
    const s = armWith({ node: { critical_ratio: 0.9 }, criticalOver: () => { throw new Error('unreadable'); } });
    expect(s.ms).toBe(NODE_COOLING);
    expect(s.fn).toBeTypeOf('function');
  });
});

describe('tailContextTokens reads a bounded tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egpt-tail-'));
  const write = (name, lines) => {
    const p = join(dir, name);
    writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
    return p;
  };
  const usage = (t) => ({ message: { usage: { input_tokens: t } } });

  it('reports the last usage record', () => {
    const p = write('a.jsonl', [usage(10), usage(500)]);
    expect(tailContextTokens(p)).toBe(500);
  });

  it('reports 0 when a compact boundary is NEWER than the last usage', () => {
    const p = write('b.jsonl', [usage(500), { isCompactSummary: true }]);
    expect(tailContextTokens(p)).toBe(0);
  });

  it('sums the cache token fields the way the full reader does', () => {
    const p = write('c.jsonl', [{ message: { usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 } } }]);
    expect(tailContextTokens(p)).toBe(7);
  });

  it('returns null -- UNKNOWN, not zero -- when the tail holds no usage record', () => {
    const p = write('d.jsonl', [{ type: 'user' }, { type: 'user' }]);
    expect(tailContextTokens(p)).toBeNull();
  });

  it('returns null for a missing file rather than throwing', () => {
    expect(tailContextTokens(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('drops the partial first line when the tail starts mid-record', () => {
    // The budget is sized to land INSIDE the first record, so the read opens mid-line: the
    // fragment is not JSON and must be discarded rather than silently swallowing the record
    // that follows it. Derived from the file, not hard-coded -- a literal byte count here would
    // only be re-guessing whatever JSON.stringify happens to emit.
    const p = write('e.jsonl', [usage(111), usage(222)]);
    const second = JSON.stringify(usage(222)).length + 1;      // the last record + its newline
    expect(tailContextTokens(p, { bytes: second + 5 })).toBe(222);
  });

  it('returns null when the budget lands past every record boundary', () => {
    // Too small to hold even one whole record: dropping the partial leaves nothing, and the
    // honest answer is UNKNOWN. This is the case that must never read as a small session.
    const p = write('f.jsonl', [usage(111), usage(222)]);
    expect(tailContextTokens(p, { bytes: 4 })).toBeNull();
  });

  it('defaults to a 2 MiB budget', () => {
    expect(TAIL_PROBE_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('criticallyOver is false on every uncertainty', () => {
  const target = { sessionId: 'sid', model: 'opus', window: 1_000_000 };
  it('is false when no session file resolves', () => {
    expect(criticallyOver(target, { ratio: 0.9, resolveFile: () => null })).toBe(false);
  });
  it('is false when the ratio itself is unusable', () => {
    expect(criticallyOver(target, { ratio: 0, resolveFile: () => 'x' })).toBe(false);
  });
});
