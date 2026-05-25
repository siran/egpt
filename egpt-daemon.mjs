#!/usr/bin/env node
// egpt-daemon.mjs — keeps `node egpt.mjs` running.
//
// Spawns the shell as a child, restarts on crash with exponential backoff.
// Four distinguished exit codes from the shell:
//
//   0    user wanted out (typed /exit, or SIGINT). Daemon stops too.
//   42   /upgrade — run `git pull && npm install && npm run build:ext`,
//        then restart.
//   43   /restart — restart immediately, no git pull, no build.
//   44   /rewind — read ~/.egpt/rewind-target.txt for a git ref, run
//        `git checkout <ref> && npm install && npm run build:ext`,
//        then restart.
//
// Any other exit code is treated as a crash and triggers restart with backoff.
//
// Cross-platform. To run on Windows logon:
//
//   schtasks /Create /TN "egpt-daemon" `
//     /TR "node \"%USERPROFILE%\src\egpt\egpt-daemon.mjs\"" `
//     /SC ONLOGON /RL HIGHEST /F
//
// On macOS / Linux: a launchd plist or systemd --user unit pointing at
// `node /path/to/egpt-daemon.mjs`. See README for details.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveDaemonPid } from './src/daemon-singleton.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REWIND_SIDECAR = join(homedir(), '.egpt', 'rewind-target.txt');
const ALIVE_PATH = join(homedir(), '.egpt', 'state', 'alive.txt');
const RESTART_MIN_MS = 2_000;       // baseline crash-restart delay
const RESTART_MAX_MS = 60_000;      // cap on backoff
const UPGRADE_EXIT_CODE = 42;
const RESTART_EXIT_CODE = 43;
const REWIND_EXIT_CODE  = 44;
const CLEAN_EXIT_CODE   = 0;
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

function log(msg) {
  process.stdout.write(`[egpt-daemon ${new Date().toISOString()}] ${msg}\n`);
}

function gitVersion() {
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
  const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, stdio: 'pipe' });
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
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
async function buildExtension() {
  log('building extension dist (in-process import)');
  try {
    const url = pathToFileURL(join(ROOT, 'extension', 'build.mjs')).href + `?t=${Date.now()}`;
    await import(url);
    return true;
  } catch (e) {
    log(`build:ext failed: ${e.message}; continuing with current build`);
    return false;
  }
}

async function runUpgrade() {
  const before = gitVersion().sha;
  log(`upgrade requested — git pull (currently ${before})`);
  const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: 'inherit' });
  if (pull.status !== 0) {
    log('git pull failed; continuing with current code');
    return false;
  }
  const after = gitVersion();
  // Always rebuild the extension dist on /upgrade. Skipping when git
  // shows 'Already up to date' looked tidy, but it broke the case
  // where the user's checkout is already at the latest sha and they
  // need to refresh dist (e.g., they pulled manually outside the
  // daemon, or extension/dist was wiped). npm install only runs when
  // the sha actually changed (it's the heavier step).
  if (after.sha !== before) {
    log(`pulled ${before} -> ${after.sha} — running npm install`);
    const r = spawnSync('npm install', { cwd: ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      log(`npm install exited ${r.status}${r.error ? `: ${r.error.message}` : ''}; continuing with current deps`);
      // Fall through and still attempt the build — esbuild's already
      // installed in node_modules from the previous run.
    }
  } else {
    log(`already up to date at ${after.sha} (${after.tag}, branch ${after.branch}) — rebuilding dist anyway`);
  }
  await buildExtension();
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
  log(`rewind requested → git checkout ${ref} && npm install && build:ext`);
  for (const cmdline of ['git checkout ' + ref, 'npm install']) {
    const r = spawnSync(cmdline, { cwd: ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      log(`rewind step failed (${cmdline})${r.error ? `: ${r.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
  }
  await buildExtension();
  log(`rewind to ${ref} complete`);
  return true;
}

function spawnShell() {
  if (stopping) return;
  const args = ['egpt.mjs', ...SHELL_ARGS, ...(HEADLESS ? ['--headless'] : [])];
  log(`starting node ${args.join(' ')}`);
  // In headless mode we don't inherit stdio — there's no tty to inherit
  // to under Task Scheduler's "Run whether user is logged on or not".
  // Pipe to /dev/null equivalents; egpt.mjs writes its own headless.log.
  child = spawn('node', args, {
    cwd: ROOT,
    stdio: HEADLESS ? 'ignore' : 'inherit',
  });

  child.on('exit', async (code, signal) => {
    child = null;
    if (stopping) return;
    log(`shell exited code=${code} signal=${signal ?? '-'}`);

    if (code === CLEAN_EXIT_CODE) {
      log('clean exit — egpt-daemon stopping (user wanted out)');
      process.exit(0);
    }

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

    // Crash — back off and retry.
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
    process.exit(0);
  }
}

{
  const v = gitVersion();
  log(`egpt-daemon up — keeping node egpt.mjs alive in ${ROOT}`);
  log(`version: ${v.sha} (${v.tag}, branch ${v.branch})`);
}
spawnShell();
