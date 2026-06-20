import { describe, expect, it, vi } from 'vitest';
import { createTelegramBootScheduler } from '../src/spine-telegram-boot.mjs';

describe('spine telegram boot scheduler', () => {
  it('starts the bridge after the boot delay when nobody else is polling', async () => {
    vi.useFakeTimers();
    const calls = [];
    const scheduler = createTelegramBootScheduler({
      startTgBridge: () => calls.push('start'),
      getPeers: () => [],
      getBusTargetId: () => null,
      postEvent: async () => calls.push('handoff'),
      setTimeoutFn: global.setTimeout,
      clearTimeoutFn: global.clearTimeout,
    });

    scheduler.scheduleBootAttempt();
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['start']);
    expect(scheduler.isBootAttempted()).toBe(true);
    vi.useRealTimers();
  });

  it('yields to a chrome peer by posting a handoff before retrying', async () => {
    vi.useFakeTimers();
    const calls = [];
    const scheduler = createTelegramBootScheduler({
      startTgBridge: () => calls.push('start'),
      getPeers: () => [{ role: 'chrome', polling: true }],
      getBusTargetId: () => 'bus-123',
      postEvent: async (_tid, ev) => { calls.push(`post:${ev.type}:${ev.to}`); },
      nodeId: 'reve',
      setTimeoutFn: global.setTimeout,
      clearTimeoutFn: global.clearTimeout,
    });

    scheduler.scheduleBootAttempt();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual(['post:telegram-handoff:reve']);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toEqual(['post:telegram-handoff:reve', 'start']);
    vi.useRealTimers();
  });

  it('does not schedule while the bridge is already running', async () => {
    vi.useFakeTimers();
    const calls = [];
    const scheduler = createTelegramBootScheduler({
      startTgBridge: () => calls.push('start'),
      isBridgeRunning: () => true,
      setTimeoutFn: global.setTimeout,
      clearTimeoutFn: global.clearTimeout,
    });

    scheduler.scheduleBootAttempt();
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });

  it('can cancel a scheduled attempt before it fires', async () => {
    vi.useFakeTimers();
    const calls = [];
    const scheduler = createTelegramBootScheduler({
      startTgBridge: () => calls.push('start'),
      setTimeoutFn: global.setTimeout,
      clearTimeoutFn: global.clearTimeout,
    });

    scheduler.scheduleBootAttempt();
    scheduler.cancelBootAttempt();
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });
});
