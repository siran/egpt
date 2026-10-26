// tools/chrome-launcher.mjs — locate Chrome, find the brain profile, the args a browser group's
// Chrome is launched with over --remote-debugging-pipe (by the S1 daemon, src/chrome-host.mjs), the
// group's name and color stamped into its profile, and the OS process probes its orphan sweep uses.
// Nothing here launches a Chrome on a debug port.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, readlinkSync } from 'node:fs';
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

// Pipe-mode flags (chunk 3b): --remote-debugging-pipe instead of a port, and NO --remote-allow-origins
// (that is port/WS-only). Keeps the non-default --user-data-dir (Chrome 136 requires it), --no-first-run,
// the no-banner --silent-debugger-extension-api, and the renderer-alive flags. --load-extension still opts.
// --restore-last-session: a relaunch (an eviction, a crash, a daemon restart) reopens the group's tabs.
// --window-name: the title of the window Chrome opens at startup (a restored window keeps its saved one).
export function chromePipeArgs({ userDataDir, extensionDir, url = 'about:blank', windowName }) {
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--restore-last-session',
    `--disable-features=ChromeWhatsNewUI${extensionDir ? ',DisableLoadExtensionCommandLineSwitch' : ''}`,
    '--silent-debugger-extension-api',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--new-window',
  ];
  if (windowName) args.push(`--window-name=${windowName}`);
  if (extensionDir) args.push(`--load-extension=${extensionDir}`);
  args.push(url);
  return args;
}

// A plain Chrome on a group's profile: no pipe, no automation flags. A human signs in or passes a
// check there (/browser refresh); the group's pipe Chrome reuses that session afterwards.
export function chromePlainArgs({ userDataDir, url = 'about:blank' }) {
  return [`--user-data-dir=${userDataDir}`, '--no-first-run', url];
}

// A group's color: browsers.yaml `colors.<group>` when it is "#RRGGBB", else a fixed pick by name hash.
export const GROUP_PALETTE = ['#1a73e8', '#d93025', '#188038', '#e8710a', '#9334e6', '#12b5cb', '#e52592', '#795548'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export function groupColor(group, colors = {}) {
  const set = colors?.[group];
  if (typeof set === 'string' && HEX_COLOR.test(set)) return set.toLowerCase();
  let h = 0x811c9dc5;   // FNV-1a
  for (let i = 0; i < group.length; i++) h = Math.imul(h ^ group.charCodeAt(i), 0x01000193);
  return GROUP_PALETTE[(h >>> 0) % GROUP_PALETTE.length];
}

// Chrome 155's keys for the profile's name and its theme color (what Settings > Customize profile and
// Customize Chrome > color write). Chrome rewrites both files on exit: call only while no Chrome holds
// the profile. A missing or unparsable file is skipped and logged; never throws.
export function stampGroupProfile({ userDataDir, group, colors = {}, log = () => {} }) {
  const color = groupColor(group, colors);
  if (colors?.[group] !== undefined && colors[group]?.toLowerCase?.() !== color) {
    log(`browsers.yaml colors.${group} ${JSON.stringify(colors[group])} is not "#RRGGBB"; using ${color}`);
  }
  const argb = (0xff000000 | parseInt(color.slice(1), 16)) | 0;   // SkColor as Chrome stores it
  const done = [
    editProfileJson(join(userDataDir, 'Local State'), log, (doc) => {
      const entry = doc.profile?.info_cache?.Default;
      if (!entry) throw new Error('no profile.info_cache.Default');
      return [put(entry, 'name', group), put(entry, 'is_using_default_name', false)];
    }),
    editProfileJson(join(userDataDir, 'Default', 'Preferences'), log, (doc) => [
      put(dict(doc, 'profile'), 'name', group),
      put(dict(doc, 'profile'), 'using_default_name', false),
      put(dict(doc, 'extensions', 'theme'), 'id', 'user_color_theme_id'),
      put(dict(doc, 'browser', 'theme'), 'user_color2', argb),
    ]),
  ];
  if (done.includes(true)) log(`stamped "${group}" profile ${userDataDir}: name "${group}", color ${color}`);
}

const put = (o, k, v) => (JSON.stringify(o[k]) === JSON.stringify(v) ? false : ((o[k] = v), true));
const dict = (o, ...keys) => keys.reduce((d, k) => (d[k] && typeof d[k] === 'object' ? d[k] : (d[k] = {})), o);
// Numbers keep their source text, so a double Chrome wrote as 1.0 is not read back as an int.
const keepNumbers = (k, v, ctx) => (typeof v === 'number' ? JSON.rawJSON(ctx.source) : v);

// Parse, apply, write via tmp+rename only if something changed. True when the file was rewritten.
function editProfileJson(file, log, apply) {
  const tmp = `${file}.egpt-tmp`;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'), keepNumbers);
    if (!apply(doc).includes(true)) return false;
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, file);
    return true;
  } catch (e) {
    log(`profile stamp skipped ${file}: ${e.code === 'ENOENT' ? 'not there yet' : e.message}`);
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

// Who already runs a Chrome on this --user-data-dir, or null. A running Chrome holds <dir>/lockfile
// open without write sharing (Windows) or points <dir>/SingletonLock at <host>-<pid> (POSIX); both
// outlive a Chrome that exited, so the probe is the open / the pid, never mere existence.
export function profileHolder(userDataDir) {
  if (process.platform === 'win32') {
    try { closeSync(openSync(join(userDataDir, 'lockfile'), 'r+')); return null; }
    catch (e) { return e.code === 'ENOENT' ? null : e.code; }
  }
  let pid;
  try { pid = Number(/-(\d+)$/.exec(readlinkSync(join(userDataDir, 'SingletonLock')))?.[1]); } catch { return null; }
  try { process.kill(pid, 0); return `pid ${pid}`; } catch (e) { return e.code === 'EPERM' ? `pid ${pid}` : null; }
}

// Every running chrome.exe as { pid, cmd } (its command line) — the daemon's orphan sweep (src/chrome-host.mjs).
export function chromeProcesses() {
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
    return [].concat(JSON.parse(out || '[]')).map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine ?? '' }));
  }
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
}

export function killProcessTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}
