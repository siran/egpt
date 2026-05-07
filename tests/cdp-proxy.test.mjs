// tests/cdp-proxy.test.mjs — auth & forwarding behavior of the CDP proxy.
//
// The proxy is the membrane between the world and Chrome's CDP. Its job:
//   - serve bus.html unauthenticated to anyone (the page is just HTML)
//   - require the token in the URL path for LAN clients
//   - bypass the token for loopback clients (same security posture as
//     Chrome's own --remote-debugging-port, which is localhost-only)
//   - forward authorized requests to Chrome and rewrite self-referential
//     URLs in the body so remote clients see the proxy address
//
// These tests caught a real regression: the extension switching from
// chrome.debugger to fetch+WebSocket meant it became a tokenless client
// of the proxy. Without the loopback bypass it 401'd on /json/list and
// shell↔extension communication silently broke.
//
// Ground truth without a real Chrome: we run a tiny mock CDP server on
// a free port, hand it to startCdpProxy as chromePort, and assert what
// the proxy returns for each request shape.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { startCdpProxy } from '../tools/cdp-proxy.mjs';

// ── mock chrome ──────────────────────────────────────────────────
//
// Responds to /json/version and /json/list with fixtures whose body
// contains 'localhost:<chromePort>' so the proxy's URL rewrite is
// observable.

