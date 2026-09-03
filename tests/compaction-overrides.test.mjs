// PER-CONVERSATION auto-compaction overrides (operator 2026-09-03): the `compaction:` block
// carried in on afterTurn — from brainpool's resolveConv, and for a globally-pinned agent that
// block is its row in config/agents.yaml — resolved OVER the node-global `compaction:` block.
// It reuses config.yaml's OWN key names (`enabled`, `ratio`, `cooling_ms`, `context_window`)
// rather than inventing a second dialect, so these tests read the same on both sides.
//
// The service's own debounce/pool/disable behavior is locked in spine-compaction.test.mjs and is
// NOT repeated here; this file locks only what the override tier adds — plus the regression that
// a node stating nothing per-conversation behaves exactly as it did before it existed.
//
// Manual scheduler + fake pool + injected dueFor: no timers, no warm pool, no filesystem.
import { describe, it, expect } from 'vitest';
import { createCompaction } from '../src/spine/compaction.mjs';

// Records the delay it was armed with (the cooling period) as well as the callback, so a
// per-conversation `cooling_ms` is observable without waiting for it.
function makeScheduler() {
  const s = {
    fn: null, ms: null, setCount: 0, clearCount: 0,
    set(fn, ms) { s.setCount++; s.fn = fn; s.ms = ms; return { id: s.setCount }; },
    clear() { s.clearCount++; s.fn = null; },
    async fire() { const f = s.fn; s.fn = null; if (f) await f(); },
  };
  return s;
}
function fakePool() { const runs = []; return { runs, run(key, msg, _onP, opts) { runs.push({ key, msg, opts }); return Promise.resolve({ text: '' }); } }; }
// dueFor is where the RESOLVED ratio and the FROZEN target both surface — the service passes
// `(target, { ratio })`, so recording the call is how a test sees which policy actually ran.
function recorder(due = false) {
  const seen = [];
  return { seen, dueFor: (target, opts) => { seen.push({ target, opts }); return { due, tokens: 50_000, threshold: 40_000 }; } };
}

const TARGET = { key: 'e:ccode:whatsapp:hfm-1', sessionId: 'sid-1', model: 'haiku', cwd: '/c', allowedTools: 'all' };
// The node-global block these tests override. Deliberately different from every built-in
// default so a fallback can never be mistaken for a correct override.
const NODE = { compaction: { ratio: 0.90, cooling_ms: 30_000, context_window: 400_000 } };

// The service's own built-in defaults, restated as literals on purpose: if one of them moves,
// the regression lock below should FAIL rather than follow the new number silently.
const DEFAULT_RATIO = 0.20;           // compaction.mjs DEFAULT_RATIO (operator 2026-06-30)
const DEFAULT_COOLING_MS = 120_000;   // compaction.mjs DEFAULT_COOLING_MS — 2 min of quiet
const HAIKU_WINDOW = 200_000;         // compact-being.mjs windowForModel('haiku')

// Arm one turn and fire the cooling timer, returning everything the run touched.
function arm({ config = {}, compaction, due = false } = {}) {
  const pool = fakePool(), sched = makeScheduler(), rec = recorder(due);
  let cfg = config;
  const c = createCompaction({ pool, getConfig: () => cfg, scheduler: sched, dueFor: rec.dueFor });
  c.afterTurn(compaction === undefined ? { ...TARGET } : { ...TARGET, compaction });
  return { pool, sched, seen: rec.seen, service: c, setConfig: (next) => { cfg = next; } };
}

