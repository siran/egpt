// Per-entity heartbeat config: parsing the heartbeat block and the firing gate.
import { describe, it, expect } from 'vitest';
import { parseHeartbeatConfig, parseCommandHeartbeat, shouldFire, DEFAULT_INTERVAL_MIN, MIN_INTERVAL_MIN } from '../src/heartbeats.mjs';

describe('parseCommandHeartbeat — deterministic command (no AI)', () => {
  it('reads enabled + interval + command + cwd', () => {
    expect(parseCommandHeartbeat('enabled: true\ninterval_min: 60\ncommand: node src/tools/compact-being.mjs --scan\ncwd: C:/x'))
      .toEqual({ enabled: true, intervalMin: 60, command: 'node src/tools/compact-being.mjs --scan', cwd: 'C:/x' });
  });
  it('is DISABLED without a command — a heartbeat that runs nothing does nothing', () => {
    expect(parseCommandHeartbeat('enabled: true\ninterval_min: 60')).toMatchObject({ enabled: false, command: null });
    expect(parseCommandHeartbeat('enabled: true\ncommand: "   "')).toMatchObject({ enabled: false, command: null });
  });
  it('respects enabled:false and defaults a missing interval', () => {
    expect(parseCommandHeartbeat('enabled: false\ncommand: x')).toMatchObject({ enabled: false });
    expect(parseCommandHeartbeat('enabled: true\ncommand: x').intervalMin).toBe(DEFAULT_INTERVAL_MIN);
  });
  it('malformed / empty → disabled, never throws', () => {
    expect(parseCommandHeartbeat('')).toMatchObject({ enabled: false, command: null });
    expect(parseCommandHeartbeat(': : not yaml : :')).toMatchObject({ enabled: false });
    expect(parseCommandHeartbeat(null)).toMatchObject({ enabled: false });
  });
});

describe('parseHeartbeatConfig', () => {
  it('reads enabled + interval from a heartbeat block', () => {
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: true\n  interval_min: 45'))
      .toEqual({ enabled: true, intervalMin: 45 });
  });
  it('absent / blank / non-object → disabled with default interval', () => {
    expect(parseHeartbeatConfig(null)).toEqual({ enabled: false, intervalMin: DEFAULT_INTERVAL_MIN });
    expect(parseHeartbeatConfig('')).toEqual({ enabled: false, intervalMin: DEFAULT_INTERVAL_MIN });
    expect(parseHeartbeatConfig('other: 1')).toEqual({ enabled: false, intervalMin: DEFAULT_INTERVAL_MIN });
  });
  it('enabled must be a literal true (truthy strings do NOT enable)', () => {
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: "yes"').enabled).toBe(false);
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: 1').enabled).toBe(false);
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: false').enabled).toBe(false);
  });
  it('missing / zero / negative interval falls back to the default', () => {
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: true').intervalMin).toBe(DEFAULT_INTERVAL_MIN);
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: true\n  interval_min: 0').intervalMin).toBe(DEFAULT_INTERVAL_MIN);
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: true\n  interval_min: -5').intervalMin).toBe(DEFAULT_INTERVAL_MIN);
  });
  it('a tiny positive interval is floored to MIN_INTERVAL_MIN (no per-tick storm)', () => {
    expect(parseHeartbeatConfig('heartbeat:\n  enabled: true\n  interval_min: 0.01').intervalMin).toBe(MIN_INTERVAL_MIN);
  });
  it('malformed YAML → disabled, does not throw', () => {
    expect(parseHeartbeatConfig('heartbeat: : :\n  - [')).toEqual({ enabled: false, intervalMin: DEFAULT_INTERVAL_MIN });
  });
});

describe('shouldFire', () => {
  const MIN = 60 * 1000;
  it('disabled never fires', () => {
    expect(shouldFire({ enabled: false, intervalMin: 30 }, 0, 1e12)).toBe(false);
  });
  it('never-fired (lastFired=0) fires immediately when enabled', () => {
    expect(shouldFire({ enabled: true, intervalMin: 30 }, 0, 1e12)).toBe(true);
  });
  it('fires only once the interval has elapsed', () => {
    const now = 10_000_000;
    expect(shouldFire({ enabled: true, intervalMin: 30 }, now - 29 * MIN, now)).toBe(false);
    expect(shouldFire({ enabled: true, intervalMin: 30 }, now - 31 * MIN, now)).toBe(true);
  });
  it('defaults interval when omitted', () => {
    const now = 10_000_000;
    expect(shouldFire({ enabled: true }, now - (DEFAULT_INTERVAL_MIN - 1) * MIN, now)).toBe(false);
    expect(shouldFire({ enabled: true }, now - (DEFAULT_INTERVAL_MIN + 1) * MIN, now)).toBe(true);
  });
});
