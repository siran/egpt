#!/usr/bin/env node
// egpt-daemon.mjs — supervisor for `node egpt.mjs`.
//
// Two responsibilities:
//   1. Spawn the shell as a child, restart on crash with exponential backoff,
//      handle distinguished exit codes (42/43/44 = upgrade/restart/rewind).
//   2. INTEGRATED HEARTBEAT WATCHDOG (operator 2026-05-31): poll the child's
//      ~/.egpt/state/alive.txt every 2s. If the latest tic/toc is older than
//      90s, the child is wedged-but-alive (event loop blocked, deadlock, WA
//      hung). SIGTERM → grace → SIGKILL → wrapper respawns. No separate
//      watchdog task or PowerShell wrapper is needed; the OS service manager
//      only has to keep THIS process alive.
//
// Child exit codes:
//   0    user wanted out (typed /exit, or SIGINT). Daemon stops too.
//   42   /upgrade — git pull && npm install && build:ext, then restart.
//   43   /restart — restart immediately, no git pull, no build.
//   44   /rewind — read ~/.egpt/rewind-target.txt for a git ref, then restart.
//   *    crash — restart with exponential backoff.
//
// Cross-platform install: see setup/install-linux.sh (systemd user unit),
// setup/install-macos.sh (LaunchAgent), setup/install-windows.ps1 (Task
// Scheduler with restart-on-failure). The OS service manager is the OUTER
// supervisor — it restarts egpt-daemon.mjs if THIS process crashes. Together:
// two layers, both proper, no PowerShell wrapper, no separate watchdog task.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveDaemonPid } from './src/daemon-singleton.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REWIND_SIDECAR = join(homedir(), '.egpt', 'rewind-target.txt');
const ALIVE_PATH = join(homedir(), '.egpt', 'state', 'alive.txt');
// Which checkout the daemon runs the APP (egpt.mjs) from. Default: this
// wrapper's own dir (the stable worktree). `/e source <path>` writes an
// absolute path here so the daemon can run a dev worktree without a second
// daemon (they share ~/.egpt). The WRAPPER itself always stays stable — only
// the spawned egpt.mjs and its git/build ops follow the source.
const SOURCE_FILE = join(homedir(), '.egpt', 'source-root.txt');
function activeRoot() {
  try {
    const p = readFileSync(SOURCE_FILE, 'utf8').trim();
    if (p && existsSync(join(p, 'egpt.mjs'))) return p;
  } catch { /* missing/unreadable → stable */ }
  return ROOT;
}
const RESTART_MIN_MS = 1_000;       // baseline crash-restart delay (operator 2026-05-31: "1s is enough")
const RESTART_MAX_MS = 10_000;      // cap on backoff (was 60s — local baileys reconnects in ~1s)
const UPGRADE_EXIT_CODE = 42;
const RESTART_EXIT_CODE = 43;
const REWIND_EXIT_CODE  = 44;
const CLEAN_EXIT_CODE   = 0;
// Heartbeat watchdog (operator 2026-05-31, "the real fix"): the supervisor
// polls the child's alive.txt every WATCHDOG_POLL_MS. If the latest tic/toc
// is older than WATCHDOG_STALE_MS, the child is wedged — kill (SIGTERM,
// SIGKILL after grace), respawn. No separate watchdog task / wrapper script
// needed; OS service manager just needs to keep THIS process alive.
//
// WATCHDOG_STALE_MS ADAPTS to the child's actual heartbeat interval
// (egpt.mjs reads heartbeat.interval_ms from ~/.egpt/config.yaml, default
// 3s). The supervisor reads the SAME config and computes a stale threshold
// of max(MIN_STALE_MS, 3 * heartbeat_ms). That way a 60s heartbeat config
// gets a 180s stale window (not a 10s "kill on every spawn" loop) — and
// a fresh 3s default heartbeat gets a 10s stale window. Operator 2026-05-31
// /restart bug: I hardcoded 10s while their config had heartbeat=60s,
// which made the supervisor kill the child before its 2nd beat.
const WATCHDOG_POLL_MS    = 1_000;    // 1s — local fs poll, cheap
const MIN_STALE_MS        = 10_000;   // floor: at least 10s before declaring stale
const STALE_MULTIPLIER    = 3;        // stale = 3 * heartbeat (allows 2 missed beats)
const WATCHDOG_GRACE_MS   = 2_000;    // 2s SIGTERM → SIGKILL grace
const POST_SPAWN_GRACE_MS = 5_000;    // 5s after spawn before first stale check
const HEARTBEAT_DEFAULT_MS = 3_000;   // matches ALIVE_INTERVAL_DEFAULT_MS in egpt.mjs