describe('compaction — per-conversation overrides (operator 2026-09-03)', () => {
  // ── THE REGRESSION LOCK. Everything else in this file is new behavior; this is the one that
  //    proves an unconfigured node did not change. afterTurn is called EXACTLY as brainpool
  //    called it before the override existed — no `compaction` key at all — and every resolved
  //    number must still come from the node-global block (or, absent that, the built-in
  //    defaults), with the node's own `enabled: false` still switching the service off. ──
  it('REGRESSION: afterTurn with NO compaction field resolves exactly as before — node ratio, node cooling_ms, node context_window, and a node enabled:false still disables', async () => {
    const a = arm({ config: NODE });                 // ← no `compaction` key on the call
    expect(a.sched.ms).toBe(30_000);                 // node cooling_ms
    await a.sched.fire();
    expect(a.seen[0].opts.ratio).toBe(0.90);         // node ratio reaches dueFor
    expect(a.seen[0].target.window).toBe(400_000);   // node context_window is what was frozen

    // ...and with no node block either, the service's own defaults, unchanged.
    const b = arm({ config: {} });
    expect(b.sched.ms).toBe(DEFAULT_COOLING_MS);
    await b.sched.fire();
    expect(b.seen[0].opts.ratio).toBe(DEFAULT_RATIO);
    expect(b.seen[0].target.window).toBe(HAIKU_WINDOW);   // per-MODEL, since nothing pinned one

    // ...and the node-global off switch still switches it off: never armed, never compacted.
    const off = arm({ config: { compaction: { enabled: false } }, due: true });
    expect(off.sched.setCount).toBe(0);
    expect(off.pool.runs).toHaveLength(0);
  });

  it('a per-conversation ratio overrides the node\'s — and it is the OVERRIDE that reaches dueFor', async () => {
    const a = arm({ config: NODE, compaction: { ratio: 0.40 } });
    await a.sched.fire();
    expect(a.seen[0].opts.ratio).toBe(0.40);
    expect(a.seen[0].opts.ratio).not.toBe(0.90);
  });

  it('a per-conversation cooling_ms overrides the node\'s (the delay the timer is armed with)', () => {
    const a = arm({ config: NODE, compaction: { cooling_ms: 5_000 } });
    expect(a.sched.setCount).toBe(1);
    expect(a.sched.ms).toBe(5_000);
  });

  it('a per-conversation context_window overrides the node\'s (frozen onto the target)', async () => {
    const a = arm({ config: NODE, compaction: { context_window: 1_000_000 } });
    await a.sched.fire();
    expect(a.seen[0].target.window).toBe(1_000_000);
  });

  it('enabled:false for ONE conversation disables it while the node has compaction on', () => {
    const a = arm({ config: NODE, compaction: { enabled: false }, due: true });
    expect(a.sched.setCount).toBe(0);   // never even armed
    expect(a.pool.runs).toHaveLength(0);
  });

  // The other direction is the reason enabledFor is a `??` walk and not an AND: one being can be
  // compacted on a node that has compaction switched off for everyone else.
  it('enabled:true for ONE conversation RE-ENABLES it while the node has compaction off', async () => {
    const a = arm({ config: { compaction: { enabled: false, ratio: 0.90 } }, compaction: { enabled: true, ratio: 0.40 }, due: true });
    expect(a.sched.setCount).toBe(1);
    await a.sched.fire();
    expect(a.seen[0].opts.ratio).toBe(0.40);
    expect(a.pool.runs).toHaveLength(1);
    expect(a.pool.runs[0].msg).toBe('/compact');
  });

  // ── VALIDATION. `Number(x) || fallback` would have accepted a NEGATIVE ratio as real and
  //    silently swallowed a ratio of 0 as falsy — and 0 does not mean "unset", it means
  //    "compact after every single turn". Every unusable value falls back to the node's answer
  //    instead, which is why the helpers validate rather than coerce.
  //
  //    BOOLEANS are the case where the fallback DIRECTION is the point, not the validation
  //    (operator 2026-09-03). `Number(true)` is 1, so an accepted `ratio: true` would mean
  //    "compact at 100% of the window" — never, in practice — and a conversation that overshoots
  //    is not compacted late, it is LOST: brainpool's §7 overflow backstop resets to a fresh
  //    session. `enabled: true` sits directly above `ratio:` in the block, so transposing them is
  //    the realistic typo, and it would read as "on" while arming the one outcome this service
  //    exists to prevent. ──
  it('an unusable ratio (0, negative, >1, non-numeric, boolean) falls back to the node-global ratio rather than being accepted', async () => {
    for (const bad of [0, -0.5, 1.5, 'plenty', null, {}, [], true, false]) {
      const a = arm({ config: NODE, compaction: { ratio: bad } });
      await a.sched.fire();
      expect(a.seen[0].opts.ratio, `ratio: ${JSON.stringify(bad)}`).toBe(0.90);
    }
    // ...while a legitimate boundary value (exactly 1 = the whole window) is still accepted —
    // it is only the BOOLEAN that coerces to 1 that must not be, not the number a human wrote.
    const ok = arm({ config: NODE, compaction: { ratio: 1 } });
    await ok.sched.fire();
    expect(ok.seen[0].opts.ratio).toBe(1);
    // ...and a numeric STRING still coerces: quoting a number in YAML is an accident, not a typo
    // that changes the meaning, so this one is deliberately NOT rejected alongside the booleans.
    const quoted = arm({ config: NODE, compaction: { ratio: '0.6' } });
    await quoted.sched.fire();
    expect(quoted.seen[0].opts.ratio).toBe(0.6);
  });

  // cooling_ms and context_window go through the SAME _pos helper, so a boolean there used to
  // resolve to 1 as well — a 1-millisecond cooling period (compact after every turn, instantly)
  // and a 1-TOKEN window (over threshold forever). Same fallback, same reason.
  it('a boolean cooling_ms or context_window falls back to the node-global value too — never a 1ms timer or a 1-token window', async () => {
    for (const bad of [true, false]) {
      const c = arm({ config: NODE, compaction: { cooling_ms: bad } });
      expect(c.sched.ms, `cooling_ms: ${bad}`).toBe(30_000);
      const w = arm({ config: NODE, compaction: { context_window: bad } });
      await w.sched.fire();
      expect(w.seen[0].target.window, `context_window: ${bad}`).toBe(400_000);
    }
  });

  it('a compaction value that is not a plain object (string, array, null) is ignored entirely — every answer stays node-global', async () => {
    for (const bad of ['0.4', ['ratio', 0.4], null, 42, true]) {
      const a = arm({ config: NODE, compaction: bad });
      expect(a.sched.ms, `compaction: ${JSON.stringify(bad)}`).toBe(30_000);
      await a.sched.fire();
      expect(a.seen[0].opts.ratio).toBe(0.90);
      expect(a.seen[0].target.window).toBe(400_000);
    }
    // ...and a non-object cannot switch compaction off either — the node still decides.
    const off = arm({ config: { compaction: { enabled: false } }, compaction: 'enabled' });
    expect(off.sched.setCount).toBe(0);
  });

  // ── FROZEN AT ARM TIME. The policy that armed a compaction is the one that should run it; the
  //    alternative is a conversation compacted a cooling period later under whichever config
  //    happened to be loaded by then. `window` was already frozen for this reason — the resolved
  //    `ratio` now is too. ──
  it('the resolved ratio is FROZEN when the timer is armed — a config edit before the timer fires does not change it', async () => {
    const a = arm({ config: { compaction: { ratio: 0.50 } } });   // armed under 0.50
    a.setConfig({ compaction: { ratio: 0.90 } });                 // operator edits config.yaml mid-cooling
    await a.sched.fire();
    expect(a.seen[0].opts.ratio).toBe(0.50);                      // ...the armed policy still ran

    // Same for a ratio that came from the per-conversation tier over a node that then moves.
    const b = arm({ config: { compaction: { ratio: 0.90 } }, compaction: { ratio: 0.40 } });
    b.setConfig({ compaction: { ratio: 0.10 } });
    await b.sched.fire();
    expect(b.seen[0].opts.ratio).toBe(0.40);
  });
});
