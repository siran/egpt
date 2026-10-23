// Auto-compaction service: after a cooling period following the last bot turn in a
// conversation, /compact its warm session (native, in place) if it's over ratio.
// Manual scheduler + fake pool + injected dueFor — no timers, no session files.
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { createCompaction } from '../src/spine/compaction.mjs';
import { TEMPLATES } from '../src/tools/template.mjs';

// The variables each fill call was handed, by template text: checked against TEMPLATES.
const filled = vi.hoisted(() => new Map());
vi.mock('../src/tools/template.mjs', async (real) => {
  const t = await real();
  return { ...t, fill: (tpl, vars) => (filled.set(tpl, Object.keys(vars).sort()), t.fill(tpl, vars)) };
});
const documented = (key) => Object.keys(TEMPLATES[key]).sort();
import { createWarmPool } from '../src/warm-sessions.mjs';

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

const TARGET = { key: 'e:ccode:whatsapp:hfm-1', sessionId: 'sid-1', model: 'haiku', cwd: '/c', allowedTools: 'all' };

describe('compaction service', () => {
  // contract 10.3
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

// ── GRACEFUL COMPACTION: ① THE HANDOFF + ③ THE WELCOME PAYLOAD (operator 2026-10-04) ──────────
// Before the native /compact, if a handoff_prompt is configured the being — still holding its
// full pre-compact context — gets ONE turn on the SAME warm session to write its working state to
// handoffs/{agent}.handoff.md. After the compact, the configured welcome rides the identity
// re-feed as armIdentityRefresh's payload. Both OPTIONAL; unset is today's behaviour, byte-for-byte.
// {agent} resolves to the being handle, which is the first segment of the warm key.
describe('compaction service: graceful compaction (handoff + welcome)', () => {
  it('① runs a handoff turn with the {agent}-resolved prompt BEFORE /compact when handoff_prompt is set', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({
      pool,
      getConfig: () => ({ compaction: { handoff_prompt: 'HANDOFF {agent}: write handoffs/{agent}.handoff.md now' } }),
      scheduler: sched,
      dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }),
    });
    c.afterTurn(TARGET);                                       // TARGET.key = 'e:ccode:whatsapp:hfm-1' → being 'e'
    await sched.fire();
    expect(pool.runs).toHaveLength(2);
    expect(pool.runs[0].msg).toBe('HANDOFF e: write handoffs/e.handoff.md now');   // {agent} → 'e'
    expect(pool.runs[0].key).toBe(TARGET.key);                                     // SAME warm session
    expect(pool.runs[0].opts.brainOptions).toMatchObject({ sessionId: 'sid-1', cwd: '/c' });
    expect(pool.runs[1].msg).toBe('/compact');                                     // the compact runs AFTER the handoff
  });

  it('① with handoff_prompt unset, NO handoff turn — exactly one /compact (today\'s behavior, locked)', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }) });
    c.afterTurn(TARGET);
    await sched.fire();
    expect(pool.runs).toHaveLength(1);
    expect(pool.runs[0].msg).toBe('/compact');
  });

  it('① a THROWING handoff turn is NON-FATAL: /compact still runs and the identity re-feed still arms', async () => {
    const sched = makeScheduler();
    const runs = [], logs = [];
    let armed = 0;
    const pool = { run: async (_key, msg) => { runs.push(msg); if (msg !== '/compact') throw new Error('handoff blew up'); return { text: '' }; } };
    const c = createCompaction({
      pool,
      getConfig: () => ({ compaction: { handoff_prompt: 'write handoffs/{agent}.handoff.md' } }),
      scheduler: sched,
      dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }),
      onLog: (m) => logs.push(m),
    });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async () => { armed++; } });
    await sched.fire();
    expect(runs).toEqual(['write handoffs/e.handoff.md', '/compact']);   // handoff attempted, compact still ran
    expect(armed).toBe(1);                                               // and the re-feed still armed
    expect(logs.join('\n')).toMatch(/handoff turn failed/i);
    expect(logs.join('\n')).toMatch(/handoff blew up/);
  });

  it('③ hands the {agent}-resolved welcome to armIdentityRefresh (the re-feed payload)', async () => {
    const pool = fakePool(), sched = makeScheduler();
    let welcomeArg;
    const c = createCompaction({
      pool,
      getConfig: () => ({ compaction: { welcome: 'hi {agent}, read handoffs/{agent}.handoff.md' } }),
      scheduler: sched,
      dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }),
    });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async (w) => { welcomeArg = w; } });
    await sched.fire();
    expect(welcomeArg).toBe('hi e, read handoffs/e.handoff.md');
  });

  it('③ with welcome unset, armIdentityRefresh is armed WITHOUT a welcome (empty payload) — today\'s behavior', async () => {
    const pool = fakePool(), sched = makeScheduler();
    let welcomeArg = 'UNSET';
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: () => ({ due: true, tokens: 50000, threshold: 40000 }) });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async (w) => { welcomeArg = w; } });
    await sched.fire();
    expect(welcomeArg).toBe('');
  });
});

