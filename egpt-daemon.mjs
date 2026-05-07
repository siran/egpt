#!/usr/bin/env node
// egpt-daemon.mjs — keeps `node egpt.mjs` running.
//
// Spawns the shell as a child, restarts on crash with exponential backoff.
// Three distinguished exit codes from the shell:
//
//   0    user wanted out (typed /exit, or SIGINT). Daemon stops too.
//   42   /upgrade — run `git pull && npm install && npm run build:ext`,
//        then restart.
//   43   /restart — restart immediately, no git pull, no build.
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
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RESTART_MIN_MS = 2_000;       // baseline crash-restart delay
const RESTART_MAX_MS = 60_000;      // cap on backoff
const UPGRADE_EXIT_CODE = 42;
const RESTART_EXIT_CODE = 43;
const CLEAN_EXIT_CODE   = 0;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let stopping = false;
let backoff = RESTART_MIN_MS;
let child = null;

function log(msg) {
  process.stdout.write(`[egpt-daemon ${new Date().toISOString()}] ${msg}\n`);
}

function runUpgrade() {
  log('upgrade requested — git pull && npm install && npm run build:ext');
  const steps = [
    ['git', ['pull', '--ff-only']],
    [npm,   ['install']],
    [npm,   ['run', 'build:ext']],
  ];
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      log(`upgrade step failed (${cmd} ${args.join(' ')}); restarting anyway with previous code`);
      return false;
    }
  }
  log('upgrade complete');
  return true;
}

function spawnShell() {
  if (stopping) return;
  log('starting node egpt.mjs');
  child = spawn('node', ['egpt.mjs'], { cwd: ROOT, stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    log(`shell exited code=${code} signal=${signal ?? '-'}`);

    if (code === CLEAN_EXIT_CODE) {
      log('clean exit — egpt-daemon stopping (user wanted out)');
      process.exit(0);
    }

    if (code === UPGRADE_EXIT_CODE) {
      runUpgrade();
      backoff = RESTART_MIN_MS;
      setImmediate(spawnShell);
      return;
    }

    if (code === RESTART_EXIT_CODE) {
      log('restart requested — no upgrade, no backoff');
      backoff = RESTART_MIN_MS;
      setImmediate(spawnShell);
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

log(`egpt-daemon up — keeping node egpt.mjs alive in ${ROOT}`);
spawnShell();
