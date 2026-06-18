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
  const egptHome = opts.egptHome ?? join(homedir(), '.egpt');
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
  const importModule = opts.importModule ?? ((url) => import(url));
  const now = opts.now ?? Date.now;

  const rewindSidecar = opts.rewindSidecar ?? join(egptHome, 'rewind-target.txt');
  const alivePath = opts.alivePath ?? join(egptHome, 'state', 'alive.txt');
  const sourceFile = opts.sourceFile ?? join(egptHome, 'source-root.txt');

  const headless = argv.includes('--headless');
  const shellArgs = argv.filter((a) => a !== '--headless');

  let stopping = false;
  let backoff = RESTART_MIN_MS;
  let child = null;
  let srcCrashes = 0;
  let spawnAt = 0;

  function log(msg) {
    stdout.write(`[egpt-daemon ${new Date(now()).toISOString()}] ${msg}\n`);
  }

  function activeRoot() {
    try {
      const p = readFileSync(sourceFile, 'utf8').trim();
      if (p && existsSync(join(p, 'egpt.mjs'))) return p;
    } catch { /* missing/unreadable -> stable */ }
    return root;
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
    const appRoot = activeRoot();
    const before = gitVersion(appRoot).sha;
    log(`upgrade requested — git pull (currently ${before})${appRoot !== root ? `  [source: ${appRoot}]` : ''}`);
    const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: appRoot, stdio: 'inherit' });
    if (pull.status !== 0) {
      log('git pull failed; continuing with current code');
      return false;
    }
    const after = gitVersion(appRoot);
    if (after.sha !== before) {
      log(`pulled ${before} -> ${after.sha} — running npm install`);
      const r = spawnSync('npm install', { cwd: appRoot, stdio: 'inherit', shell: true });
      if (r.status !== 0) {
        log(`npm install exited ${r.status}${r.error ? `: ${r.error.message}` : ''}; continuing with current deps`);
      }
    } else {
      log(`already up to date at ${after.sha} (${after.tag}, branch ${after.branch}) — rebuilding dist anyway`);
    }
    await buildExtension(appRoot);
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
    const appRoot = activeRoot();
    log(`rewind requested → git checkout ${ref} && npm install && build:ext${appRoot !== root ? `  [source: ${appRoot}]` : ''}`);
    const co = spawnSync('git', ['checkout', ref], { cwd: appRoot, stdio: 'inherit' });
    if (co.status !== 0) {
      log(`rewind step failed (git checkout ${ref})${co.error ? `: ${co.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
    const ni = spawnSync('npm install', { cwd: appRoot, stdio: 'inherit', shell: true });
    if (ni.status !== 0) {
      log(`rewind step failed (npm install)${ni.error ? `: ${ni.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
    await buildExtension(appRoot);
    log(`rewind to ${ref} complete`);
    return true;
  }

  function spawnShell() {
    if (stopping) return null;
    const appRoot = activeRoot();
    const appPath = join(appRoot, 'egpt.mjs');
    const args = [appPath, ...shellArgs, ...(headless ? ['--headless'] : [])];
    log(`starting node egpt.mjs${appRoot !== root ? `  [source: ${appRoot}]` : ''}`);
    spawnAt = now();
    child = spawn('node', args, {
      cwd: appRoot,
      stdio: headless ? 'ignore' : 'inherit',
      env: { ...processObj.env, EGPT_SUPERVISED: '1' },
    });

    child.on('exit', async (code, signal) => {
      child = null;
      if (stopping) return;
      log(`shell exited code=${code} signal=${signal ?? '-'}`);

      if (code === CLEAN_EXIT_CODE) {
        log('clean exit — egpt-daemon stopping (user wanted out)');
        processObj.exit(0);
        return;
      }
      srcCrashes = 0;

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

      const ranMs = now() - spawnAt;
      if (appRoot !== root && ranMs < 60_000) {
        srcCrashes += 1;
        if (srcCrashes >= 3) {
          log(`source ${appRoot} crash-looped ${srcCrashes}× on boot — reverting to stable (${root})`);
          try { unlinkSync(sourceFile); } catch {}
          srcCrashes = 0;
        }
      } else {
        srcCrashes = 0;
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
    const appRoot = activeRoot();
    const v = gitVersion(appRoot);
    log(`egpt-daemon up — wrapper in ${root}; running app from ${appRoot}`);
    log(`version: ${v.sha} (${v.tag}, branch ${v.branch})`);
    return spawnShell();
  }

  return {
    activeRoot,
    buildExtension,
    checkSingleton,
    gitVersion,
    registerSignals,
    runRewind,
    runUpgrade,
    shutdown,
    spawnShell,
    start,
    get child() { return child; },
    get state() { return { stopping, backoff, srcCrashes, spawnAt, headless, shellArgs: [...shellArgs] }; },
  };
}
