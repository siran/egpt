// Compaction sizes and durations: one parser (compact-being parseSize / parseDuration) read by
// compactionPolicy and by the spine service; `cooling`; and the pre-compaction `alert_before`.
import { describe, it, expect } from 'vitest';
import { parseSize, parseDuration, compactionPolicy, windowForModel, compactionOverrideOf } from '../src/tools/compact-being.mjs';

import { createCompaction, warnNotice, formatDuration } from '../src/spine/compaction.mjs';

describe('parseSize', () => {
  it('accepts shares and token sizes, as a share of the window', () => {
    const W = 2_000_000;
    expect(parseSize(0.2, W)).toBe(0.2);
    expect(parseSize('20%', W)).toBeCloseTo(0.2);
    expect(parseSize('0.6', W)).toBe(0.6);
    expect(parseSize('100k', W)).toBeCloseTo(0.05);
    expect(parseSize('1.5m', W)).toBeCloseTo(0.75);
    expect(parseSize(200000, W)).toBeCloseTo(0.1);
    expect(parseSize('200000', W)).toBeCloseTo(0.1);
  });
  it('rejects booleans, zero, negatives, garbage and tokens at or above the window', () => {
    for (const bad of [true, false, 0, -1, '-5%', 'abc', '', null, undefined, {}, 1.5, '12x', NaN]) expect(parseSize(bad, 1_000_000)).toBeNull();
    expect(parseSize('1m', 1_000_000)).toBeNull();       // = the window: could never fire
    expect(parseSize(1_000_000, 1_000_000)).toBeNull();
    expect(parseSize('2m', 1_000_000)).toBeNull();
    expect(parseSize('101%', 1_000_000)).toBeNull();
    for (const typo of [40, '40', 999, '0.5k']) expect(parseSize(typo, 1_000_000)).toBeNull();   // under 1k tokens: a percent typo
    expect(parseSize(1000, 1_000_000)).toBeCloseTo(0.001);
  });
  it('zero is allowed only when asked (warn_gap)', () => {
    expect(parseSize(0, 1e6, { zero: true })).toBe(0);
    expect(parseSize('0%', 1e6, { zero: true })).toBe(0);
    expect(parseSize(true, 1e6, { zero: true })).toBeNull();
  });
});

describe('parseDuration', () => {
  it('reads units, compounds and bare ms', () => {
    expect(parseDuration('3h')).toBe(3 * 3_600_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration(120000)).toBe(120000);
    expect(parseDuration('120000')).toBe(120000);
  });
  it('rejects booleans, zero, negatives and garbage', () => {
    for (const bad of [true, 0, -5, '-1h', 'abc', '', '3x', null, undefined]) expect(parseDuration(bad)).toBeNull();
  });
  it('formatDuration round-trips the shapes the alert prints', () => {
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(5_400_000)).toBe('1h30m');
    expect(formatDuration(30_000)).toBe('30s');
  });
});

describe('compactionPolicy with the new forms', () => {
  it('haiku is a 1M window; a token size becomes a share of the resolved window', () => {
    expect(windowForModel('claude-haiku-5-5')).toBe(1_000_000);
    const p = compactionPolicy({ compaction: { ratio: '400k' } }, 'claude-haiku-5-5');
    expect(p).toMatchObject({ window: 1_000_000, threshold: 400_000 });
    expect(p.ratio).toBeCloseTo(0.4);
  });
  it('the same tokens are a different share on a different window (context_window override)', () => {
    const p = compactionPolicy({ compaction: { ratio: '100k', context_window: 500_000 } }, 'opus');
    expect(p.threshold).toBe(100_000);
  });
  it('tiers: the override wins; an unusable override falls to the node; tokens >= window fall back too', () => {
    const cfg = { compaction: { ratio: '30%' } };
    expect(compactionPolicy(cfg, 'opus', { ratio: '200k' }).threshold).toBe(200_000);
    expect(compactionPolicy(cfg, 'opus', { ratio: true }).threshold).toBe(300_000);
    expect(compactionPolicy(cfg, 'opus', { ratio: '2m' }).threshold).toBe(300_000);
    expect(compactionPolicy({ compaction: { ratio: 'junk' } }, 'opus').ratio).toBe(0.2);
  });
  it('compactionOverrideOf still resolves conversation, then being default, then none', () => {
    const cfg = { agents: { b: { conversation_defaults: { compaction: { ratio: '1k' } } } } };
    expect(compactionOverrideOf({ compaction: { ratio: '2k' } }, cfg, 'b')).toEqual({ ratio: '2k' });
    expect(compactionOverrideOf({}, cfg, 'b')).toEqual({ ratio: '1k' });
    expect(compactionOverrideOf({}, {}, 'b')).toBeNull();
  });
});

// ── the service ──
function makeScheduler() {
  const s = { timers: [], seq: 0,
    set(fn, ms) { const t = { id: ++s.seq, fn, ms, live: true }; s.timers.push(t); return t; },
    clear(t) { if (t) t.live = false; },
    live() { return s.timers.filter((t) => t.live); },
    async run(t) { t.live = false; await t.fn(); } };
  return s;
}
const TURN = { key: 'ana:ccode:telegram:team', sessionId: 'sid', model: 'opus', cwd: '/c', allowedTools: 'all' };
function setup({ compaction = {}, due = { due: false, tokens: 190_000 }, over = undefined, critical = false, top = {} } = {}) {
  const sched = makeScheduler(), posts = [];
  const pool = { run: async () => ({ text: '' }) };
  const c = createCompaction({
    pool, scheduler: sched,
    getConfig: () => ({ node_name: 'HQ', compaction, ...top }),
    dueFor: () => due,
    criticalOver: () => critical,
  });
  const noticeWarn = async ({ text }) => { posts.push(warnNotice({ node: 'HQ', label: 'ana', chat: 'Team', text })); };
  const turn = () => c.afterTurn({ ...TURN, compaction: over, noticeWarn, chat: 'Team' });
  return { sched, posts, turn, c };
}