// ── TWO THRESHOLDS: WARN (handoff + pre-compaction notice), then COMPACT (operator 2026-10-08) ──
// The WARN threshold sits `warn_gap` of the window BELOW the compact `ratio`. At WARN the being
// writes its handoff and the admin channel gets the pre-compaction notice, ONCE per thread; at
// `ratio` the /compact runs and the handoff is NOT re-run. TARGET is model haiku → window 200_000,
// default ratio 0.20 → compact threshold 40_000, default warn_gap 0.03 → warn threshold 34_000.
// dueFor is mocked with the COMPACT `due` and a `tokens`; the service derives WARN from tokens+window.
describe('compaction service: two thresholds (warn, then compact)', () => {
  it('(a) WARN fires ONCE: handoff + notice run at the warn threshold, and a second tick between warn and compact repeats neither', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const notices = [];
    let state = { due: false, tokens: 36_000, threshold: 40_000 };   // warn-due (>=34_000), not compact-due
    const c = createCompaction({
      pool,
      getConfig: () => ({ compaction: { handoff_prompt: 'HANDOFF {agent}' }, compaction_warn_notice: 'at {percent}%' }),
      scheduler: sched,
      dueFor: () => state,
    });
    const tgt = { ...TARGET, noticeWarn: async (n) => { notices.push(n); } };
    c.afterTurn(tgt);
    await sched.fire();
    expect(pool.runs.map((r) => r.msg)).toEqual(['HANDOFF e']);       // handoff ran, NO /compact yet
    expect(notices).toHaveLength(1);                                  // pre-compaction notice posted once
    // a second tick, still between warn and compact — neither repeats
    state = { due: false, tokens: 37_000, threshold: 40_000 };
    c.afterTurn(tgt);
    await sched.fire();
    expect(pool.runs.map((r) => r.msg)).toEqual(['HANDOFF e']);       // no re-handoff
    expect(notices).toHaveLength(1);                                  // no re-post
  });

  it('(b) COMPACT after WARN: /compact runs at the ratio and the handoff is NOT re-run', async () => {
    const pool = fakePool(), sched = makeScheduler();
    let state = { due: false, tokens: 36_000, threshold: 40_000 };
    const c = createCompaction({
      pool,
      getConfig: () => ({ compaction: { handoff_prompt: 'HANDOFF {agent}' } }),
      scheduler: sched,
      dueFor: () => state,
    });
    c.afterTurn(TARGET); await sched.fire();                          // WARN tick
    expect(pool.runs.map((r) => r.msg)).toEqual(['HANDOFF e']);
    state = { due: true, tokens: 50_000, threshold: 40_000 };         // now past the compact ratio
    c.afterTurn(TARGET); await sched.fire();                          // COMPACT tick
    expect(pool.runs.map((r) => r.msg)).toEqual(['HANDOFF e', '/compact']);   // compacted, handoff not repeated
  });

  it('(c) the notice interpolates {agent}, {percent} and {path}', async () => {
    const pool = fakePool(), sched = makeScheduler();
    let body;
    const c = createCompaction({
      pool,
      getConfig: () => ({ compaction_warn_notice: '{agent} at {percent}% -> {path}' }),
      scheduler: sched,
      dueFor: () => ({ due: false, tokens: 36_000, threshold: 40_000 }),   // 36_000 / 200_000 = 18%
    });
    c.afterTurn({ ...TARGET, noticeWarn: async ({ text }) => { body = text; } });
    await sched.fire();
    expect(body).toMatch(/^e at 18% -> /);        // {agent} = e (warm-key head), {percent} = 18
    expect(body).toContain('handoffs');           // {path} = cwd-joined handoff file…
    expect(body).toContain('e.handoff.md');        // …named for the being
  });

  it('(d) warn_gap: the default 0.03 and node/per-being overrides set the warn threshold', async () => {
    // window 200_000, ratio 0.20. warn threshold = round(window * (ratio - warn_gap)).
    const warnFired = async ({ config = {}, compaction, tokens }) => {
      const sched = makeScheduler();
      const notices = [];
      const c = createCompaction({ pool: fakePool(), getConfig: () => config, scheduler: sched, dueFor: () => ({ due: false, tokens, threshold: 40_000 }) });
      const base = { ...TARGET, noticeWarn: async (n) => { notices.push(n); } };
      c.afterTurn(compaction === undefined ? base : { ...base, compaction });
      await sched.fire();
      return notices.length > 0;
    };
    // default 0.03 → threshold round(200_000 * 0.17) = 34_000
    expect(await warnFired({ tokens: 34_000 })).toBe(true);
    expect(await warnFired({ tokens: 33_999 })).toBe(false);
    // node override 0.10 → threshold round(200_000 * 0.10) = 20_000
    expect(await warnFired({ config: { compaction: { warn_gap: 0.10 } }, tokens: 20_000 })).toBe(true);
    expect(await warnFired({ config: { compaction: { warn_gap: 0.10 } }, tokens: 19_999 })).toBe(false);
    // per-being override WINS over the node: 0.02 → threshold round(200_000 * 0.18) = 36_000
    expect(await warnFired({ config: { compaction: { warn_gap: 0.10 } }, compaction: { warn_gap: 0.02 }, tokens: 36_000 })).toBe(true);
    expect(await warnFired({ config: { compaction: { warn_gap: 0.10 } }, compaction: { warn_gap: 0.02 }, tokens: 35_999 })).toBe(false);
  });

  it('(e) degrade: a blank compaction_warn_notice skips the notice, and no sink is harmless', async () => {
    const sched = makeScheduler();
    let posted = 0;
    const c = createCompaction({ pool: fakePool(), getConfig: () => ({ compaction_warn_notice: '   ' }), scheduler: sched, dueFor: () => ({ due: false, tokens: 36_000, threshold: 40_000 }) });
    c.afterTurn({ ...TARGET, noticeWarn: async () => { posted++; } });
    await sched.fire();
    expect(posted).toBe(0);                                           // blank text → notice skipped
    // and a warn-due tick with NO noticeWarn sink wired neither throws nor posts (today's degrade)
    const sched2 = makeScheduler();
    const c2 = createCompaction({ pool: fakePool(), getConfig: () => ({}), scheduler: sched2, dueFor: () => ({ due: false, tokens: 36_000, threshold: 40_000 }) });
    c2.afterTurn({ ...TARGET });
    await expect(sched2.fire()).resolves.toBeUndefined();
  });
});

