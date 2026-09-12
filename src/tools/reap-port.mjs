// reap-port.mjs — free a TCP port by killing whatever already listens on it.
//
// WHY: the worker supervisors (the @l llama-server in egpt-spine.mjs, the resident
// whisper-server in whisper-server.mjs) spawn a child process bound to a fixed
// port. On Windows a child is NOT killed when its parent exits, so a soft
// /restart (the daemon respawns its shell) ORPHANS the worker — it keeps the
// port, and the fresh worker can't bind it (EADDRINUSE), so the model/transport
// silently stays on the OLD process. Operator hit this swapping @l's model
// (2026-06-11): the stale llama-server held :8080 and a manual elevated
// `taskkill` was the only way out.
//
// The daemon runs ELEVATED (NSSM service in session 0), so it can terminate
// even a worker the service spawned elevated — which a non-elevated operator
// shell cannot (`taskkill … Access is denied`). So the reap belongs IN the
// daemon: each supervisor calls reapPort(port) BEFORE it spawns, and the orphan
// problem disappears with no manual step.
import { spawnSync } from 'node:child_process';

// The tool each platform is asked with, named in the log when it comes back empty — "I could
// not name the holder" must say WHAT it asked, or a human cannot tell "nothing is listening"
// from "netstat is not on PATH".
export const PORT_LOOKUP_TOOL = process.platform === 'win32' ? 'netstat -ano' : 'lsof';