describe('cooling', () => {
  it('"3h" arms the cooling timer; default stays 2 min', () => {
    const a = setup({ compaction: { cooling: '3h' } }); a.turn();
    expect(a.sched.live()[0].ms).toBe(10_800_000);
    const b = setup(); b.turn();
    expect(b.sched.live()[0].ms).toBe(120_000);
  });
  it('legacy cooling_ms still works, and cooling wins when both are set', () => {
    const a = setup({ compaction: { cooling_ms: 5000 } }); a.turn();
    expect(a.sched.live()[0].ms).toBe(5000);
    const b = setup({ compaction: { cooling_ms: 5000, cooling: '30s' } }); b.turn();
    expect(b.sched.live()[0].ms).toBe(30_000);
  });
  it('works at the other tiers: the override wins over the node', () => {
    const a = setup({ compaction: { cooling: '3h' }, over: { cooling: '90m' } }); a.turn();
    expect(a.sched.live()[0].ms).toBe(5_400_000);
    const b = setup({ compaction: { cooling: '3h' }, over: { cooling_ms: 1000 } }); b.turn();
    expect(b.sched.live()[0].ms).toBe(1000);
    const c = setup({ compaction: { cooling: '3h' }, over: { cooling: true } }); c.turn();
    expect(c.sched.live()[0].ms).toBe(10_800_000);
  });
});

describe('alert_before', () => {
  const cfg = { cooling: '3h', alert_before: '10m' };
  it('is off when unset', () => {
    const a = setup({ compaction: { cooling: '3h' } }); a.turn();
    expect(a.sched.live()).toHaveLength(1);
  });
  it('arms at cooling - alert_before and posts the node-signed default text', async () => {
    const a = setup({ compaction: cfg }); a.turn();
    const [cool, alert] = a.sched.live();
    expect(cool.ms).toBe(10_800_000);
    expect(alert.ms).toBe(10_800_000 - 600_000);
    await a.sched.run(alert);
    expect(a.posts).toEqual(['🗜️ HQ · ana in Team: compaction in 10m']);
  });
  it('uses compaction_alert_notice with {agent} {chat} {in} {percent}', async () => {
    const a = setup({ compaction: cfg, top: { compaction_alert_notice: '{agent}/{chat}: {in} left at {percent}%' } }); a.turn();
    await a.sched.run(a.sched.live()[1]);
    expect(a.posts).toEqual(['🗜️ HQ · ana in Team: ana/Team: 10m left at 19%']);
  });
  it('a blank template posts nothing', async () => {
    const a = setup({ compaction: cfg, top: { compaction_alert_notice: '  ' } }); a.turn();
    await a.sched.run(a.sched.live()[1]);
    expect(a.posts).toEqual([]);
  });
  it('a new turn cancels the pending alert and re-arms it with the cooling timer: one alert, no duplicate', async () => {
    const a = setup({ compaction: cfg }); a.turn();
    const first = a.sched.live()[1];
    a.turn();
    expect(first.live).toBe(false);
    const live = a.sched.live();
    expect(live).toHaveLength(2);
    await a.sched.run(live[1]);
    expect(a.posts).toHaveLength(1);
  });
  it('says nothing when nothing is due at that moment', async () => {
    const a = setup({ compaction: cfg, due: { due: false, tokens: 1000 } }); a.turn();
    await a.sched.run(a.sched.live()[1]);
    expect(a.posts).toEqual([]);
  });
  it('is not armed on the critical (no-wait) path', () => {
    const a = setup({ compaction: { ...cfg, critical_ratio: '800k' }, critical: true }); a.turn();
    expect(a.sched.live()).toHaveLength(1);
    expect(a.sched.live()[0].ms).toBe(0);
  });
  it('is not armed when alert_before >= cooling', () => {
    for (const ab of ['3h', '4h']) { const a = setup({ compaction: { cooling: '3h', alert_before: ab } }); a.turn(); expect(a.sched.live()).toHaveLength(1); }
  });
  it('works at the per-conversation tier too', () => {
    const a = setup({ compaction: { cooling: '3h' }, over: { alert_before: '5m' } }); a.turn();
    expect(a.sched.live()[1].ms).toBe(10_800_000 - 300_000);
  });
});

describe('critical_ratio and warn_gap take sizes through the same parser', () => {
  it('critical_ratio "800k" on a 1M window is honoured; "2m" is rejected', () => {
    let seen = null;
    const mk = (cr) => createCompaction({ pool: { run: async () => ({}) }, scheduler: makeScheduler(), getConfig: () => ({ compaction: { critical_ratio: cr } }), criticalOver: (_t, { ratio }) => { seen = ratio; return false; } });
    mk('800k').afterTurn(TURN); expect(seen).toBeCloseTo(0.8);
    seen = null; mk('2m').afterTurn(TURN); expect(seen).toBeNull();
  });
});