// /agents compact (operator 2026-10-15): the SAME graceful sequence the scheduled compaction
// runs — handoff turn, warn notice, native /compact, identity re-feed armed with the welcome —
// on demand, over the target the being's last turn froze. No second compactor.
describe('compaction: compactNow (on demand, /agents compact)', () => {
  const CFG = { compaction: { handoff_prompt: 'HANDOFF {agent}', welcome: 'WELCOME {agent}' } };
  const big = () => ({ due: true, tokens: 964_000, threshold: 200_000 });

  it('runs the handoff turn BEFORE /compact, then arms the re-feed with the welcome and says so on the admin channel', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const order = [], armed = [];
    const c = createCompaction({ pool, getConfig: () => CFG, scheduler: sched, dueFor: big });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async (w) => { armed.push(w); order.push('arm'); }, noticeWarn: async () => { order.push('warn'); }, noticeCompacted: async () => { order.push('compacted'); } });
    const r = c.compactNow(TARGET.key, { sessionId: 'sid-1' });
    expect(r.ok).toBe(true);
    expect(await r.done).toMatchObject({ compacted: true, tokens: 964_000 });
    expect(pool.runs.map((x) => x.msg)).toEqual(['HANDOFF e', '/compact']);
    expect(pool.runs.every((x) => x.key === TARGET.key)).toBe(true);
    expect(order).toEqual(['warn', 'arm', 'compacted']);
    expect(armed).toEqual(['WELCOME e']);
  });

  it('compacts even when auto-compaction is OFF and the session is under ratio — it was asked for', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({ compaction: { enabled: false } }), scheduler: sched, dueFor: () => ({ due: false, tokens: 1000, threshold: 40_000 }) });
    c.afterTurn(TARGET);
    expect(sched.setCount).toBe(0);                      // the scheduled path is still off
    const r = c.compactNow(TARGET.key);
    expect((await r.done).compacted).toBe(true);
    expect(pool.runs.map((x) => x.msg)).toEqual(['/compact']);   // no handoff_prompt → skipped, as the service does
  });

  it('clears a pending cooling timer so the scheduled fire does not run a second compaction', async () => {
    const pool = fakePool(), sched = makeScheduler();
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: sched, dueFor: big });
    c.afterTurn(TARGET);
    await c.compactNow(TARGET.key).done;
    expect(sched.clearCount).toBe(1);
    expect(sched.fn).toBe(null);
  });

  it('refuses plainly: no turn yet, a changed thread, or one already running', async () => {
    let release;
    const pool = { runs: [], run(key, msg) { this.runs.push(msg); return new Promise((r) => { release = r; }); } };
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: makeScheduler(), dueFor: big });
    expect(c.compactNow(TARGET.key)).toMatchObject({ ok: false });
    c.afterTurn(TARGET);
    expect(c.compactNow(TARGET.key, { sessionId: 'sid-OTHER' })).toMatchObject({ ok: false });
    const first = c.compactNow(TARGET.key, { sessionId: 'sid-1' });
    expect(first.ok).toBe(true);
    expect(c.compactNow(TARGET.key)).toMatchObject({ ok: false, reason: expect.stringMatching(/already/) });
    await new Promise((r) => setImmediate(r));
    release({ text: '' });
    expect((await first.done).compacted).toBe(true);
  });

  it('a /compact that throws is reported, not swallowed — and nothing is armed', async () => {
    let armed = 0;
    const pool = { run: async () => { throw new Error('session is gone'); } };
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: makeScheduler(), dueFor: big });
    c.afterTurn({ ...TARGET, armIdentityRefresh: async () => { armed++; } });
    expect(await c.compactNow(TARGET.key).done).toMatchObject({ compacted: false, reason: expect.stringMatching(/session is gone/) });
    expect(armed).toBe(0);
  });

  it('says whether a turn is in flight (the compaction queues behind it)', async () => {
    const pool = { ...fakePool(), busy: (k) => k === TARGET.key };
    const c = createCompaction({ pool, getConfig: () => ({}), scheduler: makeScheduler(), dueFor: big });
    c.afterTurn(TARGET);
    const r = c.compactNow(TARGET.key);
    expect(r.inFlight).toBe(true);
    await r.done;
  });
});