// WHO is LISTENING on `port`, other than ourselves — the read-only half of reapPort below, so
// "who holds it" and "who gets killed" can never answer from two different parsers. Returns
// [{ pid, name }] (name null when the image could not be resolved) and [] when nothing could
// be found, which the CALLER must say out loud rather than render as an empty phrase.
//
// WHY IT EXISTS (reve, the night of 2026-09-11). The S1 spine could not bind its console port
// and retried forever, logging the same bare EADDRINUSE line; nothing anywhere said what was
// holding the number, so the operator had to run netstat by hand. The machinery to answer was
// already in this file — it was just wired only to the killer.
//
// Best-effort and never throws. Costs one spawnSync (plus one per pid to name the image), so
// callers should ask on a failure, not on a schedule.
export function portHolders(port) {
  const p = Number(port);
  if (!p) return [];
  const self = String(process.pid);
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      const re = new RegExp(`:${p}\\b\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(re);
        if (m && m[1] !== self && m[1] !== '0') pids.add(m[1]);
      }
      return [...pids].map((pid) => ({ pid, name: imageName(pid) }));
    }
    const out = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout || '';
    const pids = [...new Set(out.split(/\s+/).filter((x) => x && x !== self))];
    return pids.map((pid) => ({ pid, name: imageName(pid) }));
  } catch {
    // The caller's line already says "could not name what holds it"; a throw here is one more
    // way of not naming it, not a separate event worth a second line.
    return [];
  }
}

// The image behind a pid, or null. A second cheap spawn, and only ever for a pid we already
// know is holding a port we wanted.
function imageName(pid) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      const m = out.match(/^"([^"]+)"/m);
      return m ? m[1] : null;
    }
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).stdout || '';
    return out.trim() || null;
  } catch { return null; }
}

// The full command line behind a pid, or null. THE expensive lookup here: wmic is gone from
// Windows 11 (measured absent on reve, build 26200), so the only reliable way to read another
// process's arguments is a CIM query, and PowerShell's startup makes that ~1.7s. That is why
// reapPort only asks for it when a caller has actually asked for the ownership guard, and why
// nothing on a hot path may call this. Best-effort, never throws.
export function processCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
      { encoding: 'utf8', windowsHide: true }).stdout || '';
      return out.trim() || null;
    }
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).stdout || '';
    return out.trim() || null;
  } catch { return null; }
}

// --- WHAT COUNTS AS OURS (operator, the night of 2026-09-11) --------------------------------
// The console limb calls reapPort before its first bind, and the justification used to be that
// "a SQUATTER holding it is exactly the attack this limb's whole shape exists to close, so
// evicting it is the right answer either way". On this machine the squatter is BEEPER DESKTOP:
// it claims the first free port upward from 23373 and was holding 23373, 23374 and 23375 when
// this was written. So that reap would terminate the process that delivers every message — to
// reclaim a port the daemon has just been told the spine does not need in order to serve
// (src/daemon-runtime.mjs: spine.pid decides, the console port has no veto). The two rulings
// cannot both stand, and the one that keeps the node answering wins.
//
// The legitimate case the original comment describes is real and still reaped: a stale prior
// spine orphaning THIS port, which on Windows survives its parent's exit. The test for it is
// the direct one — a node process whose command line runs egpt-spine.mjs. The image name alone
// is not enough (node.exe is every other tool on this box) and neither is the port alone.
export const OWN_SPINE_LABEL = 'a node process running egpt-spine.mjs';
export function isOwnSpine({ name = null, cmdline = null } = {}) {
  if (!/^node(\.exe)?$/i.test(String(name ?? ''))) return false;
  return /(^|[\\/\s])egpt-spine\.mjs(\s|$)/i.test(String(cmdline ?? ''));
}

// Kill any process LISTENING on `port` (other than ourselves). Best-effort and
// never throws — a supervisor calls this on the spawn path and must not be
// taken down by a reap failure. Returns the count of pids it actually killed.
//
// `mine` is the OWNERSHIP GUARD: a predicate over { pid, name, cmdline } asked before any
// kill. Given one, a holder it does not vouch for is LEFT ALONE and named in the log, and a
// holder that cannot be identified at all is also left alone — not killing is recoverable (a
// node runs without an operator console), killing a stranger is not. `mineLabel` is the noun
// phrase for what the guard wanted, so the refusal says what the holder failed to be.
//
// WITHOUT `mine` the old behaviour stands: whatever LISTENS is killed. That is deliberate and
// it has exactly one caller left — src/spine/boot.mjs's stray-whisper-server reap, which is a
// different question about a different port with its own config-level gate
// (shouldReapStrayWhisper) and is not this ruling's subject.
//
// `holders` and `kill` are injection seams so the guard can be tested without a real netstat,
// tasklist or taskkill. The default `holders` resolves the (expensive) command line ONLY when
// a guard is present, so the unguarded whisper reap pays nothing it did not pay before.
export function reapPort(port, log = () => {}, {
  mine = null,
  mineLabel = 'ours',
  holders = null,
  kill = killPid,
} = {}) {
  const p = Number(port);
  if (!p) return 0;
  const list = holders ?? ((n) => portHolders(n).map((h) => (mine ? { ...h, cmdline: processCommandLine(h.pid) } : h)));
  let killed = 0;
  try {
    for (const h of list(p)) {
      const name = h?.name ?? null;
      const cmd = h?.cmdline ?? null;
      // Every refusal states the OBSERVATIONS (which may be "unreadable" — Beeper's command
      // line comes back empty from the CIM query on reve) and then the verdict, and the
      // verdict is carefully "nothing establishes that it is ours" rather than "it is not
      // ours": a holder whose arguments could not be read has not been ruled out, only left
      // unvouched-for, and either way it is not killed.
      const who = `pid ${h?.pid} (image ${name ?? 'UNKNOWN'}, command line ${cmd ? `\`${cmd}\`` : 'UNREADABLE'})`;
      if (mine && !mine(h)) {
        log(name == null && cmd == null
          ? `reap-port: :${p} is held by ${who} — it could not be identified at all, and an unidentified process is never killed here: running without an operator console is recoverable, terminating a stranger is not.`
          : `reap-port: :${p} is held by ${who} — nothing observed about it establishes that it is ${mineLabel}, so NOT killing it. This node will run without an operator console rather than terminate a process it cannot vouch for.`);
        continue;
      }
      log(`reap-port: killing stale pid ${h?.pid}${h?.name ? ` (${h.name})` : ''} on :${p}`);
      try { kill(h?.pid); killed += 1; }
      catch (e) { log(`reap-port: could not kill pid ${h?.pid} on :${p} — ${e?.message ?? e}; the port stays held.`); }
    }
  } catch (e) {
    log(`reap-port(${p}): ${e?.message ?? e}`);
  }
  return killed;
}

function killPid(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
  else spawnSync('kill', ['-9', String(pid)]);
}
