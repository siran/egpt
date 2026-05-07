// tests/cdp.test.mjs — host resolver behavior of tools/cdp.mjs.
//
// The host getter is the dial that decides which Chrome a node talks
// to. Two regressions worth guarding against:
//   * the Stage 2a refactor changed cdpHost() from sync to async; any
//     remaining sync caller would silently get a Promise as cdp host
//     and produce URLs like 'http://[object Promise]/json/list'.
//   * setCdpHostGetter is shared module-level state — the extension
//     installs a chrome.storage-backed getter at boot, the shell
//     installs a disk-based one. If the override slot drifts to a
//     non-getter or accidentally to undefined, every CDP call falls
//     back to localhost:9222 (proxy port without token, 401s).
//
// Each test resets the getter via setCdpHostGetter so they don't
// pollute each other's state.

import { describe, it, beforeEach, expect } from 'vitest';
import * as cdp from '../tools/cdp.mjs';
import * as bus from '../tools/bus.mjs';

describe('cdpHost()', () => {
  beforeEach(() => {
    // Restore the module-default Node disk-based getter that ran at
    // module-load time. We can't access the original directly, so we
    // re-create equivalent behavior: env var > default localhost.
    cdp.setCdpHostGetter(() => {
      return process.env.EGPT_CDP_HOST || 'localhost:9222';
    });
  });

  it('returns a string (not a Promise) when awaited', async () => {
    const host = await cdp.cdpHost();
    expect(typeof host).toBe('string');
    expect(host).toMatch(/^[\w.-]+:\d+/);
  });

  it('honors a custom getter', async () => {
    cdp.setCdpHostGetter(() => 'custom-host:1234');
    expect(await cdp.cdpHost()).toBe('custom-host:1234');
  });

  it('awaits an async getter', async () => {
    cdp.setCdpHostGetter(async () => {
      await new Promise(r => setTimeout(r, 1));
      return 'async-host:5678';
    });
    expect(await cdp.cdpHost()).toBe('async-host:5678');
  });

  it('returns localhost:9222 when no override and no env var', async () => {
    delete process.env.EGPT_CDP_HOST;
    expect(await cdp.cdpHost()).toBe('localhost:9222');
  });

  it('uses EGPT_CDP_HOST when set', async () => {
    process.env.EGPT_CDP_HOST = 'envhost:9999';
    try {
      expect(await cdp.cdpHost()).toBe('envhost:9999');
    } finally {
      delete process.env.EGPT_CDP_HOST;
    }
  });
});

describe('busUrl()', () => {
  beforeEach(() => {
    cdp.setCdpHostGetter(() => 'localhost:9222');
  });

  it('returns http://<host>/bus.html', async () => {
    expect(await bus.busUrl()).toBe('http://localhost:9222/bus.html');
  });

  it('strips a token suffix from cdpHost (proxy uses path-prefix auth)', async () => {
    // Shell-side cdpHost returns 'host:9222/<token>'; the bus is served
    // unauthenticated at /bus.html so the URL needs to drop the token.
    cdp.setCdpHostGetter(() => 'host:9222/deadbeef-token');
    expect(await bus.busUrl()).toBe('http://host:9222/bus.html');
  });

  it('handles a host without a token suffix', async () => {
    cdp.setCdpHostGetter(() => 'someplace.local:1234');
    expect(await bus.busUrl()).toBe('http://someplace.local:1234/bus.html');
  });
});