// ONE HANDOFF PATH (live 2026-10-17: prompt, notice and welcome named three different files).
// {YYMMDD-HHMM} is resolved ONCE at warn, node-local, and the prompt, the notice's {path} and the
// welcome all carry that one string, even when the compact lands later.
describe('compaction: one handoff path for prompt, notice and welcome', () => {
  const cfg = (prompt, welcome) => ({
    compaction: { handoff_prompt: prompt, welcome, compact_after_handoff: false },
    compaction_warn_notice: 'read it here: {path}',
  });
  const run = async (config) => {
    const pool = fakePool(), sched = makeScheduler();
    let t = new Date(2026, 9, 17, 22, 21), notice, welcome;
    let state = { due: false, tokens: 36_000, threshold: 40_000 };
    const c = createCompaction({ pool, getConfig: () => config, scheduler: sched, dueFor: () => state, now: () => t });
    const tgt = { ...TARGET, noticeWarn: async ({ text }) => { notice = text; }, armIdentityRefresh: async (w) => { welcome = w; } };
    c.afterTurn(tgt); await sched.fire();                    // WARN at 22:21
    t = new Date(2026, 9, 17, 23, 5);                        // the compact lands later
    state = { due: true, tokens: 50_000, threshold: 40_000 };
    c.afterTurn(tgt); await sched.fire();
    return { prompt: pool.runs[0].msg, notice, welcome, msgs: pool.runs.map((r) => r.msg) };
  };

  it('the three name the same timestamped file, stamped at warn time', async () => {
    const r = await run(cfg(
      'write to handoffs/{agent}.{YYMMDD-HHMM}.handoff.md, so you can resume',
      'read your handoff at handoffs/{agent}.{YYMMDD-HHMM}.handoff.md and continue'));
    const rel = 'handoffs/e.261017-2221.handoff.md';
    expect(r.msgs).toEqual([`write to ${rel}, so you can resume`, '/compact']);
    expect(r.notice).toBe(`read it here: ${join('/c', rel)}`);
    expect(r.welcome).toBe(`read your handoff at ${rel} and continue`);
  });

  it('a template without the timestamp token has no timestamp', async () => {
    const r = await run(cfg('write handoffs/{agent}.handoff.md now', 'read handoffs/{agent}.handoff.md'));
    expect(r.prompt).toBe('write handoffs/e.handoff.md now');
    expect(r.notice).toBe(`read it here: ${join('/c', 'handoffs/e.handoff.md')}`);
    expect(r.welcome).toBe('read handoffs/e.handoff.md');
  });

  it('every variable of each key; an unknown {x} stays as written; the call sites pass what TEMPLATES documents', async () => {
    filled.clear();
    const r = await run({
      compaction: { handoff_prompt: '{agent}|{YYMMDD-HHMM}|{x} handoffs/{agent}.md', welcome: '{agent}|{YYMMDD-HHMM}|{x}', compact_after_handoff: false },
      compaction_warn_notice: '{agent}|{percent}|{path}|{x}',
    });
    expect(r.prompt).toBe('e|261017-2221|{x} handoffs/e.md');
    expect(r.notice).toBe(`e|18|${join('/c', 'handoffs/e.md')}|{x}`);
    expect(r.welcome).toBe('e|261017-2221|{x}');
    expect(filled.get('{agent}|{YYMMDD-HHMM}|{x} handoffs/{agent}.md')).toEqual(documented('compaction.handoff_prompt'));
    expect(filled.get('{agent}|{YYMMDD-HHMM}|{x}')).toEqual(documented('compaction.welcome'));
    expect(filled.get('{agent}|{percent}|{path}|{x}')).toEqual(documented('compaction_warn_notice'));
  });
});

