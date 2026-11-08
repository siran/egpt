// warm.idle_ttl_by_class as boot hands it to the pool (operator 2026-11-08): a chatbox is a
// conversation unless it names its own TTL — never the idle_ttl_ms fallback.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { warmTtlByClass } from '../src/spine/boot.mjs';
import { createWarmPool } from '../src/warm-sessions.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('warmTtlByClass — the chatbox TTL', () => {
  it('defaults to the conversation TTL (the boot defaults)', () => {
    const t = warmTtlByClass({});
    expect(t.chatbox).toBe(900_000);
    expect(t).toMatchObject({ system: 43_200_000, resident: 43_200_000, conversation: 900_000, sibling: 43_200_000 });
  });

  it('follows a configured conversation TTL, never the idle_ttl_ms fallback', () => {
    expect(warmTtlByClass({ warm: { idle_ttl_ms: 1_800_000, idle_ttl_by_class: { conversation: 60_000 } } }).chatbox).toBe(60_000);
  });

  it('a configured chatbox TTL wins', () => {
    expect(warmTtlByClass({ warm: { idle_ttl_by_class: { conversation: 60_000, chatbox: 5_000 } } })).toEqual({ conversation: 60_000, chatbox: 5_000 });
  });

  it('drives the pool: a chatbox session idles out on the conversation TTL', async () => {
    const closed = [];
    const pool = createWarmPool({
      makeSession: () => ({ close() { closed.push(1); }, turn: async () => ({ text: 'ok' }) }),
      idleTtlMs: 10_000,
      idleTtlByClass: warmTtlByClass({ warm: { idle_ttl_by_class: { conversation: 20 } } }),
    });
    await pool.run('box', 'a', () => {}, { klass: 'chatbox' });
    await sleep(60);
    expect(pool.has('box')).toBe(false);
    expect(closed).toHaveLength(1);
  });
});

// Class TTLs speak the per-conversation idle_ttl grammar (parseWarmBlock): ms, "15m", "2h", 0, -1.
describe('warmTtlByClass — durations', () => {
  afterEach(() => { vi.useRealTimers(); });
  const pool = (cfg, onLog) => createWarmPool({
    makeSession: () => ({ close() {}, turn: async () => ({ text: 'ok' }) }),
    idleTtlMs: 1_800_000,
    idleTtlByClass: warmTtlByClass(cfg, onLog),
  });

  it('{ conversation: "15m" } keeps the session 15 minutes, not 1 ms', async () => {
    vi.useFakeTimers();
    const p = pool({ warm: { idle_ttl_by_class: { conversation: '15m' } } });
    await p.run('k', 'a', () => {}, { klass: 'conversation' });
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1_000);
    expect(p.has('k')).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.has('k')).toBe(false);
  });

  it('parses "2h", keeps -1 and 0, and a chatbox follows the parsed conversation TTL', () => {
    expect(warmTtlByClass({ warm: { idle_ttl_by_class: { conversation: '15m', sibling: '2h', system: -1, resident: 0 } } }))
      .toEqual({ conversation: 900_000, chatbox: 900_000, sibling: 7_200_000, system: -1, resident: 0 });
  });

  it('an unparseable value logs one line and the class falls back as if absent', async () => {
    vi.useFakeTimers();
    const logs = [];
    const t = warmTtlByClass({ warm: { idle_ttl_by_class: { conversation: 'soon', sibling: 60_000 } } }, (m) => logs.push(m));
    expect(t).toEqual({ chatbox: undefined, sibling: 60_000 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/idle_ttl_by_class\.conversation.*"soon"/);
    const p = pool({ warm: { idle_ttl_by_class: { conversation: 'soon' } } }, () => {});
    await p.run('k', 'a', () => {}, { klass: 'conversation' });
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(p.has('k')).toBe(true);                     // idle_ttl_ms (30m), never NaN → 1 ms
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(p.has('k')).toBe(false);
  });
});
