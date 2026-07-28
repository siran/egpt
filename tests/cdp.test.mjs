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

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as cdp from '../src/tools/cdp.mjs';
import * as bus from '../src/tools/bus.mjs';

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

// fetchJson's deadline (exercised through isRunning/listTabs — its only callers'
// public surface) — the live bug this locks: a dead Chrome whose port 9221 is
// still LISTENING (held by the zombie PID) makes a TCP connect SUCCEED and then
// never answers the HTTP request. A bare `fetch` with no deadline waits on that
// forever, so isRunning()'s try/catch never fires (a hang is not a rejection) and
// every CDP caller (tabsReport, chromeReport, /open, /tab, /close) hangs with it.
describe('fetchJson deadline — a half-open CDP port must fail fast, not hang', () => {
  // Mimics real fetch's contract under AbortController: never settles on its own,
  // rejects with an AbortError once the caller's signal fires — exactly what a
  // zombie Chrome (port open, no response) looks like from fetchJson's side.
  const hangingFetch = () => vi.fn((url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }));

  beforeEach(() => {
    cdp.setCdpHostGetter(() => 'localhost:9221');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('REPRODUCE-FIRST: a fetch that never settles fails within the deadline instead of hanging forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    // Attach the assertions (which register the rejection handler) BEFORE advancing
    // the fake clock, so the promise is never observably unhandled mid-flight.
    const runningExpectation = expect(cdp.isRunning()).resolves.toBe(false);       // caught, not hung
    const tabsExpectation = expect(cdp.listTabs()).rejects.toThrow(/didn't answer within 3000ms/);
    await vi.advanceTimersByTimeAsync(3000);   // the deadline (FETCH_TIMEOUT_MS in cdp.mjs)

    await runningExpectation;
    await tabsExpectation;
  });

  it('a normal response still works', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'AAA', type: 'page', url: 'https://example.com' }],
    })));
    const tabs = await cdp.listTabs();
    expect(tabs).toEqual([{ id: 'AAA', type: 'page', url: 'https://example.com' }]);
  });

  it('a closed port (immediate rejection) still gives the existing "Cannot reach Chrome" message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    }));
    await expect(cdp.listTabs()).rejects.toThrow(/Cannot reach Chrome at localhost:9221/);
  });

  it('a timeout gives a DISTINCT message — the port answered the connect, not the request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const timeoutExpectation = expect(cdp.listTabs()).rejects.toThrow(/accepted the connection but didn't answer within 3000ms/);
    await vi.advanceTimersByTimeAsync(3000);
    await timeoutExpectation;
  });
});
