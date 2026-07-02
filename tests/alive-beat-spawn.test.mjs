// The default alive beat is a shell one-liner (src/spine/boot.mjs): `echo beat >
// state/alive.txt`, spawned with shell:true and cwd = EGPT_HOME. Liveness now
// rests ENTIRELY on that file's mtime, so a beat that fails to land = a false
// wedge-kill. This proves the exact default command actually creates + re-touches
// the file under the real platform shell (Windows cmd / POSIX sh). Spawns a shell
// only — no claude, no real profile (a throwaway tmp dir is the cwd).
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// Must stay in sync with the default `aliveCommand` in src/spine/boot.mjs.
const ALIVE_COMMAND = 'echo beat > state/alive.txt';

function runBeat(cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn(ALIVE_COMMAND, { shell: true, cwd });
    c.on('error', reject);
    c.on('exit', (code) => resolve(code));
  });
}

describe('default alive beat (real spawn, cross-platform)', () => {
  it('creates state/alive.txt and advances its mtime on a second run', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'egpt-alive-echo-'));
    // boot mkdirs state/ (for spine.pid) before any beat fires; the echo redirect
    // only creates the FILE, not the directory — mirror that here.
    mkdirSync(join(home, 'state'), { recursive: true });
    const alive = join(home, 'state', 'alive.txt');
    try {
      const code1 = await runBeat(home);
      expect(code1).toBe(0);
      expect(existsSync(alive)).toBe(true);
      const m1 = statSync(alive).mtimeMs;

      await new Promise((r) => setTimeout(r, 50));   // clear the FS mtime granularity
      const code2 = await runBeat(home);
      expect(code2).toBe(0);
      const m2 = statSync(alive).mtimeMs;
      expect(m2).toBeGreaterThan(m1);   // beaten again — the deadman's freshness signal
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
