// lag-probe.test.mjs — the spine's event-loop lag probe (operator 2026-10-18, "1, do probe").
// 2026-10-15: the spine fell 2+ min behind for every chat and nobody knew until "E isn't answering".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLagProbe, parseTypeperf, parsePs, sleptBetween } from '../src/spine/lag-probe.mjs';
import { createSpine } from '../src/spine/spine.mjs';

const TOP = [{ name: 'whisper-cli', pct: 610 }, { name: 'node', pct: 104 }, { name: 'chrome', pct: 30 }];

// Every source the probe reads, faked: the loop delay window, this process's CPU (1.04 cores), the
// event loop's busy share (99%), 8 cores at 97%, memory, the backlog, the top processes.
function harness({ cfg = null, backlog = null } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 15, 14, 0));
  const h = { lag: 0, posted: [], logged: [], topCalls: 0, fast: { queueDepth: 3, oldestMs: 2_000 }, turns: [], suspended: 0, sleeps: [], logReads: [], logFails: null, logMs: 0 };
  h.probe = createLagProbe({
    config: () => cfg,
    report: async (text) => { h.posted.push(text); },
    note: (s) => h.logged.push(s),
    backlog: backlog ?? (() => ({ fast: h.fast, turns: h.turns })),
    loop: { sample: () => ({ p50: 1, p99: h.lag, max: h.lag }), summary: () => ({ p50: 2, p99: 30, max: 300 }), stop() {} },
    cpuUsage: () => ({ user: Date.now() * 1040, system: 0 }),
    elu: (a, b) => (b ? { utilization: 0.99 } : { idle: 0, active: 0 }),
    cpus: () => Array.from({ length: 8 }, () => ({ times: { user: Date.now() * 0.97, nice: 0, sys: 0, irq: 0, idle: Date.now() * 0.03 } })),
    memory: () => ({ rss: 512 * 2 ** 20, free: 3 * 2 ** 30, total: 32 * 2 ** 30 }),
    top: async () => { h.topCalls++; return TOP; },
    mono: () => Date.now() - h.suspended,
    sleepLog: async (from, to) => {   // the System log: h.sleeps are Kernel-Power 506/507 times
      h.logReads.push([from, to]);
      if (h.logMs) await new Promise((r) => setTimeout(r, h.logMs));
      if (h.logFails) throw h.logFails;
      return h.sleeps.some((at) => at >= from && at <= to);
    },
  });
  return h;
}
const step = (s) => vi.advanceTimersByTimeAsync(s);
afterEach(() => { vi.useRealTimers(); });

