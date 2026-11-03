// src/tools/browser-screens.mjs — A SCREEN PER BROWSER GROUP on a container node (plans/2611022204-BROWSER-SCREENS.md,
// operator 2026-11-02 #119: "yes, a screen per browser group"). `:99` holds both Beepers and stays the operator's;
// each group's Chrome (eGPT's pipe one and the plain sign-in one) opens on its own Xvfb, `:100` and up, with its own
// x11vnc (localhost only, -shared -forever) and its own websockify/noVNC, so a link to it shows that group's browser
// and nothing else. A group keeps its display number (state/browser-screens.json); its ports follow the number the
// way :99 has 5900/6080 — :100 → 5901/6081.
//
// The processes are started detached and their pids kept beside the number, so a spine restart (/upgrade) leaves
// them, and the Chromes on them, running; a pid is only trusted while /proc says it is still that program on that
// display or port. A screen stays up until /browser close (operator #121: "don't close anything automatically").
//
// Passwords: x11vnc reads `-passwdfile read:<file>` (a full-control line, then `__BEGIN_VIEWONLY__` and a view-only
// one) and re-reads it for every new client, so each tunnel opening writes fresh ones with no x11vnc restart
// (screen-tunnel.mjs). The plan's `-rfbauth` + `-viewpasswd` would put them on the command line and fix them for
// the process's life. VNC uses only the first 8 characters: 6 random bytes, base64url.
//
// A desktop node (Windows, or no Xvfb/x11vnc/websockify/noVNC here) has no screens: `available()` is false and the
// group's Chrome opens as a normal window on that machine (plan decision 8).
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, delimiter, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

export const FIRST_DISPLAY = 100;
const NOVNC_DIR = '/usr/share/novnc';
const SCREEN = '1440x900x24';   // the size :99 runs at (docker/entrypoint.sh)
const VIEWONLY = '__BEGIN_VIEWONLY__';
const START_WAIT_MS = 10_000;

export const portsOf = (display) => ({ rfbPort: 5900 + display - 99, webPort: 6080 + display - 99 });

// A group keeps its number; a new group takes the lowest number from :100 no other group holds.
export function allocateDisplay(screens, group) {
  if (Number.isInteger(screens[group]?.display)) return screens[group].display;
  const used = new Set(Object.values(screens).map((s) => s?.display));
  let n = FIRST_DISPLAY;
  while (used.has(n)) n++;
  return n;
}

// /proc/net/tcp{,6} rows: `sl local rem st …`, ports in hex. `state` 01 = ESTABLISHED, 0A = LISTEN. Counting
// the LOCAL port only takes the server's side of each session (websockify → x11vnc is local at both ends).
export function sessionsOn(tables, port, state = '01') {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  let n = 0;
  for (const t of tables) {
    for (const row of String(t ?? '').split('\n').slice(1)) {
      const f = row.trim().split(/\s+/);
      if (f[3] === state && f[1]?.endsWith(hex)) n++;
    }
  }
  return n;
}

const readOr = (p, fallback) => { try { return readFileSync(p, 'utf8'); } catch { return fallback; } };
const procTcp = () => ['/proc/net/tcp', '/proc/net/tcp6'].map((p) => readOr(p, ''));
const procArgv = (pid) => readOr(`/proc/${pid}/cmdline`, '').split('\0').filter(Boolean);
const onPath = (bin) => String(process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, bin)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.egptHome
 * Seams (tests): platform, spawn, argvOf(pid) → argv[], kill(pid), tcp() → /proc/net/tcp texts, has(bin), exists(path).
 */