// Read the effective heartbeat interval from ~/.egpt/config.yaml without
// pulling in a YAML dep. Simple regex parse of the one key we care about.
function readHeartbeatIntervalMs() {
  const cfgPath = join(homedir(), '.egpt', 'config.yaml');
  try {
    if (!existsSync(cfgPath)) return HEARTBEAT_DEFAULT_MS;
    const yaml = readFileSync(cfgPath, 'utf8');
    // Look for `heartbeat:` block then `interval_ms: <N>` within ~10 lines.
    const m = yaml.match(/^heartbeat:[\s\S]{0,400}?^\s*interval_ms:\s*(\d+)/m);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 500) return n;
    }
  } catch { /* fall through to default */ }
  return HEARTBEAT_DEFAULT_MS;
}
const _hbInterval     = readHeartbeatIntervalMs();
const WATCHDOG_STALE_MS = Math.max(MIN_STALE_MS, STALE_MULTIPLIER * _hbInterval);
// git and npm still go through spawnSync with shell:true (the only
// way to invoke them portably across Windows .cmd shims, msys2,
// macOS, and Linux). The extension build, however, runs via dynamic
// import — see buildExtension(). Spawning `node extension/build.mjs`
// was returning status:null on the user's msys2 Windows for reasons
// we couldn't pin down; importing the build script in-process side-
// steps the whole spawn / shell / PATH / .cmd resolution mess.

// --headless: pass through to the supervised egpt.mjs child. Used by
// Task Scheduler "Run whether user is logged on or not" / launchd /
// systemd unit files — the engine runs without an Ink UI, captures
// WhatsApp/Telegram traffic to disk, and yields the WA pairing to a
// later interactive shell via the ~/.egpt/egpt.pid handshake.
const DAEMON_ARGS = process.argv.slice(2);
const HEADLESS = DAEMON_ARGS.includes('--headless');
const SHELL_ARGS = DAEMON_ARGS.filter(a => a !== '--headless');

let stopping = false;
let backoff = RESTART_MIN_MS;
let child = null;
let srcCrashes = 0;   // consecutive boot-crashes of a non-stable source
let spawnAt = 0;      // ms when the current child was spawned (crash-loop window)
let watchdogTimer = null;
let killInFlight = false;   // true while we're SIGTERMing + waiting for SIGKILL escalation

function log(msg) {
  process.stdout.write(`[egpt-daemon ${new Date().toISOString()}] ${msg}\n`);
}

function gitVersion(cwd = ROOT) {
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: 'pipe' });
  const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd, stdio: 'pipe' });
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: 'pipe' });
  return {
    sha:    (sha.stdout?.toString() ?? '').trim() || '???',
    tag:    (tag.stdout?.toString() ?? '').trim() || '(no tag)',
    branch: (branch.stdout?.toString() ?? '').trim() || '???',
  };
}

// Run the extension's build script in-process via dynamic import.
// This avoids the spawn/shell/PATH/.cmd zoo on msys2 Windows where
// `spawnSync('node extension/build.mjs', { shell: true })` returned
// status:null with no error. The build script uses top-level await,
// so the import itself drives the build and resolves when done.
// Cache-bust with a query string so repeated /upgrade re-imports the
// freshly-pulled source instead of the cached module.
async function buildExtension(root = ROOT) {
  log('building extension dist (in-process import)');
  try {
    const url = pathToFileURL(join(root, 'extension', 'build.mjs')).href + `?t=${Date.now()}`;
    await import(url);
    return true;
  } catch (e) {
    log(`build:ext failed: ${e.message}; continuing with current build`);
    return false;
  }
}

