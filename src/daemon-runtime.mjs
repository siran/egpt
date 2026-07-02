import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync, unlinkSync as nodeUnlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveDaemonPid as defaultLiveDaemonPid } from './daemon-singleton.mjs';

export const RESTART_MIN_MS = 2_000;
export const RESTART_MAX_MS = 60_000;
export const UPGRADE_EXIT_CODE = 42;
export const RESTART_EXIT_CODE = 43;
export const REWIND_EXIT_CODE = 44;
export const CLEAN_EXIT_CODE = 0;

const DEFAULT_ROOT = dirname(fileURLToPath(new URL('../egpt-daemon.mjs', import.meta.url)));

export function createDaemonRuntime(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  // Profile-aware: EGPT_HOME selects the node, so independent nodes (each its own
  // ~/.egptN) get their own singleton + alive.txt and don't fight each other.
  const egptHome = opts.egptHome ?? process.env.EGPT_HOME ?? join(homedir(), '.egpt');
  const argv = opts.argv ?? process.argv.slice(2);
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? nodeSpawn;
  const spawnSync = opts.spawnSync ?? nodeSpawnSync;
  const readFileSync = opts.readFileSync ?? nodeReadFileSync;
  const unlinkSync = opts.unlinkSync ?? nodeUnlinkSync;
  const existsSync = opts.existsSync ?? nodeExistsSync;
  const liveDaemonPid = opts.liveDaemonPid ?? defaultLiveDaemonPid;
  const processObj = opts.processObj ?? process;
  const stdout = opts.stdout ?? process.stdout;
  const setTimeoutFn = opts.setTimeout ?? setTimeout;
  const setImmediateFn = opts.setImmediate ?? setImmediate;
  const setIntervalFn = opts.setInterval ?? setInterval;
  const clearIntervalFn = opts.clearInterval ?? clearInterval;
  const importModule = opts.importModule ?? ((url) => import(url));
  const now = opts.now ?? Date.now;

  const rewindSidecar = opts.rewindSidecar ?? join(egptHome, 'rewind-target.txt');
  const alivePath = opts.alivePath ?? join(egptHome, 'state', 'alive.txt');

  // Wedge check: the spine beats alive.txt (~60s). If a running child stops
  // beating (alive process, dead loop), restart it. graceMs covers boot before
  // the first beat; staleMs ~ a couple missed beats.
  const livenessIntervalMs = opts.livenessIntervalMs ?? 30_000;
  const aliveStaleMs = opts.aliveStaleMs ?? 150_000;
  const aliveGraceMs = opts.aliveGraceMs ?? 90_000;
  let childStartedAt = 0, livenessTimer = null;

  // v2 entry takes no role flags; pass argv straight through (egpt.mjs ignores it).
  const shellArgs = argv;

  let stopping = false;
  let backoff = RESTART_MIN_MS;
  let child = null;
  // Consecutive wedge kills without a fresh beat in between. Each one escalates
  // the respawn delay (RESTART_MIN_MS·2^(streak-1), capped at RESTART_MAX_MS) so a
  // permanently-dead heartbeat (e.g. heartbeats disabled) doesn't hot-loop
  // kill+respawn every few minutes forever — it backs off calmly and keeps
  // respawning "until the service is stopped or the heartbeat restored" (operator
  // 2026-07-01). A fresh beat observed by checkLiveness resets it.
  let wedgeStreak = 0;
  // Set by checkLiveness right before it SIGTERMs a wedged child, so the exit
  // handler can tell that kill apart from an operator-initiated stop. On POSIX a
  // wedged child traps SIGTERM and exits 0 (egpt.mjs) — identical to a clean
  // /exit — so without this flag the daemon would stop the whole service instead
  // of respawning. (On Windows kill() hard-terminates with a non-0 code, so it
  // "worked" there by accident; this makes the wedge-restart path uniform.)
  let wedgeKilled = false;

  function log(msg) {
    stdout.write(`[egpt-daemon ${new Date(now()).toISOString()}] ${msg}\n`);
  }

  // Newest beat's epoch ms from alive.txt ("<tic|toc> <iso> <pid> [q=.. oldest=..]"),
  // or null. Trailing fields after the pid (pump depth/age the spine now appends)
  // are tolerated; the bare old form is still accepted so mixed lines during an
  // upgrade parse fine.
  function newestBeatMs(content) {
    const beats = [...String(content ?? '').matchAll(/^(?:tic|toc)\s+(\S+)\s+\d+(?:[ \t].*)?$/gm)];
    if (!beats.length) return null;
    const ts = Date.parse(beats[beats.length - 1][1]);
    return Number.isFinite(ts) ? ts : null;
  }

  // The newest beat's full line (incl. the q=.. oldest=.. tail), for the wedge log
  // — so the last-known queue state is in the daemon log when it kills.
  function newestBeatLine(content) {
    const lines = [...String(content ?? '').matchAll(/^(?:tic|toc)\s+.*$/gm)];
    return lines.length ? lines[lines.length - 1][0].trim() : null;
  }

  // The wedge check: a running child that stopped beating gets a SIGTERM, which
  // routes through the normal exit handler → respawn. Honors a boot grace window
  // so a just-spawned (still-booting) child is never killed for not-yet-beating.
  function checkLiveness() {
    if (stopping || !child) return;
    if (now() - childStartedAt < aliveGraceMs) return;
    let content = '';
    try { content = readFileSync(alivePath, 'utf8'); } catch { /* no beat file yet */ }
    const beat = newestBeatMs(content);
    const age = beat == null ? Infinity : now() - beat;
    if (age > aliveStaleMs) {
      const tail = newestBeatLine(content);
      log(`spine wedged — alive beat ${beat == null ? 'absent' : `${Math.round(age / 1000)}s old`} (> ${Math.round(aliveStaleMs / 1000)}s)${tail ? ` — last beat: ${tail}` : ''} — restarting`);
      wedgeKilled = true;   // exit handler: respawn, don't read a SIGTERM-induced exit 0 as an operator stop
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      return;
    }
    wedgeStreak = 0;   // a fresh beat — heartbeat restored, clear the escalation
  }

  function gitVersion(cwd = root) {
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: 'pipe' });
    const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd, stdio: 'pipe' });
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: 'pipe' });
    return {
      sha: (sha.stdout?.toString() ?? '').trim() || '???',
      tag: (tag.stdout?.toString() ?? '').trim() || '(no tag)',
      branch: (branch.stdout?.toString() ?? '').trim() || '???',
    };
  }

  async function buildExtension(buildRoot = root) {
    log('building extension dist (in-process import)');
    try {
      const url = pathToFileURL(join(buildRoot, 'extension', 'build.mjs')).href + `?t=${now()}`;
      await importModule(url);
      return true;
    } catch (e) {
      log(`build:ext failed: ${e.message}; continuing with current build`);
      return false;
    }
  }

  async function runUpgrade() {
    const before = gitVersion(root).sha;
    log(`upgrade requested — git pull (currently ${before})`);
    const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
    if (pull.status !== 0) {
      log('git pull failed; continuing with current code');
      return false;
    }
    const after = gitVersion(root);
    if (after.sha !== before) {
      log(`pulled ${before} -> ${after.sha} — running npm install`);
      const r = spawnSync('npm install', { cwd: root, stdio: 'inherit', shell: true });
      if (r.status !== 0) {
        log(`npm install exited ${r.status}${r.error ? `: ${r.error.message}` : ''}; continuing with current deps`);
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
      ref = readFileSync(rewindSidecar, 'utf8').trim();
      unlinkSync(rewindSidecar);
    } catch (e) {
      log(`rewind requested but sidecar not readable (${e.message}); restarting anyway`);
      return false;
    }
    if (!ref) {
      log('rewind sidecar empty; restarting anyway');
      return false;
    }
    if (ref.startsWith('-') || !/^[\w./^~@-]+$/.test(ref)) {
      log(`rewind ref ${JSON.stringify(ref)} doesn't look like a git ref; refusing — restarting with current code`);
      return false;
    }
    log(`rewind requested → git checkout ${ref} && npm install && build:ext`);
    const co = spawnSync('git', ['checkout', ref], { cwd: root, stdio: 'inherit' });
    if (co.status !== 0) {
      log(`rewind step failed (git checkout ${ref})${co.error ? `: ${co.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
    const ni = spawnSync('npm install', { cwd: root, stdio: 'inherit', shell: true });
    if (ni.status !== 0) {
      log(`rewind step failed (npm install)${ni.error ? `: ${ni.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
    await buildExtension(root);
    log(`rewind to ${ref} complete`);
    return true;
  }

  function spawnShell() {
    if (stopping) return null;
    const appPath = join(root, 'egpt.mjs');
    const args = [appPath, ...shellArgs];
    log('starting node egpt.mjs');
    childStartedAt = now();
    child = spawn('node', args, {
      cwd: root,
      stdio: 'inherit',   // NSSM captures stdout/stderr to the service logs
      env: { ...processObj.env, EGPT_SUPERVISED: '1' },
    });

    child.on('exit', async (code, signal) => {
      child = null;
      if (stopping) return;
      log(`shell exited code=${code} signal=${signal ?? '-'}`);

      // A wedge-kill must respawn regardless of exit code: on POSIX the SIGTERM'd
      // child exits 0, which would otherwise fall into the clean-exit branch and
      // stop the whole daemon. Respawn — but ESCALATE the delay per consecutive
      // wedge so a permanently-dead heartbeat backs off instead of hot-looping.
      if (wedgeKilled) {
        wedgeKilled = false;
        wedgeStreak += 1;
        const delay = Math.min(RESTART_MIN_MS * 2 ** (wedgeStreak - 1), RESTART_MAX_MS);
        log(`no heartbeat from the spine — respawn #${wedgeStreak} in ${Math.round(delay / 1000)}s (stop the service or restore the heartbeat)`);
        setTimeoutFn(spawnShell, delay);
        return;
      }

      if (code === CLEAN_EXIT_CODE) {
        log('clean exit — egpt-daemon stopping (user wanted out)');
        processObj.exit(0);
        return;
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
        setImmediateFn(spawnShell);
        return;
      }

      if (code === REWIND_EXIT_CODE) {
        await runRewind();
        backoff = RESTART_MIN_MS;
        spawnShell();
        return;
      }

      log(`crash — restarting in ${backoff}ms`);
      setTimeoutFn(() => {
        backoff = Math.min(backoff * 2, RESTART_MAX_MS);
        spawnShell();
      }, backoff);
    });

    child.on('error', (err) => {
      log(`spawn error: ${err.message}`);
    });
    return child;
  }

  function shutdown(sig) {
    stopping = true;
    log(`${sig} received — stopping egpt-daemon`);
    if (livenessTimer) { clearIntervalFn(livenessTimer); livenessTimer = null; }
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
    setTimeoutFn(() => processObj.exit(0), 500);
  }

  function checkSingleton() {
    let aliveContent = '';
    try { aliveContent = readFileSync(alivePath, 'utf8'); } catch {}
    const otherPid = liveDaemonPid(aliveContent);
    if (otherPid) {
      log(`another egpt daemon is already alive (egpt.mjs pid ${otherPid}, alive.txt fresh) — refusing to start a second daemon that would fight over WhatsApp. Exiting.`);
      log('to open an interactive shell instead, run `node egpt.mjs` (the app, not this supervisor) — it takes over the running daemon via the pidfile handshake and hands WA back when you /exit.');
      processObj.exit(0);
      return false;
    }
    return true;
  }

  function registerSignals() {
    processObj.on('SIGINT', () => shutdown('SIGINT'));
    processObj.on('SIGTERM', () => shutdown('SIGTERM'));
    if (platform !== 'win32') processObj.on('SIGHUP', () => shutdown('SIGHUP'));
  }

  function start() {
    registerSignals();
    if (!checkSingleton()) return null;
    const v = gitVersion(root);
    log(`egpt-daemon up — running app from ${root} (profile ${egptHome})`);
    log(`version: ${v.sha} (${v.tag}, branch ${v.branch})`);
    const c = spawnShell();
    if (livenessIntervalMs > 0 && !livenessTimer) {
      livenessTimer = setIntervalFn(checkLiveness, livenessIntervalMs);
      livenessTimer?.unref?.();
    }
    return c;
  }

  return {
    buildExtension,
    checkLiveness,
    checkSingleton,
    gitVersion,
    registerSignals,
    runRewind,
    runUpgrade,
    shutdown,
    spawnShell,
    start,
    get child() { return child; },
    get state() { return { stopping, backoff, wedgeStreak, shellArgs: [...shellArgs] }; },
  };
}
