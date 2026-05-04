#!/usr/bin/env node
// tools/cdp-proxy.mjs — token-authenticated reverse proxy for Chrome DevTools Protocol.
//
// Chrome listens on CHROME_PORT (9221, localhost-only).
// Proxy listens on PROXY_PORT (9222, LAN-accessible) and requires a secret
// token in the URL path:
//
//   HTTP:  http://host:9222/<token>/json/version  → http://localhost:9221/json/version
//   WS:    ws://host:9222/<token>/devtools/…      → ws://localhost:9221/devtools/…
//
// The proxy rewrites localhost:9221 → <request-host>/<token> in JSON responses
// so that webSocketDebuggerUrl values are usable from remote machines too.
//
// Token lives in ~/.egpt/cdp-token (created on first run, chmod 600).

import { createServer }     from 'node:http';
import { createConnection } from 'node:net';
import { randomBytes }      from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join }    from 'node:path';
import { homedir }          from 'node:os';
import { fileURLToPath }    from 'node:url';

const EGPT_HOME   = join(homedir(), '.egpt');
const TOKEN_FILE  = join(EGPT_HOME, 'cdp-token');
const PROXY_DIR   = dirname(fileURLToPath(import.meta.url));
const BUS_HTML_PATH = join(PROXY_DIR, 'bus.html');

export function loadOrCreateToken() {
  mkdirSync(EGPT_HOME, { recursive: true });
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  const token = randomBytes(16).toString('hex');
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

export function startCdpProxy({
  token       = loadOrCreateToken(),
  proxyPort   = parseInt(process.env.PROXY_PORT  ?? '9222', 10),
  chromePort  = parseInt(process.env.CHROME_PORT ?? '9221', 10),
  proxyHost   = process.env.PROXY_HOST ?? '0.0.0.0',
  onLog       = console.log,
} = {}) {

  const prefix = `/${token}`;

  // ── HTTP handler ───────────────────────────────────────────────
  // Set of paths that serve the bus log. We accept both the bare form
  // (/bus.html) and the tokened form (/<token>/bus.html) so both the
  // extension (which doesn't know the token) and the shell (which does)
  // can resolve the same URL. Posting events requires a CDP attach to
  // the tab, which still goes through the token-protected layer.
  const busPaths = new Set([
    '/bus.html', '/bus', '/bus/',
    `${prefix}/bus.html`, `${prefix}/bus`, `${prefix}/bus/`,
  ]);

  const server = createServer(async (req, res) => {
    // Static bus log — served unauthenticated. See note above.
    if (req.url && busPaths.has(req.url)) {
      try {
        const html = readFileSync(BUS_HTML_PATH, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        }).end(html);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end(`bus.html missing: ${e.message}`);
      }
      return;
    }

    if (!req.url?.startsWith(prefix + '/') && req.url !== prefix) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized');
      return;
    }
    const path = req.url.slice(prefix.length) || '/';

    try {
      const upstream = await fetch(`http://localhost:${chromePort}${path}`);
      const body     = await upstream.text();

      // Rewrite Chrome's self-referential URLs so remote clients get
      // addresses pointing at the proxy, not at Chrome's private port.
      const clientHost = req.headers['host'] ?? `localhost:${proxyPort}`;
      const rewritten  = body.replaceAll(
        `localhost:${chromePort}`,
        `${clientHost}/${token}`,
      );

      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      }).end(rewritten);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`Chrome unreachable: ${e.message}`);
    }
  });

  // ── WebSocket tunnel ───────────────────────────────────────────
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith(prefix + '/') && req.url !== prefix) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const path     = req.url.slice(prefix.length) || '/';
    const upstream = createConnection(chromePort, 'localhost');

    upstream.on('connect', () => {
      // Reconstruct the HTTP upgrade request for Chrome.
      const hdrs = Object.entries(req.headers)
        .filter(([k]) => k !== 'host')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      upstream.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${chromePort}\r\n${hdrs}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    const teardown = () => {
      try { socket.destroy();   } catch {}
      try { upstream.destroy(); } catch {}
    };
    upstream.on('error', teardown);
    socket.on('error',   teardown);
  });

  return new Promise((resolve, reject) => {
    server.listen(proxyPort, proxyHost, () => {
      onLog(`CDP proxy ready`);
      onLog(`  token:  ${token}`);
      onLog(`  proxy:  http://localhost:${proxyPort}/${token}/json`);
      onLog(`  chrome: http://localhost:${chromePort}/json  (private)`);
      resolve({
        token,
        port: proxyPort,
        stop: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ── standalone entry point ─────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startCdpProxy().catch(e => { console.error(e.message); process.exit(1); });
}