describe('lag probe: alert, repeat, recover', () => {
  it('lag over the threshold → ONE logging-group line with the attribution', async () => {
    const h = harness();
    h.turns = [['e:whatsapp:!fiona:beeper.local', 3], ['e:whatsapp:!x:beeper.local', 1]];
    h.probe.start();
    h.lag = 9_999;
    await step(5_000);
    expect(h.posted).toEqual([]);
    h.lag = 12_000;
    await step(5_000);
    expect(h.posted).toHaveLength(1);
    const line = h.posted[0];
    expect(line).toMatch(/^spine lagging 12s — /);
    expect(line).toContain('loop max 12s p99 12s, busy 99%');
    expect(line).toContain('fast queue 3 (oldest 2.0s)');
    expect(line).toContain('turns 2 chats/4');
    expect(line).toContain('spine CPU 104% rss 512MB');
    expect(line).toContain('node CPU 97% of 8 cores, free 3.0/32.0GB');
    expect(line).toContain('top whisper-cli 610%, node 104%, chrome 30%');
    expect(h.logged).toContain(line);   // the node log has it too
    await step(5_000);
    expect(h.posted).toHaveLength(1);   // still lagging: no second line
    h.probe.stop();
  });

  it('persists → no repeat before 10 min, one at 10 min; top processes once per alert, not per sample', async () => {
    const h = harness();
    h.probe.start();
    h.lag = 12_000;
    await step(5_000);
    expect(h.posted).toHaveLength(1);
    await step(10 * 60_000 - 5_000);
    expect(h.posted).toHaveLength(1);
    expect(h.topCalls).toBe(1);
    await step(5_000);
    expect(h.posted).toHaveLength(2);
    expect(h.posted[1]).toMatch(/^spine still lagging 12s \(for 10m, worst 12s\) — loop max/);
    expect(h.topCalls).toBe(2);
    h.probe.stop();
  });

  it('clears → one "recovered" line after a clean minute; a flap inside that minute is the same episode', async () => {
    const h = harness();
    h.probe.start();
    h.lag = 15_000;
    await step(5_000);                   // t=5s: alert
    h.lag = 0;
    await step(30_000);
    h.lag = 11_000;                      // t=40s: relapse inside the clean minute — no new alert
    await step(5_000);
    h.lag = 0;
    await step(60_000);                  // clean from t=45s; t=100s is 55s clean
    expect(h.posted).toHaveLength(1);
    await step(5_000);                   // t=105s: a clean minute
    expect(h.posted).toHaveLength(2);
    expect(h.posted[1]).toBe('spine recovered after 40s (worst 15s)');
    await step(5 * 60_000);
    expect(h.posted).toHaveLength(2);    // one recovered line, then quiet
    h.lag = 20_000;
    await step(5_000);
    expect(h.posted).toHaveLength(3);    // a new episode alerts again
    expect(h.posted[2]).toMatch(/^spine lagging 20s — /);
    h.probe.stop();
  });

  it('the fast pump falling behind is lag too, even with a quiet loop', async () => {
    const h = harness();
    h.probe.start();
    h.fast = { queueDepth: 14, oldestMs: 130_000 };
    await step(5_000);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatch(/^spine lagging 130s — loop max 0ms p99 0ms, busy 99% · fast queue 14 \(oldest 130s\)/);
    h.probe.stop();
  });

  it('config lag_probe.threshold_ms / every_ms are read live', async () => {
    const cfg = { threshold_ms: 2_000, every_ms: 1_000 };
    const h = harness({ cfg });
    h.probe.start();
    h.lag = 3_000;
    await step(1_000);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatch(/^spine lagging 3\.0s — /);
    h.probe.stop();
  });

  it('a failing top-processes read still posts the line, without the top', async () => {
    const h = harness();
    h.probe = createLagProbe({ report: async (t) => { h.posted.push(t); }, note: (s) => h.logged.push(s), loop: { sample: () => ({ p50: 0, p99: 0, max: 11_000 }), summary: () => ({ p50: 0, p99: 0, max: 0 }) }, top: async () => { throw new Error('typeperf missing'); }, sleepLog: async () => false });
    h.probe.start();
    await step(5_000);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).not.toContain(' · top ');
    expect(h.logged.some((l) => l.includes('typeperf missing'))).toBe(true);
    h.probe.stop();
  });
});

// kg 2026-10-20: Modern Standby 04:06 → 07:38 (Kernel-Power 506/507) posted "spine lagging 12670s" + "recovered".
describe('lag probe: asleep is not lag', () => {
  const GAP = 12_670_000;
  const hm = (ms) => new Date(ms).toTimeString().slice(0, 5);
  const sleepThrough = async (h, { mono = true } = {}) => {   // a gap the probe's timer slept through
    await step(5_000);
    const from = Date.now();
    if (!mono) h.suspended += GAP;
    vi.setSystemTime(from + GAP);
    h.lag = GAP;
    await step(5_000);
    h.lag = 0;
    return { from, to: Date.now() };
  };

  it('Windows: a standby logged inside the gap → one 💤 line, no lagging, no recovered', async () => {
    const h = harness();
    h.probe.start();
    h.sleeps = [Date.now() + 6_000, Date.now() + 5_000 + GAP + 2_000];
    const { from, to } = await sleepThrough(h);
    await step(5 * 60_000);
    expect(h.posted).toEqual([`💤 was asleep 3h31m (${hm(from)} → ${hm(to)})`]);
    expect(h.logReads).toEqual([[from, to]]);
    h.probe.stop();
  });

  it('wall clock ≫ monotonic (Linux/macOS suspend) → 💤 without reading the event log', async () => {
    const h = harness();
    h.probe.start();
    const { from, to } = await sleepThrough(h, { mono: false });
    await step(5 * 60_000);
    expect(h.posted).toEqual([`💤 was asleep 3h31m (${hm(from)} → ${hm(to)})`]);
    expect(h.logReads).toEqual([]);
    h.probe.stop();
  });

  it('a 19s lag with no sleep in its window → "spine lagging" then "recovered", as before', async () => {
    const h = harness();
    h.probe.start();
    await step(5_000);
    h.sleeps = [Date.now() - 1];             // a wake just before the window does not count
    h.lag = 19_000;
    await step(5_000);
    h.lag = 0;
    await step(65_000);
    expect(h.posted).toHaveLength(2);
    expect(h.posted[0]).toMatch(/^spine lagging 19s — loop max 19s p99 19s, busy 99%/);
    expect(h.posted[1]).toBe('spine recovered after 5.0s (worst 19s)');
    h.probe.stop();
  });

  it('the event log failing or timing out → the lag alert, as before', async () => {
    const h = harness();
    h.logFails = new Error('Command failed: wevtutil (timed out)');
    h.probe.start();
    await sleepThrough(h);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatch(/^spine lagging 12670s — /);
    expect(h.logged).toContain('lag probe: sleep check failed — Command failed: wevtutil (timed out)');
    await step(65_000);
    expect(h.posted[1]).toMatch(/^spine recovered after /);
    h.probe.stop();
  });

  it('after a 💤, a real lag in a later sample still alerts (samples wait behind a slow event-log read)', async () => {
    const h = harness();
    h.logMs = 7_000;
    h.probe.start();
    h.sleeps = [Date.now() + 5_000 + GAP + 2_000];
    await sleepThrough(h);
    await step(60_000);
    expect(h.posted).toEqual([expect.stringMatching(/^💤 was asleep 3h31m /)]);
    h.lag = 19_000;
    await step(5_000 + 7_000);
    expect(h.posted).toHaveLength(2);
    expect(h.posted[1]).toMatch(/^spine lagging 19s — /);
    h.probe.stop();
  });
});

