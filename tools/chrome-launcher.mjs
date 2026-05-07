// tools/chrome-launcher.mjs — locate and spawn Chrome for the egpt shell.
//
// One Chrome per host: same browser hosts the bus.html tab, the brain tabs
// (chatgpt, claude logged in to the persistent profile), and the egpt
// extension (loaded via --load-extension). Both shell (CDP-over-proxy)
// and extension (chrome.debugger) attach to the same bus tab so events
// actually cross between surfaces — separate Chromes give each surface
// its own bus.html instance with its own JS heap, and they never see each
// other's posts.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const CHROME_PATHS = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

export function findChromeExecutable() {
  const candidates = CHROME_PATHS[process.platform] ?? [];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/**
 * Spawn Chrome detached so it survives this Node process exiting.
 * Returns immediately — call waitForChromeReady() to know when CDP is up.
 *
 * @param {object} opts
 * @param {number} opts.port          - --remote-debugging-port (private, localhost-only)
 * @param {string} opts.userDataDir   - persistent profile directory
 * @param {string} [opts.extensionDir]- absolute path to unpacked extension (loaded via --load-extension)
 * @param {string} [opts.url]         - initial URL (default: about:blank)
 */
export async function spawnChrome({ port, userDataDir, extensionDir, url = 'about:blank' }) {
  const chrome = findChromeExecutable();
  if (!chrome) throw new Error('Chrome executable not found in standard locations');
  await mkdir(userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    // Chrome 112+ rejects CDP WebSocket upgrades unless Origin is
    // either absent or in --remote-allow-origins. The egpt extension
    // talks to the bus tab from chrome-extension://<id>; the bridges
    // and brain CDP code talk from a Node process (no Origin header).
    // '*' covers both. Connections to chromePort are still localhost-
    // only; the proxy on PROXY_PORT is what gates LAN access.
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--disable-features=ChromeWhatsNewUI',
    '--silent-debugger-extension-api',
    '--new-window',
  ];
  if (extensionDir) {
    // --load-extension loads the extension for this browser session even if
    // it isn't permanently installed in the profile. We do NOT pass
    // --disable-extensions-except — that would suppress every other
    // extension the user installed in this profile (password manager,
    // ad blocker, etc.) and make spawned Chrome look different from a
    // manual launch. Users who want the egpt extension to persist across
    // manual launches should install it via chrome://extensions →
    // Developer Mode → Load unpacked → extension/dist.
    args.push(`--load-extension=${extensionDir}`);
  }
  args.push(url);

  const child = spawn(chrome, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid };
}

/**
 * Poll Chrome's /json/version until it responds or timeout elapses.
 * @param {number} port
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<object>} the parsed /json/version response
 */
export async function waitForChromeReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) { lastErr = e; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome not ready on :${port} after ${timeoutMs}ms${lastErr ? ` (${lastErr.message})` : ''}`);
}
