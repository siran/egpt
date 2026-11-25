// src/tools/screen-tunnel.mjs — THE LINK to a group's screen (plans/2611022204-BROWSER-SCREENS.md decisions 5-6): a
// Cloudflare quick tunnel (no account, a random *.trycloudflare.com) to the group's noVNC, one per group. Asking again
// while it is open returns the same link; each OPENING writes fresh view and control passwords (browser-screens.mjs
// `passwords`), so an old link is dead even if the same URL ever came back. The shell prototype, verified with a real
// noVNC tab 11-02, is ~/.egpt/bin/vnc-link on nu.
//
// No time limit while watched (operator #112: "can vnc close on browser/tab close? do we even need a time limit?"):
// the tunnel closes GRACE after the last viewer of that screen leaves, or IDLE if nobody ever connected. A viewer is
// an established session on the screen's x11vnc port (browser-screens.mjs `viewers`). Nothing else closes it but
// /browser stop and /browser close, and the idle timer (commands.mjs, chrome.idle_minutes: no browser use for N minutes
// closes it even while watched, unless that launch said `keep`).
//
// cloudflared runs detached with its pid in state/browser-screens/<group>/tunnel.pid, so a spine restart leaves the
// link up; the next spine adopts it and watches it again (IDLE starts over). The binary lives in ~/.egpt/bin
// (the data volume), fetched on first use: a PINNED release (CLOUDFLARED_VERSION), linux-amd64 or windows-amd64,
// whose SHA-256 is checked before anything is written (a mismatch installs nothing).
//
// Not only screens: the group is just a key; `screens` says which local port it tunnels (portsOf(key).webPort) and when
// it is watched (viewers(key)); passwords are optional. The secrets page (http-secrets.mjs) is the second user: its
// key is 'secrets', its port a listener that serves nothing but /secret/…, its viewers the live sessions, and
// `stateDir` keeps its pid and log apart from the screens'.
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';

export const GRACE_MS = 120_000;
export const IDLE_MS = 600_000;
const POLL_MS = 5_000;
const URL_WAIT_MS = 30_000;
// Pinned (was releases/latest, unchecked). Bump the version and both hashes together, from the release notes' SHA256 list.
export const CLOUDFLARED_VERSION = '2026.11.2';
export const CLOUDFLARED_ASSETS = {
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf', exe: 'cloudflared' },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: '555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113', exe: 'cloudflared.exe' },
};
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED = /Registered tunnel connection/;

// The one-tap link: noVNC connects at once, scaled to the viewer's window, view-only or not, the password filled in.
export const linkOf = (url, password, viewOnly) => `${url}/vnc.html?autoconnect=1&resize=scale&view_only=${viewOnly ? 1 : 0}&password=${encodeURIComponent(password)}`;

