// tests/boot-smoke.test.mjs — the actual app boots cleanly.
//
// Spawn `node egpt.mjs --headless` in a sandboxed temp home, wait for the
// heartbeat file to appear, kill. This is the gate that catches "module-
// loads fine in isolation but the full process won't boot" — exactly the
// 2026-05-31 regression where my room/shell refactor made egpt.mjs hang
// on boot and the watchdog SIGTERMed every spawn (no stderr, no stdout,
// invisible to unit tests).
//
// What this test ASSERTS:
//   - Process spawns without immediate crash
//   - ~/.egpt/state/alive.txt appears within the expected window
//   - The file parses as the expected "<tic|toc> <iso> <pid>" format
// What this test DOES NOT ASSERT:
//   - Bridge connectivity (WA / TG / claude — all out of scope; require
//     credentials / network / brain processes)
//   - Functional behavior beyond "the process started and beats"
//
// Sandboxing: HOME / USERPROFILE / APPDATA all point at a fresh temp dir
// so the test doesn't touch the operator's real ~/.egpt. Default config
// has bridges disabled by lack of credentials.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EGPT_JS   = join(REPO_ROOT, 'egpt.mjs');

// Total budget: spawn + module-load + bridge inits + first heartbeat. On
// the operator's laptop egpt typically reaches alive.txt within ~3s. 10s
// is generous; if a real regression hangs boot, 10s is still fast enough
// not to bore the CI.
const BOOT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

const BEAT_RE = /^(?:tic|toc)\s+(\S+)\s+(\d+)\s*$/m;

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

describe('boot smoke', () => {
  it('egpt.mjs --headless writes a valid alive.txt within the boot budget', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'egpt-boot-'));
    const fakeHome = join(sandbox, 'home');
    await mkdir(fakeHome, { recursive: true });
    const alivePath = join(fakeHome, '.egpt', 'state', 'alive.txt');

    // Spawn with HOME / USERPROFILE overridden so egpt's `os.homedir()`
    // points at our sandbox. EGPT_SUPERVISED tells egpt this is a daemon-
    // managed child (the path the heartbeat writer takes). stdio captured
    // so a boot-time crash leaves visible diagnostics for the test
    // failure message.
    const child = spawn(process.execPath, [EGPT_JS, '--headless'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME:        fakeHome,
        USERPROFILE: fakeHome,
        APPDATA:     join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA:join(fakeHome, 'AppData', 'Local'),
        EGPT_SUPERVISED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout?.on('data', b => out.push(b.toString()));
    child.stderr?.on('data', b => err.push(b.toString()));
    const earlyExit = new Promise(resolve => child.once('exit', (code, sig) => resolve({ code, sig })));

    let aliveOk = false;
    try {
      aliveOk = await Promise.race([
        waitForFile(alivePath, BOOT_TIMEOUT_MS),
        earlyExit.then(({ code, sig }) => {
          throw new Error(`egpt.mjs exited before alive.txt appeared (code=${code} sig=${sig})\nstderr:\n${err.join('').slice(-2000)}\nstdout:\n${out.join('').slice(-1000)}`);
        }),
      ]);
    } finally {
      try { child.kill('SIGTERM'); } catch {}
      // Give it a beat to flush, then SIGKILL if still alive.
      await new Promise(r => setTimeout(r, 500));
      try { child.kill('SIGKILL'); } catch {}
      try { await rm(sandbox, { recursive: true, force: true }); } catch {}
    }

    if (!aliveOk) {
      throw new Error(
        `alive.txt never appeared at ${alivePath} within ${BOOT_TIMEOUT_MS / 1000}s.\n` +
        `stderr (last 2KB):\n${err.join('').slice(-2000)}\n` +
        `stdout (last 1KB):\n${out.join('').slice(-1000)}`,
      );
    }

    // Re-read in the parent (the finally above rm'd sandbox; we read BEFORE
    // that via the loop above? No — the read happens after waitForFile
    // returns true but before the finally; sandbox is alive). To keep the
    // assertion robust, re-stat the path now is moot — we already proved
    // existence. Instead read while child + sandbox are still alive.
    // (Restructure: do the parse before finally tears down.)
  }, BOOT_TIMEOUT_MS + 5_000);

  // Separate test for the format assertion so we don't race the cleanup.
  it('alive.txt format is parseable (<tic|toc> <iso> <pid>)', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'egpt-boot-'));
    const fakeHome = join(sandbox, 'home');
    await mkdir(fakeHome, { recursive: true });
    const alivePath = join(fakeHome, '.egpt', 'state', 'alive.txt');

    const child = spawn(process.execPath, [EGPT_JS, '--headless'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: fakeHome, USERPROFILE: fakeHome,
        APPDATA: join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
        EGPT_SUPERVISED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let beatLine = null;
    try {
      const ok = await waitForFile(alivePath, BOOT_TIMEOUT_MS);
      if (!ok) throw new Error('alive.txt never appeared');
      const content = await readFile(alivePath, 'utf8');
      const match = content.match(BEAT_RE);
      if (!match) throw new Error(`alive.txt does not match BEAT_RE\ncontents:\n${content}`);
      beatLine = match;
    } finally {
      try { child.kill('SIGTERM'); } catch {}
      await new Promise(r => setTimeout(r, 500));
      try { child.kill('SIGKILL'); } catch {}
      try { await rm(sandbox, { recursive: true, force: true }); } catch {}
    }

    expect(beatLine).toBeTruthy();
    const [, iso, pidStr] = beatLine;
    expect(Number.isFinite(Date.parse(iso))).toBe(true);
    expect(Number(pidStr)).toBeGreaterThan(0);
  }, BOOT_TIMEOUT_MS + 5_000);
});