export function createBrowserScreens({ egptHome, platform = process.platform, spawn = nodeSpawn, argvOf = procArgv, kill = (pid) => process.kill(pid), tcp = procTcp, has = onPath, exists = existsSync, startWaitMs = START_WAIT_MS, log = () => {} }) {
  const statePath = join(egptHome, 'state', 'browser-screens.json');
  const dirOf = (group) => join(egptHome, 'state', 'browser-screens', group);
  const pwPath = (group) => join(dirOf(group), 'passwd');
  const read = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) ?? {}; } catch { return {}; } };
  const write = (all) => { mkdirSync(join(egptHome, 'state'), { recursive: true }); writeFileSync(statePath, JSON.stringify(all, null, 2) + '\n'); };
  // The pid is still that program, on that display/port: argv[0] is it (argv[1] under an interpreter: websockify is
  // python), and the needle is one of its arguments.
  const running = (pid, bin, needle) => { if (!pid) return false; const a = argvOf(pid); return a.slice(0, 2).some((x) => basename(x).startsWith(bin)) && a.includes(String(needle)); };
  const ensuring = new Map();

  function start(group, bin, args) {
    const fd = openSync(join(dirOf(group), 'screen.log'), 'a', 0o600);
    try {
      const child = spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd] });
      child.on?.('error', (e) => log(`browser screen ${group}: ${bin} — ${e?.message ?? e}`));
      child.unref?.();
      return child.pid;
    } finally { closeSync(fd); }
  }
  async function until(ready, what, group) {
    for (let t = 0; !ready(); t += 100) {
      if (t >= startWaitMs) throw new Error(`${what} did not start (see ${join(dirOf(group), 'screen.log')})`);
      await sleep(100);
    }
  }
  const listening = (port) => sessionsOn(tcp(), port, '0A') > 0;

  // Fresh passwords, or the ones this screen's x11vnc reads now.
  function passwords(group, { fresh = false } = {}) {
    if (!fresh) {
      const [control, , view] = readOr(pwPath(group), '').split('\n');
      if (control && view) return { control, view };
    }
    const pw = { control: randomBytes(6).toString('base64url'), view: randomBytes(6).toString('base64url') };
    mkdirSync(dirOf(group), { recursive: true, mode: 0o700 });
    writeFileSync(pwPath(group), `${pw.control}\n${VIEWONLY}\n${pw.view}\n`, { mode: 0o600 });
    return pw;
  }

  async function bringUp(group) {
    const all = read();
    const s = all[group] = { ...all[group], display: allocateDisplay(all, group) };
    const save = () => write({ ...read(), [group]: s });   // the number at once (another group may be starting), each pid as it starts
    save();
    const n = s.display, d = `:${n}`;
    const { rfbPort, webPort } = portsOf(n);
    mkdirSync(dirOf(group), { recursive: true, mode: 0o700 });
    if (!exists(pwPath(group))) passwords(group, { fresh: true });
    const fresh = [];
    if (!running(s.xvfb, 'Xvfb', d)) {
      s.xvfb = start(group, 'Xvfb', [d, '-screen', '0', SCREEN, '-nolisten', 'tcp', '-nolisten', 'local']);
      save();
      fresh.push(`Xvfb ${d}`);
      await until(() => exists(`/tmp/.X11-unix/X${n}`), `Xvfb ${d}`, group);
    }
    if (!running(s.vnc, 'x11vnc', rfbPort)) {
      s.vnc = start(group, 'x11vnc', ['-display', d, '-passwdfile', `read:${pwPath(group)}`, '-localhost', '-rfbport', String(rfbPort), '-shared', '-forever', '-quiet']);
      save();
      fresh.push(`x11vnc :${rfbPort}`);
      await until(() => listening(rfbPort), `x11vnc on ${rfbPort}`, group);
    }
    if (!running(s.web, 'websockify', `localhost:${rfbPort}`)) {
      s.web = start(group, 'websockify', ['--web', NOVNC_DIR, `127.0.0.1:${webPort}`, `localhost:${rfbPort}`]);
      save();
      fresh.push(`noVNC :${webPort}`);
      await until(() => listening(webPort), `websockify on ${webPort}`, group);
    }
    if (fresh.length) log(`browser screen ${group}: started ${fresh.join(', ')}`);
    return { group, display: d, rfbPort, webPort };
  }

  return {
    // A container node: the screen programs and noVNC are here, and it is not Windows.
    available: () => platform !== 'win32' && ['Xvfb', 'x11vnc', 'websockify'].every((b) => has(b)) && exists(NOVNC_DIR),
    // Start (or find) the group's screen → { group, display: ':100', rfbPort, webPort }. Single-flight per group.
    ensure(group) {
      if (!ensuring.has(group)) ensuring.set(group, bringUp(group).finally(() => ensuring.delete(group)));
      return ensuring.get(group);
    },
    // /browser close: stop its noVNC, x11vnc and Xvfb (a Chrome still on it goes with its X server). The number stays.
    // → whether anything was running.
    close(group) {
      const all = read();
      const s = all[group];
      if (!s) return false;
      const d = `:${s.display}`, { rfbPort } = portsOf(s.display);
      let any = false;
      for (const [k, bin, needle] of [['web', 'websockify', `localhost:${rfbPort}`], ['vnc', 'x11vnc', rfbPort], ['xvfb', 'Xvfb', d]]) {
        if (running(s[k], bin, needle)) { try { kill(s[k]); any = true; } catch (e) { log(`browser screen ${group}: could not stop ${bin} pid ${s[k]} — ${e?.message ?? e}`); } }
        delete s[k];
      }
      write(all);
      if (any) log(`browser screen ${group}: closed ${d}`);
      return any;
    },
    // The screen's ports, when it has a number (no process is started).
    portsOf: (group) => { const n = read()[group]?.display; return Number.isInteger(n) ? portsOf(n) : null; },
    // Viewers = established sessions on its x11vnc port (not the noVNC one: cloudflared keeps keep-alives open there).
    viewers(group) { const n = read()[group]?.display; return Number.isInteger(n) ? sessionsOn(tcp(), portsOf(n).rfbPort) : 0; },
    passwords,
  };
}
