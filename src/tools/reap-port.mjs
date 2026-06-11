// reap-port.mjs — free a TCP port by killing whatever already listens on it.
//
// WHY: the worker supervisors (the @l llama-server in egpt.mjs, the resident
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

// Kill any process LISTENING on `port` (other than ourselves). Best-effort and
// never throws — a supervisor calls this on the spawn path and must not be
// taken down by a reap failure. Returns the count of pids it tried to kill.
export function reapPort(port, log = () => {}) {
  const p = Number(port);
  if (!p) return 0;
  const self = String(process.pid);
  try {
    if (process.platform === 'win32') {
      // netstat -ano: "... TCP  0.0.0.0:PORT  0.0.0.0:0  LISTENING  PID"
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      const re = new RegExp(`:${p}\\b\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(re);
        if (m && m[1] !== self && m[1] !== '0') pids.add(m[1]);
      }
      for (const pid of pids) {
        log(`reap-port: killing stale pid ${pid} on :${p}`);
        spawnSync('taskkill', ['/F', '/T', '/PID', pid], { windowsHide: true });
      }
      return pids.size;
    }
    // POSIX: lsof -t lists the listener pids directly.
    const out = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout || '';
    const pids = [...new Set(out.split(/\s+/).filter((x) => x && x !== self))];
    for (const pid of pids) {
      log(`reap-port: killing stale pid ${pid} on :${p}`);
      spawnSync('kill', ['-9', pid]);
    }
    return pids.length;
  } catch (e) {
    log(`reap-port(${p}): ${e?.message ?? e}`);
    return 0;
  }
}