// COMPACT RIGHT AFTER THE HANDOFF (operator 2026-10-17, compaction.compact_after_handoff, default on):
// a handoff turn that succeeded on an idle conversation is followed by the /compact at once; with
// work pending, the next quiet tick past warn compacts; a failed/empty handoff or the switch off
// keeps the old rule (compact at ratio).
describe('compaction: compact right after the handoff', () => {
  const CFG = { compaction: { handoff_prompt: 'HANDOFF {agent}', welcome: 'WELCOME {agent}' } };
  const WARN = () => ({ due: false, tokens: 36_000, threshold: 40_000 });
  const DUE = () => ({ due: true, tokens: 50_000, threshold: 40_000 });
  const handoffPool = (over = {}) => ({
    runs: [],
    run(key, msg) { this.runs.push(msg); return Promise.resolve({ text: msg === '/compact' ? '' : 'handoff written' }); },
    busy: () => false, pending: () => 0, background: () => [],
    ...over,
  });
  const setup = ({ pool, config = CFG, dueFor = WARN, criticalOver } = {}) => {
    const sched = makeScheduler(), armed = [];
    let state = dueFor;
    const c = createCompaction({ pool, getConfig: () => config, scheduler: sched, dueFor: () => state(), ...(criticalOver ? { criticalOver } : {}) });
    const tick = async (next) => { if (next) state = next; c.afterTurn({ ...TARGET, armIdentityRefresh: async (w) => { armed.push(w); } }); await sched.fire(); };
    return { sched, armed, tick };
  };

  it('idle: /compact right after the handoff, then the welcome', async () => {
    const pool = handoffPool();
    const { armed, tick } = setup({ pool });
    await tick();
    expect(pool.runs).toEqual(['HANDOFF e', '/compact']);
    expect(armed).toEqual(['WELCOME e']);
  });

  it('a turn queued or in flight: no immediate compact; the next quiet tick past warn compacts', async () => {
    for (const over of [{ pending: () => 1 }, { busy: () => true }]) {
      const pool = handoffPool(over);
      const { tick } = setup({ pool });
      await tick();
      expect(pool.runs).toEqual(['HANDOFF e']);
      await tick();                                            // quiet again, still short of ratio
      expect(pool.runs).toEqual(['HANDOFF e', '/compact']);
    }
  });

  it('live background work: no immediate compact', async () => {
    const pool = handoffPool({ background: () => [{ description: 'audit', since: 1 }] });
    const { tick } = setup({ pool });
    await tick();
    expect(pool.runs).toEqual(['HANDOFF e']);
  });

  it('a failed or empty handoff: no immediate compact, and it waits for ratio', async () => {
    const failing = { run(key, msg) { this.runs.push(msg); return msg === '/compact' ? Promise.resolve({ text: '' }) : Promise.reject(new Error('boom')); } };
    const empty = { run(key, msg) { this.runs.push(msg); return Promise.resolve({ text: '  ' }); } };
    for (const over of [failing, empty]) {
      const pool = handoffPool(over);
      const { tick } = setup({ pool });
      await tick();
      await tick();                                            // a second warn-only tick: still waiting
      expect(pool.runs).toEqual(['HANDOFF e']);
      await tick(DUE);
      expect(pool.runs).toEqual(['HANDOFF e', '/compact']);
    }
  });

  it('the switch off: compact only at ratio (the old rule)', async () => {
    const pool = handoffPool();
    const { tick } = setup({ pool, config: { compaction: { ...CFG.compaction, compact_after_handoff: false } } });
    await tick();
    await tick();
    expect(pool.runs).toEqual(['HANDOFF e']);
    await tick(DUE);
    expect(pool.runs).toEqual(['HANDOFF e', '/compact']);
  });

  it('critical_ratio unchanged: armed with no wait, compacts even with work pending', async () => {
    const pool = handoffPool({ pending: () => 1, background: () => [{ description: 'audit', since: 1 }] });
    const { sched, tick } = setup({ pool, config: { compaction: { ...CFG.compaction, critical_ratio: 0.9 } }, dueFor: DUE, criticalOver: () => true });
    await tick();
    expect(sched.ms).toBe(0);
    expect(pool.runs).toEqual(['HANDOFF e', '/compact']);
  });

  describe('with the real warm pool', () => {
    const sessions = () => {
      const made = [];
      let release = null;
      const makeSession = () => {
        const s = { turns: [], close() {}, turn(msg) { s.turns.push(msg); if (msg === 'HANDOFF e') return new Promise((r) => { release = () => r({ text: 'written' }); }); return Promise.resolve({ text: 'ok' }); } };
        made.push(s);
        return s;
      };
      return { made, makeSession, release: () => release() };
    };
    const settle = () => new Promise((r) => setImmediate(r));

    it('idle: the /compact follows the handoff on the same session', async () => {
      const s = sessions();
      const { tick } = setup({ pool: createWarmPool({ makeSession: s.makeSession }) });
      const fired = tick();
      await settle();
      s.release();
      await fired;
      expect(s.made[0].turns).toEqual(['HANDOFF e', '/compact']);
    });

    it('a message queued behind the handoff turn blocks the immediate compact', async () => {
      const s = sessions();
      const pool = createWarmPool({ makeSession: s.makeSession });
      const { tick } = setup({ pool });
      const fired = tick();
      await settle();
      const human = pool.run(TARGET.key, 'hello', () => {}, { klass: 'conversation' });
      s.release();
      await fired;
      await human;
      expect(s.made[0].turns).toEqual(['HANDOFF e', 'hello']);
    });
  });
});