const readOr = (p, fallback) => { try { return readFileSync(p, 'utf8'); } catch { return fallback; } };
// Linux: /proc. Windows has none: the image name tasklist reports for that pid ([] when there is no such process).
const procArgv = (pid) => {
  if (process.platform !== 'win32') return readOr(`/proc/${pid}/cmdline`, '').split('\0').filter(Boolean);
  try { return [/^"([^"]*)"/.exec(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }))?.[1]].filter(Boolean); } catch { return []; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.egptHome
 * @param {object} o.screens   browser-screens.mjs: portsOf(group), viewers(group), passwords(group, { fresh }) (optional)
 * @param {string} [o.stateDir] under state/: where each key's tunnel.pid and tunnel.log live (default browser-screens)
 * Seams (tests): spawn, fetch, argvOf(pid), kill(pid), setInterval/clearInterval, graceMs/idleMs/pollMs, urlWaitMs, platform, arch.
 */
export function createScreenTunnel({
  egptHome, screens, stateDir = 'browser-screens', platform = process.platform, arch = process.arch, spawn = nodeSpawn, fetch = globalThis.fetch, argvOf = procArgv, kill = (pid) => process.kill(pid),
  setInterval: every = setInterval, clearInterval: stopEvery = clearInterval,
  graceMs = GRACE_MS, idleMs = IDLE_MS, pollMs = POLL_MS, urlWaitMs = URL_WAIT_MS, log = () => {},
}) {
  const asset = CLOUDFLARED_ASSETS[`${platform}-${arch}`] ?? null;
  const bin = join(egptHome, 'bin', asset?.exe ?? 'cloudflared');
  const root = join(egptHome, 'state', stateDir);
  const fileOf = (group, f) => join(root, group, f);
  const pidOf = (group) => Number(readOr(fileOf(group, 'tunnel.pid'), '')) || null;
  const alive = (group) => { const pid = pidOf(group); return !!pid && argvOf(pid).some((a) => basename(a).startsWith('cloudflared')); };
  const urlOf = (group) => TUNNEL_URL.exec(readOr(fileOf(group, 'tunnel.log'), ''))?.[0] ?? null;
  const watchers = new Map();   // group → interval
  const opening = new Map();    // group → in-flight open

  function close(group, why = 'stopped') {
    stopEvery(watchers.get(group));
    watchers.delete(group);
    const pid = alive(group) ? pidOf(group) : null;
    if (pid) { try { kill(pid); } catch (e) { log(`screen link ${group}: could not stop cloudflared pid ${pid} — ${e?.message ?? e}`); } }
    rmSync(fileOf(group, 'tunnel.pid'), { force: true });
    rmSync(fileOf(group, 'tunnel.log'), { force: true });
    if (pid) log(`screen link ${group}: closed (${why})`);
    return !!pid;
  }

  // GRACE after the last viewer leaves, IDLE if none ever came; gone on its own → stop watching.
  function watch(group) {
    stopEvery(watchers.get(group));
    let seen = false, quiet = 0;
    const t = every(() => {
      if (!alive(group)) { stopEvery(t); if (watchers.get(group) === t) watchers.delete(group); return; }
      if (screens.viewers(group) > 0) { seen = true; quiet = 0; return; }
      quiet += pollMs;
      if (seen && quiet >= graceMs) close(group, `no viewer for ${graceMs / 1000}s`);
      else if (!seen && quiet >= idleMs) close(group, `nobody connected in ${idleMs / 1000}s`);
    }, pollMs);
    t?.unref?.();
    watchers.set(group, t);
  }

  async function cloudflared() {
    if (existsSync(bin)) return bin;
    if (!asset) throw new Error(`no cloudflared build for ${platform}-${arch} (linux-x64 and win32-x64 only): put one at ${bin}`);
    log(`screen link: fetching cloudflared ${CLOUDFLARED_VERSION} into ${bin}`);
    const r = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`);
    if (!r.ok) throw new Error(`could not fetch cloudflared (${r.status})`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== asset.sha256) throw new Error(`cloudflared ${CLOUDFLARED_VERSION} ${asset.file}: SHA-256 ${sha} is not the pinned ${asset.sha256}; not installed`);
    mkdirSync(join(egptHome, 'bin'), { recursive: true });
    writeFileSync(bin, bytes);
    chmodSync(bin, 0o755);
    return bin;
  }

  async function start(group) {
    const ports = screens.portsOf(group);
    if (!ports) throw new Error(`the "${group}" browser has no screen`);
    const exe = await cloudflared();
    const pw = screens.passwords?.(group, { fresh: true }) ?? {};
    mkdirSync(join(root, group), { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(group, 'tunnel.log'), '', { mode: 0o600 });
    const fd = openSync(fileOf(group, 'tunnel.log'), 'a');
    let child;
    try {
      child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${ports.webPort}`], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      child.on?.('error', (e) => log(`screen link ${group}: cloudflared — ${e?.message ?? e}`));
      child.unref?.();
    } finally { closeSync(fd); }
    writeFileSync(fileOf(group, 'tunnel.pid'), String(child.pid));
    // The URL is printed before Cloudflare's edge serves it; the link works once a connection is registered. The
    // plan's "vnc.html = 200" check is not used: on nu the VPC resolver caches the fresh name as NXDOMAIN when asked
    // that early, so the node itself cannot load the page for minutes while a phone can (measured 11-03).
    const ready = () => REGISTERED.test(readOr(fileOf(group, 'tunnel.log'), '')) && urlOf(group);
    for (let t = 0; !ready(); t += 500) {
      if (t >= urlWaitMs) { close(group, 'no URL'); throw new Error(`cloudflared gave no tunnel URL in ${urlWaitMs / 1000}s`); }
      await sleep(500);
    }
    const url = urlOf(group);
    watch(group);
    log(`screen link ${group}: opened ${url} (pid ${child.pid})`);
    return { url, ...pw, reused: false };
  }

  // A spine restart: the links still up are watched again.
  try { for (const g of readdirSync(root)) if (alive(g)) watch(g); } catch {}

  return {
    // The group's link → { url, control, view, reused }: the open one, else a new tunnel with fresh passwords.
    open(group) {
      if (alive(group) && urlOf(group)) return Promise.resolve({ url: urlOf(group), ...screens.passwords?.(group), reused: true });
      if (!opening.has(group)) opening.set(group, start(group).finally(() => opening.delete(group)));
      return opening.get(group);
    },
    close: (group) => close(group),
    isOpen: (group) => alive(group),
  };
}
