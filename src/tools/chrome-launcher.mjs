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
 * The exact flag set spawnChrome uses — extracted so a caller can RENDER the
 * command line without spawning (the spine's /chrome hands it to the operator to
 * run in their own session; see src/spine/commands.mjs). One source for the flags:
 * spawnChrome builds its argv from here, so the printed line and the spawned
 * process can never drift apart.
 *
 * @param {object} opts               - same shape as spawnChrome's
 * @returns {string[]} argv after the executable
 */
export function chromeArgs({ port, userDataDir, extensionDir, url = 'about:blank' }) {
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
    // Chrome ~137+ disables the --load-extension CLI switch by default
    // (DisableLoadExtensionCommandLineSwitch feature flag). Without
    // turning that feature OFF, the extension never loads even with
    // --load-extension on the command line — Chrome silently ignores
    // it. We always pass --load-extension when extensionDir is set,
    // so always opt out of the disable here.
    '--disable-features=ChromeWhatsNewUI,DisableLoadExtensionCommandLineSwitch',
    '--silent-debugger-extension-api',
    // Keep the renderer ALIVE when the window is occluded / unfocused / on
    // another virtual desktop. Without these, Chrome throttles & suspends
    // layout for a backgrounded tab, so CDP DOM ops (getBoundingClientRect,
    // coordinate clicks, scrollIntoView) silently fail — the WhatsApp-Web
    // glove's open/read/send break unless the window is foreground (operator
    // 2026-06-09). visibilityState still reports 'hidden' when unfocused, so
    // WhatsApp keeps firing notifications — we get the afferent trigger AND
    // reliable efferent DOM ops at once. (Window must still be non-minimized.)
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
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
  return args;
}

/** Render an exe + argv as a copy-pasteable command line (quote anything with a space). */
export function chromeCommandLine(exe, args) {
  return [exe, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/**
 * Spawn Chrome detached so it survives this Node process exiting.
 * Returns immediately — call waitForChromeReady() to know when CDP is up.
 *
 * NOTE: a spawned child inherits its parent's Windows session. The spine runs as
 * a service in Session 0, so it must NEVER call this — see src/spine/commands.mjs.
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
  const args = chromeArgs({ port, userDataDir, extensionDir, url });

  const child = spawn(chrome, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // The exact Target the shell echoes on /chrome — exe + flags as spawned.
  const command = chromeCommandLine(chrome, args);
  return { pid: child.pid, command };
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
