// Singleton guard for the daemon wrapper. A second egpt daemon started while
// one is already running fights over the WhatsApp connection (baileys keeps
// getting "replaced"), which kills the bridge — and /restart can't fix it
// because it only respawns one of the two. See the duplicate-daemon incident.
//
// Identity and liveness are SEPARATE files now (operator 2026-07-02):
//   • state/spine.pid  — the long-lived spine pid, written ONCE at boot.
//   • state/alive.txt  — beaten every tick; its MTIME is the liveness signal.
// A daemon is already up iff the beat is FRESH (mtime age < staleMs) AND
// spine.pid names a LIVE process. liveDaemonPid is PURE over those two injected
// facts (the caller does the file reads): it returns that pid so a starting
// wrapper can refuse, or null when the field is clear — no/blank pid file, a
// stale beat, or a dead pid.
//
// Freshness guards against pid reuse: a stale beat whose recorded pid now
// belongs to some unrelated process must NOT be read as "a daemon is alive".

import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

// --- the cross-session locks (operator 2026-10-22) ------------------------------------------------
// state/runner.lock (the daemon whose spine holds the profile) and state/s1.claim (the Session 1
// daemon, for its whole life). A share-none open that the OS drops with the process — a logoff, a
// crash, taskkill /F — so no pid or beat is guessed. 0x10000000 is libuv's UV_FS_O_EXLOCK, which
// node does not export; it means something only on Windows, where the sessions are.
const EXLOCK = 0x10000000;
const lockFlags = (platform) => constants.O_RDWR | constants.O_CREAT | (platform === 'win32' ? EXLOCK : 0);

// The open handle, or null while another process holds it. Anything but a sharing violation throws.
export function openExclusive(path, platform = process.platform) {
  mkdirSync(dirname(path), { recursive: true });
  try { return openSync(path, lockFlags(platform)); }
  catch (e) { if (e?.code === 'EBUSY') return null; throw e; }
}

export function closeExclusive(fd) {
  try { closeSync(fd); } catch { /* already closed */ }
}

// Held by another process right now? Probed with an exclusive open that lets go at once.
export function heldExclusive(path, platform = process.platform) {
  let fd;
  try { fd = openSync(path, lockFlags(platform)); }
  catch (e) { return e?.code === 'EBUSY'; }
  closeExclusive(fd);
  return false;
}

// Pure decision over two injected facts: the spine.pid file's content and the
// alive.txt beat age (ms since its mtime; Infinity when the file is absent).
// Returns the live daemon's pid, or null.
export function liveDaemonPid({ pidFileContent, beatAgeMs } = {}, {
  staleMs = 120_000,            // alive.txt is beaten ~every 60s; 2 missed beats = gone
  isProcessAlive = defaultIsAlive,
} = {}) {
  const pid = Number(String(pidFileContent ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!(beatAgeMs < staleMs)) return null;   // absent (Infinity) / stale / NaN → not fresh
  return isProcessAlive(pid) ? pid : null;
}

// process.kill(pid, 0) probes existence without signalling: ESRCH = gone,
// EPERM = exists but not ours to signal (treat as alive — e.g. an S4U daemon).
//
// Cross-session pitfall on Windows: a session-1 process probing a session-0
// (S4U scheduled-task) pid gets ESRCH from process.kill — not EPERM as one
// might expect. The OS reports cross-session access denied as "not found"
// across that boundary, so the singleton false-negatives every time a user
// starts a manual supervisor while the scheduled-task daemon is alive — the
// very split-brain it was meant to prevent (operator 2026-05-28). The
// fallback re-asks the process table via `tasklist`, which can see any pid
// owned by the current user regardless of session.
export function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) {
    if (e.code === 'EPERM') return true;
    if (process.platform === 'win32' && e.code === 'ESRCH') {
      try {
        const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
          stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
        });
        const out = (r.stdout?.toString() ?? '').trim();
        // tasklist prints `"Image","PID","Session",…` rows on hit, or an
        // `INFO: No tasks…` line on miss. A CSV-quoted matching pid = alive.
        return out.length > 0 && !/^INFO:/i.test(out) && new RegExp(`"${pid}"`).test(out);
      } catch { /* tasklist missing / timeout → fall through to "dead" */ }
    }
    return false;
  }
}