async function runUpgrade() {
  const root = activeRoot();   // upgrade the source the daemon actually runs
  const before = gitVersion(root).sha;
  log(`upgrade requested — git pull (currently ${before})${root !== ROOT ? `  [source: ${root}]` : ''}`);
  const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
  if (pull.status !== 0) {
    log('git pull failed; continuing with current code');
    return false;
  }
  const after = gitVersion(root);
  // Always rebuild the extension dist on /upgrade. Skipping when git
  // shows 'Already up to date' looked tidy, but it broke the case
  // where the user's checkout is already at the latest sha and they
  // need to refresh dist (e.g., they pulled manually outside the
  // daemon, or extension/dist was wiped). npm install only runs when
  // the sha actually changed (it's the heavier step).
  if (after.sha !== before) {
    log(`pulled ${before} -> ${after.sha} — running npm install`);
    const r = spawnSync('npm install', { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      log(`npm install exited ${r.status}${r.error ? `: ${r.error.message}` : ''}; continuing with current deps`);
      // Fall through and still attempt the build — esbuild's already
      // installed in node_modules from the previous run.
    }
  } else {
    log(`already up to date at ${after.sha} (${after.tag}, branch ${after.branch}) — rebuilding dist anyway`);
  }
  await buildExtension(root);
  log(`upgrade complete — now at ${after.sha} (${after.tag}, branch ${after.branch})`);
  return true;
}

async function runRewind() {
  let ref = null;
  try {
    ref = readFileSync(REWIND_SIDECAR, 'utf8').trim();
    unlinkSync(REWIND_SIDECAR);
  } catch (e) {
    log(`rewind requested but sidecar not readable (${e.message}); restarting anyway`);
    return false;
  }
  if (!ref) {
    log('rewind sidecar empty; restarting anyway');
    return false;
  }
  const root = activeRoot();
  log(`rewind requested → git checkout ${ref} && npm install && build:ext${root !== ROOT ? `  [source: ${root}]` : ''}`);
  for (const cmdline of ['git checkout ' + ref, 'npm install']) {
    const r = spawnSync(cmdline, { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      log(`rewind step failed (${cmdline})${r.error ? `: ${r.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
  }
  await buildExtension(root);
  log(`rewind to ${ref} complete`);
  return true;
}

// Read alive.txt's latest tic/toc timestamp. Returns ms since epoch, or 0
// if missing / unparseable. Same line format the prior watchdog.ps1 parsed
// ("<tic|toc> <iso> <pid> ..."); the newest stamp wins.
function readAliveLatestMs() {
  let content;
  try { content = readFileSync(ALIVE_PATH, 'utf8'); }
  catch { return 0; }
  const BEAT_RE = /^(?:tic|toc)\s+(\S+)/gm;
  let best = 0;
  for (const m of content.matchAll(BEAT_RE)) {
    const ts = Date.parse(m[1]);
    if (Number.isFinite(ts) && ts > best) best = ts;
  }
  return best;
}

// Kill the child + respawn. Used by the watchdog when alive.txt goes stale.
// SIGTERM first so egpt.mjs gets to flush bridges; SIGKILL after grace if it
// hasn't exited (child.on('exit') will then fire the existing respawn path).
function killChildAndLetWrapperRespawn(reason) {
  if (killInFlight || !child) return;
  killInFlight = true;
  const pid = child.pid;
  log(`watchdog: ${reason} — SIGTERM pid ${pid}, SIGKILL in ${WATCHDOG_GRACE_MS}ms if alive`);
  try { child.kill('SIGTERM'); } catch (e) { log(`watchdog: SIGTERM failed: ${e?.message ?? e}`); }
  setTimeout(() => {
    if (!child || child.pid !== pid) { killInFlight = false; return; }
    log(`watchdog: SIGTERM grace expired — SIGKILL pid ${pid}`);
    try { child.kill('SIGKILL'); } catch (e) { log(`watchdog: SIGKILL failed: ${e?.message ?? e}`); }
    killInFlight = false;
  }, WATCHDOG_GRACE_MS);
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (stopping || !child || killInFlight) return;
    // Grace period after spawn: alive.txt doesn't exist for the first few
    // seconds while egpt.mjs boots. Boot takes ~1.5s on a healthy box
    // (smoke test baseline); POST_SPAWN_GRACE_MS = 5s is generous.
    const sinceSpawn = Date.now() - spawnAt;
    const latest = readAliveLatestMs();
    if (latest === 0) {
      if (sinceSpawn > POST_SPAWN_GRACE_MS) {
        killChildAndLetWrapperRespawn(`no alive.txt after ${Math.round(sinceSpawn / 1000)}s`);
      }
      return;
    }
    const age = Date.now() - latest;
    if (age > WATCHDOG_STALE_MS) {
      killChildAndLetWrapperRespawn(`alive.txt stale (age=${Math.round(age / 1000)}s > ${WATCHDOG_STALE_MS / 1000}s)`);
    }
  }, WATCHDOG_POLL_MS);
  watchdogTimer.unref?.();
}

function spawnShell() {
  if (stopping) return;
  // Run egpt.mjs from the active source (default: this wrapper's own dir).
  // The wrapper stays put; only the app it launches follows `/e source`.
  const root = activeRoot();
  const appPath = join(root, 'egpt.mjs');
  const args = [appPath, ...SHELL_ARGS, ...(HEADLESS ? ['--headless'] : [])];
  log(`starting node egpt.mjs${root !== ROOT ? `  [source: ${root}]` : ''}`);
  spawnAt = Date.now();
  // In headless mode we don't inherit stdio — there's no tty to inherit
  // to under Task Scheduler's "Run whether user is logged on or not".
  // Pipe to /dev/null equivalents; egpt.mjs writes its own headless.log.
  // EGPT_SUPERVISED tells the child that THIS process is its supervisor and
  // will respawn it on exit codes 42/43/44 (upgrade/restart/rewind). The
  // child uses it to refuse /restart-style exits when absent — a user
  // running `node egpt.mjs` directly has no supervisor, so /restart would
  // just kill the shell (operator 2026-05-29).
  child = spawn('node', args, {
    cwd: root,
    stdio: HEADLESS ? 'ignore' : 'inherit',
    env: { ...process.env, EGPT_SUPERVISED: '1' },
  });

  child.on('exit', async (code, signal) => {
    child = null;
    if (stopping) return;
    log(`shell exited code=${code} signal=${signal ?? '-'}`);

    if (code === CLEAN_EXIT_CODE) {
      log('clean exit — egpt-daemon stopping (user wanted out)');
      process.exit(0);
    }
    srcCrashes = 0;   // any intentional exit (upgrade/restart/rewind) clears the crash-loop guard

    if (code === UPGRADE_EXIT_CODE) {
      await runUpgrade();
      backoff = RESTART_MIN_MS;
      spawnShell();
      return;
    }

    if (code === RESTART_EXIT_CODE) {
      log('restart requested — no upgrade, no build, no backoff');
      backoff = RESTART_MIN_MS;
      setImmediate(spawnShell);
      return;
    }

    if (code === REWIND_EXIT_CODE) {
      await runRewind();
      backoff = RESTART_MIN_MS;
      spawnShell();
      return;
    }

    // Crash. If a NON-stable source crash-loops on boot (crashes within 60s,
    // 3× running), revert to stable so a broken dev branch can't brick the
    // daemon (you couldn't type `/e source main` if it never boots).
    const ranMs = Date.now() - spawnAt;
    if (root !== ROOT && ranMs < 60_000) {
      srcCrashes += 1;
      if (srcCrashes >= 3) {
        log(`source ${root} crash-looped ${srcCrashes}× on boot — reverting to stable (${ROOT})`);
        try { unlinkSync(SOURCE_FILE); } catch {}
        srcCrashes = 0;
      }
    } else {
      srcCrashes = 0;   // ran a while before crashing → not a boot-loop
    }
    log(`crash — restarting in ${backoff}ms`);
    setTimeout(() => {
      backoff = Math.min(backoff * 2, RESTART_MAX_MS);
      spawnShell();
    }, backoff);
  });

  child.on('error', (err) => {
    log(`spawn error: ${err.message}`);
  });
}

function shutdown(sig) {
  stopping = true;
  log(`${sig} received — stopping egpt-daemon`);
  if (child) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  // Give the child a moment to flush before we exit.
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (process.platform !== 'win32') process.on('SIGHUP', () => shutdown('SIGHUP'));

// Singleton guard: refuse to start a second daemon while one is already
// alive (e.g. a manual `node egpt-daemon.mjs` launched alongside the
// scheduled task). Two daemons fight over WhatsApp and kill the bridge.
// Checked once at boot — NOT in spawnShell, so /restart's respawn (whose
// just-exited child's beat may still be on disk) is never blocked.
{
  let aliveContent = '';
  try { aliveContent = readFileSync(ALIVE_PATH, 'utf8'); } catch {}
  const otherPid = liveDaemonPid(aliveContent);
  if (otherPid) {
    log(`another egpt daemon is already alive (egpt.mjs pid ${otherPid}, alive.txt fresh) — refusing to start a second daemon that would fight over WhatsApp. Exiting.`);
    log(`to open an interactive shell instead, run \`node egpt.mjs\` (the app, not this supervisor) — it takes over the running daemon via the pidfile handshake and hands WA back when you /exit.`);
    process.exit(0);
  }
}

{
  const root = activeRoot();
  const v = gitVersion(root);
  log(`egpt-daemon up — wrapper in ${ROOT}; running app from ${root}`);
  log(`version: ${v.sha} (${v.tag}, branch ${v.branch})`);
}
spawnShell();
startWatchdog();
log(`watchdog: integrated (poll every ${WATCHDOG_POLL_MS / 1000}s, stale threshold ${WATCHDOG_STALE_MS / 1000}s, based on heartbeat interval ${_hbInterval / 1000}s from ${existsSync(join(homedir(), '.egpt', 'config.yaml')) ? 'config' : 'default'})`);
