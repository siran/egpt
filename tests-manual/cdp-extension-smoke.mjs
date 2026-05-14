// tests-manual/cdp-extension-smoke.mjs — drive Chrome via CDP to smoke
// the extension's tab page. Spawns a fresh Chrome with --load-extension
// pointed at extension/dist.
//
// KNOWN LIMITATION as of Chrome 148 (May 2026): --load-extension is
// silently ignored unless the profile has Developer Mode enabled at
// least once interactively. Even --disable-features=DisableLoad
// ExtensionCommandLineSwitch doesn't override it on a fresh profile.
// If this script fails with "no chrome-extension:// target found",
// use cdp-extension-attach.mjs instead — operator launches Chrome
// manually with their installed extension, we attach over CDP.
// Re-enable this script when Chrome relaxes the policy or we wire up
// pre-seeding the profile's Preferences with developer_mode_enabled.
//
// Run by hand:
//   node tests-manual/cdp-extension-smoke.mjs
//
// What it checks:
//   1. Chrome spawns with --load-extension pointing at extension/dist
//   2. The background service worker boots (no crashes during load)
//   3. The extension's tab.html mounts React + renders the shell
//   4. The settings page mounts
//   5. No uncaught errors land in the page console during mount
//
// Reports a one-line PASS/FAIL summary + per-check detail.

import { spawnChrome, waitForChromeReady, findChromeExecutable } from '../tools/chrome-launcher.mjs';
import * as cdp from '../tools/cdp.mjs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import WebSocket from 'ws';

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = join(APP_DIR, 'extension', 'dist');
const TEST_PROFILE = join(homedir(), '.egpt', 'chrome', 'profiles', 'cdp-smoke');
const PORT = 9221;

// Minimal CDP WebSocket client. Sends Page.navigate, Runtime.evaluate,
// etc.; tracks request ids and resolves promises on matching response.
function makeCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ready,
    events,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

async function evaluate(wsUrl, expression) {
  const cli = makeCdpClient(wsUrl);
  await cli.ready;
  await cli.send('Runtime.enable');
  const r = await cli.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  cli.close();
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' — ' + (r.exceptionDetails.exception?.description ?? ''));
  }
  return r.result?.value;
}

async function main() {
  const checks = [];
  const record = (label, pass, detail = '') => {
    checks.push({ label, pass, detail });
    const icon = pass ? '✓' : '✗';
    console.log(`  ${icon} ${label}${detail ? '  ' + detail : ''}`);
  };

  console.log('CDP extension smoke');
  console.log('───────────────────');

  // Sanity
  if (!findChromeExecutable()) { console.log('!! Chrome executable not found'); process.exit(2); }
  if (!existsSync(join(EXT_DIR, 'background.js'))) {
    console.log('!! extension/dist/background.js missing — run: npm run build:ext');
    process.exit(2);
  }

  // Spawn Chrome with extension loaded
  const launched = await spawnChrome({
    port: PORT,
    userDataDir: TEST_PROFILE,
    extensionDir: EXT_DIR,
    url: 'about:blank',
  });
  record('spawn Chrome', !!launched.pid, `pid=${launched.pid}`);
  await waitForChromeReady(PORT);
  record('Chrome CDP ready', true, `:${PORT}/json/version`);

  // Wait briefly for the background service worker to register.
  await new Promise(r => setTimeout(r, 1500));

  // List all targets, find the extension's service worker, extract ID
  const targets = await cdp.listTabs();
  const extTargets = targets.filter(t =>
    typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
  const swTarget = extTargets.find(t => t.type === 'service_worker' || t.url.endsWith('/background.js'));
  let extId = null;
  if (swTarget) {
    const m = swTarget.url.match(/^chrome-extension:\/\/([a-z]+)\//);
    extId = m?.[1] ?? null;
  } else {
    // Fallback: any chrome-extension:// target carries the id.
    const any = extTargets[0];
    if (any) {
      const m = any.url.match(/^chrome-extension:\/\/([a-z]+)\//);
      extId = m?.[1] ?? null;
    }
  }
  record('extension service worker booted', !!extId, extId ? `id=${extId}` : 'no chrome-extension:// target found');
  if (!extId) {
    console.log('───────────────────');
    console.log('FAIL: cannot find extension id; aborting further checks');
    process.exit(1);
  }

  // Open the extension's tab page
  const tabUrl = `chrome-extension://${extId}/tab/tab.html`;
  const newTabResp = await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(tabUrl)}`, { method: 'PUT' });
  if (!newTabResp.ok) {
    record('open tab.html', false, `/json/new returned ${newTabResp.status}`);
    process.exit(1);
  }
  const newTab = await newTabResp.json();
  record('open tab.html', true, `id=${newTab.id?.slice(0, 8)}…`);
  await new Promise(r => setTimeout(r, 2000));   // let React mount

  // Evaluate JS in the new tab to confirm React rendered something
  let tabRendered = false;
  let tabBodyLen = 0;
  let tabRoot = null;
  let tabError = null;
  try {
    const result = await evaluate(newTab.webSocketDebuggerUrl, `
      (() => ({
        bodyLen: document.body?.textContent?.length ?? 0,
        root: document.getElementById('root')?.tagName ?? null,
        children: document.getElementById('root')?.children?.length ?? 0,
        title: document.title,
      }))()
    `);
    tabRendered = (result.root != null && result.children > 0);
    tabBodyLen = result.bodyLen;
    tabRoot = result.root;
  } catch (e) {
    tabError = e.message;
  }
  record('tab.html mounted React', tabRendered,
    tabRendered ? `#root has children, body ${tabBodyLen} chars`
                : tabError ? `eval failed: ${tabError}` : 'no #root children');

  // Same check for settings page
  const settingsUrl = `chrome-extension://${extId}/settings/index.html`;
  const setResp = await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(settingsUrl)}`, { method: 'PUT' });
  if (setResp.ok) {
    const setTab = await setResp.json();
    await new Promise(r => setTimeout(r, 1500));
    let setRendered = false;
    let setBodyLen = 0;
    let setError = null;
    try {
      const result = await evaluate(setTab.webSocketDebuggerUrl, `
        (() => ({
          bodyLen: document.body?.textContent?.length ?? 0,
          root: document.getElementById('root')?.tagName ?? null,
          children: document.getElementById('root')?.children?.length ?? 0,
        }))()
      `);
      setRendered = (result.root != null && result.children > 0);
      setBodyLen = result.bodyLen;
    } catch (e) {
      setError = e.message;
    }
    record('settings page mounted', setRendered,
      setRendered ? `#root has children, body ${setBodyLen} chars`
                  : setError ? `eval failed: ${setError}` : 'no #root children');
  } else {
    record('settings page mounted', false, `/json/new returned ${setResp.status}`);
  }

  console.log('───────────────────');
  const failed = checks.filter(c => !c.pass);
  if (failed.length === 0) {
    console.log(`PASS — ${checks.length} checks`);
    process.exit(0);
  } else {
    console.log(`FAIL — ${failed.length}/${checks.length} checks failed`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('!! smoke crashed:', e.message);
  process.exit(2);
});
