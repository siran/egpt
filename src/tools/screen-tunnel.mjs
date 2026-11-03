// src/tools/screen-tunnel.mjs — THE LINK to a group's screen (plans/2611022204-BROWSER-SCREENS.md decisions 5-6): a
// Cloudflare quick tunnel (no account, a random *.trycloudflare.com) to the group's noVNC, one per group. Asking again
// while it is open returns the same link; each OPENING writes fresh view and control passwords (browser-screens.mjs
// `passwords`), so an old link is dead even if the same URL ever came back. The shell prototype, verified with a real
// noVNC tab 11-02, is ~/.egpt/bin/vnc-link on nu.
//
// No time limit while watched (operator #112: "can vnc close on browser/tab close? do we even need a time limit?"):
// the tunnel closes GRACE after the last viewer of that screen leaves, or IDLE if nobody ever connected. A viewer is
// an established session on the screen's x11vnc port (browser-screens.mjs `viewers`). Nothing else closes it but
// /browser stop and /browser close.
//
// cloudflared runs detached with its pid in state/browser-screens/<group>/tunnel.pid, so a spine restart leaves the
// link up; the next spine adopts it and watches it again (IDLE starts over). The binary lives in ~/.egpt/bin
// (the data volume), fetched on first use.
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';

export const GRACE_MS = 120_000;
export const IDLE_MS = 600_000;
const POLL_MS = 5_000;
const URL_WAIT_MS = 30_000;
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED = /Registered tunnel connection/;

// The one-tap link: noVNC connects at once, scaled to the viewer's window, view-only or not, the password filled in.
export const linkOf = (url, password, viewOnly) => `${url}/vnc.html?autoconnect=1&resize=scale&view_only=${viewOnly ? 1 : 0}&password=${encodeURIComponent(password)}`;

const readOr = (p, fallback) => { try { return readFileSync(p, 'utf8'); } catch { return fallback; } };
const procArgv = (pid) => readOr(`/proc/${pid}/cmdline`, '').split('\0').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.egptHome
 * @param {object} o.screens   browser-screens.mjs: portsOf(group), viewers(group), passwords(group, { fresh })
 * Seams (tests): spawn, fetch, argvOf(pid), kill(pid), setInterval/clearInterval, graceMs/idleMs/pollMs, urlWaitMs.
 */
export function createScreenTunnel({
  egptHome, screens, spawn = nodeSpawn, fetch = globalThis.fetch, argvOf = procArgv, kill = (pid) => process.kill(pid),
  setInterval: every = setInterval, clearInterval: stopEvery = clearInterval,
  graceMs = GRACE_MS, idleMs = IDLE_MS, pollMs = POLL_MS, urlWaitMs = URL_WAIT_MS, log = () => {},
}) {
  const bin = join(egptHome, 'bin', 'cloudflared');
  const root = join(egptHome, 'state', 'browser-screens');
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
    log(`screen link: fetching cloudflared into ${bin}`);
    const r = await fetch(CLOUDFLARED_URL);
    if (!r.ok) throw new Error(`could not fetch cloudflared (${r.status})`);
    mkdirSync(join(egptHome, 'bin'), { recursive: true });
    writeFileSync(bin, Buffer.from(await r.arrayBuffer()));
    chmodSync(bin, 0o755);
    return bin;
  }

  async function start(group) {
    const ports = screens.portsOf(group);
    if (!ports) throw new Error(`the "${group}" browser has no screen`);
    const exe = await cloudflared();
    const pw = screens.passwords(group, { fresh: true });
    mkdirSync(join(root, group), { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(group, 'tunnel.log'), '', { mode: 0o600 });
    const fd = openSync(fileOf(group, 'tunnel.log'), 'a');
    let child;
    try {
      child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${ports.webPort}`], { detached: true, stdio: ['ignore', fd, fd] });
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
      if (alive(group) && urlOf(group)) return Promise.resolve({ url: urlOf(group), ...screens.passwords(group), reused: true });
      if (!opening.has(group)) opening.set(group, start(group).finally(() => opening.delete(group)));
      return opening.get(group);
    },
    close: (group) => close(group),
    isOpen: (group) => alive(group),
  };
}