describe('lag probe: slowest steps', () => {
  it('keeps the 5 slowest (name, chat, ms); sync, async and throwing steps all count', async () => {
    const h = harness();
    const ev = (n) => ({ chatId: `!${n}:beeper.local`, chatName: n });
    const wait = (ms) => () => new Promise((r) => setTimeout(r, ms));
    for (const [name, chat, ms] of [['classify', 'A', 100], ['transcript', 'B', 7_000], ['act', 'C', 300], ['refresh', null, 2_000], ['classify', 'D', 50], ['transcript', 'E', 900]]) {
      const p = h.probe.time(name, chat ? ev(chat) : null, wait(ms));
      await step(ms);
      await p;
    }
    expect(h.probe.time('identity', ev('F'), () => 42)).toBe(42);
    await expect(h.probe.time('link', ev('G'), () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(() => h.probe.time('config', null, () => { throw new Error('sync boom'); })).toThrow('sync boom');
    expect(h.probe.slowest()).toEqual([
      { name: 'transcript', chat: 'B', ms: 7_000 },
      { name: 'refresh', chat: '-', ms: 2_000 },
      { name: 'transcript', chat: 'E', ms: 900 },
      { name: 'act', chat: 'C', ms: 300 },
      { name: 'classify', chat: 'A', ms: 100 },
    ]);
  });

  it('the alert names the slowest steps, a step still running, and the busiest turn chat by name', async () => {
    const h = harness();
    h.turns = [['e:whatsapp:!fiona:beeper.local', 3]];
    h.probe.start();
    const p = h.probe.time('transcript', { chatId: '!b:beeper.local', chatName: 'Bea' }, () => new Promise((r) => setTimeout(r, 3_000)));
    await step(3_000); await p;
    h.probe.time('classify', { chatId: '!fiona:beeper.local', chatName: 'Fiona Ejemplar' }, () => new Promise(() => {}));   // t=3s, never settles
    await step(30_000);
    expect(h.posted).toEqual([]);
    h.lag = 31_000;
    await step(2_000);                   // t=35s: the sample that alerts
    const line = h.posted[0];
    expect(line).toContain('in classify@Fiona Ejemplar 32s');
    expect(line).toContain('most e@Fiona Ejemplar ×3');
    expect(line).toMatch(/ · slowest transcript@Bea 3\.0s$/);
    h.probe.stop();
  });
});

describe('lag probe: 5-min baseline', () => {
  it('one summary line to the node log every 5 min, nothing to the logging group', async () => {
    const h = harness();
    h.probe.start();
    const p = h.probe.time('transcript', { chatId: '!b:beeper.local', chatName: 'Bea' }, () => new Promise((r) => setTimeout(r, 412)));
    await step(412); await p;
    await step(5 * 60_000 - 412);
    const sums = () => h.logged.filter((l) => l.startsWith('lag 5m:'));
    expect(sums()).toEqual(['lag 5m: p50 2ms p99 30ms max 300ms · busy 99% · spine CPU 104% rss 512MB · node CPU 97% · fast queue max 3 · slowest transcript@Bea 412ms']);
    expect(h.posted).toEqual([]);
    await step(5 * 60_000);
    expect(sums()).toHaveLength(2);
    expect(sums()[1]).not.toContain('slowest');   // the window rolled
    h.probe.stop();
  });
});

describe('lag probe: wired into the spine', () => {
  it('handleInbound times the fast-phase steps per chat', async () => {
    const h = harness();
    let cb = null;
    const bridge = { onMessage(fn) { cb = fn; }, send() {}, stop() {} };
    const transcript = { log: () => new Promise((r) => setTimeout(r, 2_500)) };
    const spine = createSpine({
      bridge, brain: { async turn() { return { text: '' }; } },
      identity: { build: (msg) => ({ ...msg, line: msg.body }) }, router: { resolve: () => 'e' },
      gating: { async decide() { return { mode: 'mute', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false },
      sender: { open() { return { update() {}, fail() {}, async finish() {} }; } },
      transcript, heartbeats: { runDue() {} }, probe: h.probe,
    });
    const done = spine.handleInbound({ body: 'hola', chatId: '!fiona:beeper.local', chatName: 'Fiona', surface: 'whatsapp', senderId: 'u1', mention: {} });
    await step(2_500);
    await done;
    const names = h.probe.slowest().map((s) => `${s.name}@${s.chat}`);
    expect(h.probe.slowest()[0]).toEqual({ name: 'transcript', chat: 'Fiona', ms: 2_500 });
    expect(names).toEqual(expect.arrayContaining(['classify@Fiona', 'refresh@-', 'config@-']));
    expect(cb).toBe(null);   // never started: handleInbound alone drives it
  });
});

describe('sleptBetween: the Windows System log', () => {
  it('Kernel-Power 506/507 or Power-Troubleshooter 1 inside [from, to] → asleep; other platforms never ask', async () => {
    const calls = [];
    const exec = async (cmd, args) => { calls.push([cmd, ...args]); return calls.length === 1 ? 'Event[0]:\r\n  Log Name: System\r\n' : ''; };
    const from = Date.UTC(2026, 9, 20, 8, 7, 42), to = Date.UTC(2026, 9, 20, 11, 38, 55);
    expect(await sleptBetween(from, to, { platform: 'win32', exec })).toBe(true);
    expect(await sleptBetween(from, to, { platform: 'win32', exec })).toBe(false);
    expect(calls[0].slice(0, 3)).toEqual(['wevtutil', 'qe', 'System']);
    expect(calls[0][3]).toContain("(Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=506 or EventID=507)) or (Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1)");
    expect(calls[0][3]).toContain("TimeCreated[@SystemTime>='2026-10-20T08:07:42.000Z' and @SystemTime<='2026-10-20T11:38:55.000Z']");
    expect(await sleptBetween(from, to, { platform: 'linux', exec })).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe('top processes parsing', () => {
  it('typeperf CSV → name + % of one core, minus _Total / Idle / typeperf itself', () => {
    const csv = [
      '',
      '"(PDH-CSV 4.0)","\\\\REVE\\Process(Idle)\\% Processor Time","\\\\REVE\\Process(_Total)\\% Processor Time","\\\\REVE\\Process(whisper-cli)\\% Processor Time","\\\\REVE\\Process(node#2)\\% Processor Time","\\\\REVE\\Process(foo (x86))\\% Processor Time","\\\\REVE\\Process(typeperf)\\% Processor Time"',
      '"10/15/2026 14:00:01.000","1400.0","1583.8","610.5","104.2","3.1","12.0"',
      'Exiting, please wait...',
    ].join('\r\n');
    expect(parseTypeperf(csv)).toEqual([{ name: 'whisper-cli', pct: 610.5 }, { name: 'node#2', pct: 104.2 }, { name: 'foo (x86)', pct: 3.1 }]);
    expect(parseTypeperf('Error: no such counter')).toEqual([]);
  });
  it('ps -Ao pcpu=,comm= → name + %', () => {
    expect(parsePs(' 98.0 /usr/bin/whisper-cli\n  4.5 node\n')).toEqual([{ name: 'whisper-cli', pct: 98 }, { name: 'node', pct: 4.5 }]);
  });
});
