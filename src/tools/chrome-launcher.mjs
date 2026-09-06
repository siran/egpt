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
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EGPT_HOME } from '../egpt-home.mjs';

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

// Login history for the AI surfaces the brain drives lives in a Chrome profile's
// Default/History or Default/Network/Cookies as these domain substrings. A profile that
// mentions any of them has been logged in to an AI site — that's the "brain" profile the
// operator actually used, vs. a blank fresh one.
const AI_SITE_MARKERS = ['chatgpt', 'openai', 'claude.ai', 'grok'];

// Real-fs seams, injectable so tests point resolveBrainProfile at temp dirs (never a real
// profile). readFile is separated from the rest so a test can hand in a THROWING reader to
// model a locked History (Chrome holds a lock while running) without touching disk.
const defaultFs = { existsSync, readdirSync, statSync };
const defaultReadFile = (p) => readFileSync(p, 'latin1');

// Immediate subdirectory names of `dir`, or [] if it doesn't exist / can't be read. Never
// throws — a missing chrome/profiles tree is the common case on a fresh v2 install.
function listSubdirs(fs, dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

// A candidate is a REAL Chrome profile iff its Default subdir carries a Preferences file (or
// a Network/Cookies) — the two artifacts Chrome writes the moment a profile is used. A bare
// directory (or one we invented as the fresh fallback) fails this.
function isRealProfile(fs, dir) {
  const def = join(dir, 'Default');
  return fs.existsSync(join(def, 'Preferences')) || fs.existsSync(join(def, 'Network', 'Cookies'));
}

// Read a profile artifact defensively: a MISSING or LOCKED file (Chrome may be running and
// holding the History/Cookies lock) yields '' instead of throwing, so classification degrades
// to "not AI" rather than exploding.
function safeRead(readFile, file) {
  try { return readFile(file) || ''; } catch { return ''; }
}

// A real profile is an AI-brain iff its History OR Cookies mentions an AI-site domain. Read
// as latin1 + substring-match: History/Cookies are SQLite blobs, but the URLs inside are
// plain ASCII, so a defensive .includes on the raw bytes finds them without a DB open.
function isAiBrain(fs, readFile, dir) {
  const def = join(dir, 'Default');
  for (const f of [join(def, 'History'), join(def, 'Network', 'Cookies')]) {
    const text = safeRead(readFile, f);
    if (text && AI_SITE_MARKERS.some((m) => text.includes(m))) return true;
  }
  return false;
}

// Cookies mtime as a millisecond clock (−Infinity when absent/unreadable) — the "last active"
// proxy used to break a tie between multiple AI-brains.
function cookiesMtimeMs(fs, dir) {
  try { return fs.statSync(join(dir, 'Default', 'Network', 'Cookies')).mtimeMs; } catch { return -Infinity; }
}

/**
 * Find the Chrome profile the operator's AI brain actually lives in, instead of blindly
 * defaulting to the (usually blank) v2 profile dir. Pure-ish + NEVER throws: every fs touch is
 * read-only and wrapped, and all seams are injectable so tests run against temp dirs.
 *
 * Candidate roots, in PRIORITY order — ALL under <egptHome>:
 *   1. <egptHome>/chrome/profiles/brain            — the v2 default
 *   2. every OTHER immediate subdir of <egptHome>/chrome/profiles/  — discovers any additional
 *      profile the operator used (e.g. a future `brain2`), NOT hardcoded
 *
 * Preference of the returned dir:
 *   (a) an AI-brain (History/Cookies mentions an AI site) — if several qualify, the v2 default
 *       wins when it's one of them, else the most-recently-active by Cookies mtime;
 *   (b) else the first REAL, USED profile (a Network/Cookies exists);
 *   (c) else the v2 default (fresh — Chrome creates it on launch).
 *
 * @param {object}   [opts]
 * @param {string}   [opts.egptHome]  - profile root (default: EGPT_HOME)
 * @param {object}   [opts.fs]        - { existsSync, readdirSync, statSync } (default: node:fs)
 * @param {function} [opts.readFile]  - (path) => string; defaults to readFileSync(path,'latin1')
 * @returns {string} an absolute profile directory, always under egptHome
 */
export function resolveBrainProfile({ egptHome = EGPT_HOME, fs = defaultFs, readFile = defaultReadFile } = {}) {
  const profilesRoot = join(egptHome, 'chrome', 'profiles');
  const v2Default = join(profilesRoot, 'brain');

  const candidates = [v2Default];
  for (const sub of listSubdirs(fs, profilesRoot)) {
    if (sub !== 'brain') candidates.push(join(profilesRoot, sub));
  }

  const real = candidates.filter((dir) => isRealProfile(fs, dir));
  const aiBrains = real.filter((dir) => isAiBrain(fs, readFile, dir));

  if (aiBrains.length) {
    // (a) prefer the v2 default when it itself is an AI-brain, else the most-recently-active.
    if (aiBrains.includes(v2Default)) return v2Default;
    return aiBrains.reduce((best, dir) => (cookiesMtimeMs(fs, dir) > cookiesMtimeMs(fs, best) ? dir : best));
  }

  // (b) first real, USED profile (has Cookies), preserving candidate priority order.
  const used = real.find((dir) => fs.existsSync(join(dir, 'Default', 'Network', 'Cookies')));
  if (used) return used;

  // (c) the fresh v2 default — Chrome materializes it on first launch.
  return v2Default;
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
 * WHICH SPINE MAY CALL THIS, and it is a question about WINDOWS SESSIONS: a child inherits its
 * parent's session, so a Session 1 spine (the logon successor) puts the window on the operator's
 * desktop and may call this freely, while a Session 0 spine would put it on a desktop nobody can
 * look at. NOT because Session 0 cannot run a browser — it plainly can, measured on reve
 * 2026-09-06: chrome.exe pid 2388 serving CDP on :9224, SessionId 0 — but because the operator
 * cannot see it, click it, or answer a login prompt on it, and Chrome single-instances per
 * --user-data-dir, so an unseen one holding the brain profile is one they then cannot open
 * themselves. A Session 0 spine therefore hops through the `egpt-chrome` scheduled task instead.
 * The whole decision lives in ONE place — boot.mjs's launchChrome injection, explained in the
 * banner over the /chrome dispatch in src/spine/commands.mjs.
 *
 * DETACHED IS DELIBERATE, and it is what makes onExit OBSERVATION rather than ownership: the
 * browser must outlive an /upgrade or a /restart (the spine bounces often — the operator's
 * logged-in tabs must not go with it).
 *
 * @param {object} opts
 * @param {number} opts.port          - --remote-debugging-port (private, localhost-only)
 * @param {string} opts.userDataDir   - persistent profile directory
 * @param {string} [opts.extensionDir]- absolute path to unpacked extension (loaded via --load-extension)
 * @param {string} [opts.url]         - initial URL (default: about:blank)
 * @param {string} [opts.bin]         - the Chrome binary to run (config `chrome.bin`); UNSET = findChromeExecutable()
 * @param {function} [opts.onExit]    - ({ code, signal, error }) => void, fired when this Chrome ends
 *   or never starts. Passing it ALSO installs the child's 'error' listener — a ChildProcess without
 *   one turns a failed spawn into an UNCAUGHT exception, which in the spine's runtime path is a
 *   crash. Callers that want that loud old behaviour simply omit it.
 */
export async function spawnChrome({ port, userDataDir, extensionDir, url = 'about:blank', bin = null, onExit = null }) {
  const chrome = bin || findChromeExecutable();
  if (!chrome) throw new Error('Chrome executable not found in standard locations');
  await mkdir(userDataDir, { recursive: true });
  const args = chromeArgs({ port, userDataDir, extensionDir, url });

  const child = spawn(chrome, args, {
    detached: true,
    stdio: 'ignore',
  });
  if (onExit) {
    // Both ends of "this Chrome is not running", through one callback: a spawn that never started
    // (ENOENT on a configured chrome.bin) and a browser that has since exited. Wrapped, because a
    // throwing supervisor must not become an unhandled rejection inside a child-process event.
    child.on('error', (error) => { try { onExit({ code: null, signal: null, error }); } catch { /* supervisor's problem */ } });
    child.on('exit', (code, signal) => { try { onExit({ code, signal, error: null }); } catch { /* supervisor's problem */ } });
  }
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
