// Singleton guard for the daemon wrapper. A second egpt daemon started while
// one is already running fights over the WhatsApp connection (baileys keeps
// getting "replaced"), which kills the bridge — and /restart can't fix it
// because it only respawns one of the two. See the duplicate-daemon incident.
//
// The app (egpt.mjs) beats ~/.egpt/state/alive.txt with "<tic|toc> <iso> <pid>".
// A daemon is already up iff that beat is FRESH and its pid is a LIVE process.
// liveDaemonPid returns that pid (so a starting wrapper can refuse), or null
// when the field is clear: no file, stale beat, dead pid, or it's our own pid.
//
// Freshness guards against pid reuse: an old beat whose pid now belongs to some
// unrelated process must NOT be read as "a daemon is alive".

const BEAT_RE = /^(?:tic|toc)\s+(\S+)\s+(\d+)\s*$/gm;

export function liveDaemonPid(content, {
  now = Date.now(),
  selfPid = process.pid,
  staleMs = 120_000,            // app beats ~every 60s; 2 missed beats = gone
  isAlive = defaultIsAlive,
} = {}) {
  if (!content) return null;
  const beats = [...content.matchAll(BEAT_RE)];
  if (!beats.length) return null;
  const [, iso, pidStr] = beats[beats.length - 1];   // newest beat wins
  const pid = Number(pidStr);
  const ts = Date.parse(iso);
  if (!pid || pid === selfPid) return null;
  if (!Number.isFinite(ts) || now - ts > staleMs) return null;
  return isAlive(pid) ? pid : null;
}

// process.kill(pid, 0) probes existence without signalling: ESRCH = gone,
// EPERM = exists but not ours to signal (treat as alive — e.g. an S4U daemon).
function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
