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
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REWIND_SIDECAR = join(homedir(), '.egpt', 'rewind-target.txt');
const RESTART_MIN_MS = 2_000;       // baseline crash-restart delay
const RESTART_MAX_MS = 60_000;      // cap on backoff
const UPGRADE_EXIT_CODE = 42;
const RESTART_EXIT_CODE = 43;
const REWIND_EXIT_CODE  = 44;
const CLEAN_EXIT_CODE   = 0;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

function runUpgrade() {
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
  // daemon, or extension/dist was wiped). The extra esbuild pass is
  // ~50ms — cheaper than confusion. npm install only runs when the
  // sha actually changed (it's the heavier step).
  if (after.sha !== before) {
    log(`pulled ${before} -> ${after.sha} — running npm install && npm run build:ext`);
    const r = spawnSync(npm, ['install'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      log(`upgrade step exited ${r.status} (npm install); continuing with current build`);
      return false;
    }
  } else {
    log(`already up to date at ${after.sha} (${after.tag}, branch ${after.branch}) — rebuilding dist anyway`);
  }
  const buildResult = spawnSync(npm, ['run', 'build:ext'], { cwd: ROOT, stdio: 'inherit' });
  if (buildResult.status !== 0) {
    log(`build:ext exited ${buildResult.status}; continuing with current build`);
    return false;
  }
  log(`upgrade complete — now at ${after.sha} (${after.tag}, branch ${after.branch})`);
  return true;
}

function runRewind() {
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
  log(`rewind requested → git checkout ${ref} && npm install && npm run build:ext`);
  const steps = [
    ['git', ['checkout', ref]],
    [npm,   ['install']],
    [npm,   ['run', 'build:ext']],
  ];
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      log(`rewind step failed (${cmd} ${args.join(' ')}); restarting anyway with current code`);
      return false;
    }
  }
  log(`rewind to ${ref} complete`);
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

    if (code === REWIND_EXIT_CODE) {
      runRewind();
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

{
  const v = gitVersion();
  log(`egpt-daemon up — keeping node egpt.mjs alive in ${ROOT}`);
  log(`version: ${v.sha} (${v.tag}, branch ${v.branch})`);
}
spawnShell();