function startMockChrome() {
  return new Promise((resolve) => {
    let upgradeWaiter = null;
    const server = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          Browser: 'Mock/1.0',
          webSocketDebuggerUrl: `ws://localhost:${server.address().port}/devtools/browser/abcd`,
        }));
        return;
      }
      if (req.url === '/json/list' || req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([
          {
            id: 'tab1', type: 'page', url: 'http://example.com',
            webSocketDebuggerUrl: `ws://localhost:${server.address().port}/devtools/page/tab1`,
          },
        ]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // WebSocket upgrade — record headers, immediately 101 + close so
    // the proxy sees a clean handshake. Tests that care assert what
    // the upstream chrome saw via nextUpgrade().
    server.on('upgrade', (req, socket) => {
      const captured = { url: req.url, headers: { ...req.headers } };
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
      // Destroy (not end) — the proxy has piped both directions, so
      // a half-close keeps the proxy-side socket parked indefinitely
      // and afterAll() blocks on close().
      socket.destroy();
      if (upgradeWaiter) { upgradeWaiter(captured); upgradeWaiter = null; }
    });
    // Returns a Promise that resolves with the next upgrade request's
    // captured fields. Arm it BEFORE triggering the WS to avoid races.
    server.nextUpgrade = () => new Promise(r => { upgradeWaiter = r; });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Send a raw HTTP/1.1 upgrade request through TCP — Node's built-in
// WebSocket constructor doesn't let us set Origin, but raw TCP does.
function rawWsUpgrade(host, port, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(port, host);
    const headers = {
      Host: `${host}:${port}`,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGVzdC1rZXktMTIzNDU2Nzg=',
      ...extraHeaders,
    };
    const lines = [`GET ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    lines.push('', '');
    sock.on('connect', () => sock.write(lines.join('\r\n')));
    sock.on('error', reject);
    sock.on('close', resolve);
  });
}

// ── shared fixtures ──────────────────────────────────────────────

let mockChrome, proxy, baseUrl, token;

beforeAll(async () => {
  mockChrome = await startMockChrome();
  const chromePort = mockChrome.address().port;
  // proxyPort = 0 lets the OS pick a free port; we read it back below.
  proxy = await startCdpProxy({
    token: 'test-token-deadbeef',
    proxyPort: 0,
    chromePort,
    proxyHost: '127.0.0.1',
    onLog: () => {},  // silence
  });
  baseUrl = `http://127.0.0.1:${proxy.port}`;
  token = proxy.token;
});

afterAll(async () => {
  // Force-close everything. Some upgrade sockets stay parked — between
  // the proxy's piped outgoing TCP and the mock's half-closed sockets,
  // graceful close() can hang for the full hookTimeout. We don't care
  // about clean shutdown in tests; just kill the listeners.
  proxy.stop().catch(() => {});
  mockChrome.closeAllConnections?.();
  mockChrome.close();
}, 2000);

// ── tests ────────────────────────────────────────────────────────

describe('cdp-proxy auth', () => {
  it('serves bus.html unauthenticated', async () => {
    const r = await fetch(`${baseUrl}/bus.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
  });

  it('serves bus.html with the tokened path too', async () => {
    const r = await fetch(`${baseUrl}/${token}/bus.html`);
    expect(r.status).toBe(200);
  });

  it('accepts loopback requests WITHOUT a token (same-host bypass)', async () => {
    // This is the regression test: the extension running inside
    // Chrome talks to the proxy without knowing the token. If this
    // 401s, shell↔extension communication via the bus is broken.
    const r = await fetch(`${baseUrl}/json/list`);
    expect(r.status).toBe(200);
    const tabs = await r.json();
    expect(Array.isArray(tabs)).toBe(true);
    expect(tabs[0]?.id).toBe('tab1');
  });

  it('accepts loopback requests with a tokened path', async () => {
    const r = await fetch(`${baseUrl}/${token}/json/list`);
    expect(r.status).toBe(200);
  });

  it('rewrites localhost:<chromePort> in responses to <host>/<token>', async () => {
    const r = await fetch(`${baseUrl}/${token}/json/list`);
    const text = await r.text();
    // Body should NOT mention the private chromePort.
    expect(text).not.toMatch(new RegExp(`localhost:${mockChrome.address().port}`));
    // It SHOULD include the token-prefixed form.
    expect(text).toContain(`/${token}/`);
  });

  // Note on token rejection for LAN clients: vitest runs in-process,
  // so we can't fake a remote address — every fetch we issue arrives
  // from 127.0.0.1 and hits the loopback bypass. LAN auth (the
  // 'wrong token from a remote IP returns 401' case) needs validation
  // on a real LAN or a test that exposes the predicate directly. The
  // loopback bypass test above is the regression coverage that
  // matters for the shell↔extension breakage.
});

describe('cdp-proxy forwarding', () => {
  it('forwards /json/version', async () => {
    const r = await fetch(`${baseUrl}/${token}/json/version`);
    expect(r.status).toBe(200);
    const v = await r.json();
    expect(v.Browser).toBe('Mock/1.0');
  });

  it('returns 404 for paths Chrome does not serve', async () => {
    const r = await fetch(`${baseUrl}/${token}/no-such-path`);
    expect(r.status).toBe(404);
  });

  it('strips Origin from forwarded WebSocket upgrades', async () => {
    // The regression: Chrome 112+ rejects CDP WS upgrades whose
    // Origin isn't in --remote-allow-origins. The extension's
    // chrome-extension://<id> origin used to make it through to
    // Chrome unfiltered, and Chrome closed the upgrade — surfaced
    // to the user as 'CDP WS error opening tab' in the tab UI.
    const upgrade = mockChrome.nextUpgrade();
    rawWsUpgrade('127.0.0.1', proxy.port, `/${token}/devtools/browser/abcd`, {
      Origin: 'chrome-extension://malicious-fake',
    }).catch(() => {});  // fire-and-forget; we only care about what reached upstream
    const captured = await upgrade;
    expect(captured.url).toBe('/devtools/browser/abcd');
    expect(captured.headers.origin, 'origin must be stripped before forwarding to Chrome').toBeUndefined();
    expect(captured.headers.upgrade?.toLowerCase()).toBe('websocket');
  }, 3000);

  it('strips Origin on loopback WS too (no-token path)', async () => {
    const upgrade = mockChrome.nextUpgrade();
    rawWsUpgrade('127.0.0.1', proxy.port, '/devtools/browser/abcd', {
      Origin: 'chrome-extension://abc',
    }).catch(() => {});
    const captured = await upgrade;
    expect(captured.headers.origin).toBeUndefined();
  }, 3000);
});
