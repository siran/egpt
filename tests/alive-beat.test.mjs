// The alive beat script (src/tools/alive.mjs): writeBeat's exact daemon-contract
// line, tic/toc alternation derived from the current file, absent-file default,
// oldestSec rounding, and that the pid comes from the caller (the spine), not the
// script's own process. Plus a CLI end-to-end that proves the env contract
// (EGPT_HOME / EGPT_SPINE_PID / EGPT_QUEUE_* → the written line). All against
// tmp/fake IO — never the real profile.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { writeBeat } from '../src/tools/alive.mjs';
import { liveDaemonPid } from '../src/daemon-singleton.mjs';

// In-memory IO keyed by the exact path writeBeat computes (join(egptHome,'state',...)).
function fakeIo(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFile: async (p) => { if (p in files) return files[p]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    writeFile: async (p, c) => { files[p] = c; },
    mkdir: async () => {},
  };
}
const ALIVE = (home) => join(home, 'state', 'alive.txt');

describe('writeBeat', () => {
  it('writes the EXACT daemon-contract line; daemon-singleton parses the spine pid back', async () => {
    const io = fakeIo();
    const line = await writeBeat({
      egptHome: '/home', pid: '424242', queueDepth: 7, oldestMs: 1600,
      now: () => Date.UTC(2026, 5, 29, 14, 5), io,
    });
    expect(line).toBe('tic 2026-06-29T14:05:00.000Z 424242 q=7 oldest=2s\n');
    // shape the daemon parsers accept (src/daemon-runtime newestBeatMs + singleton BEAT_RE)
    expect(line).toMatch(/^(?:tic|toc) \S+ \d+ q=\d+ oldest=\d+s\n$/);
    // and the singleton actually reads the pid out of it (fresh beat, live pid)
    expect(liveDaemonPid(line, { now: Date.UTC(2026, 5, 29, 14, 5, 1), selfPid: 1, isAlive: () => true })).toBe(424242);
    // landed at <egptHome>/state/alive.txt
    expect(io.files[ALIVE('/home')]).toBe(line);
  });

  it('the pid is the caller-supplied (spine) pid, not the script process pid', async () => {
    const line = await writeBeat({ egptHome: '/home', pid: '424242', now: () => 0, io: fakeIo() });
    expect(line.match(/^(?:tic|toc) \S+ (\d+) /)[1]).toBe('424242');
    expect(line).not.toContain(String(process.pid));
  });

  it('alternates tic/toc from the CURRENT first token; absent/unreadable → tic', async () => {
    // toc → tic
    const t2 = await writeBeat({ egptHome: '/home', pid: '9', now: () => 0, io: fakeIo({ [ALIVE('/home')]: 'toc 2026-06-29T14:05:00.000Z 1 q=0 oldest=0s\n' }) });
    expect(t2.startsWith('tic ')).toBe(true);
    // tic → toc
    const t3 = await writeBeat({ egptHome: '/home', pid: '9', now: () => 0, io: fakeIo({ [ALIVE('/home')]: 'tic 2026-06-29T14:05:00.000Z 1 q=0 oldest=0s\n' }) });
    expect(t3.startsWith('toc ')).toBe(true);
    // no file → tic
    const t1 = await writeBeat({ egptHome: '/home', pid: '9', now: () => 0, io: fakeIo() });
    expect(t1.startsWith('tic ')).toBe(true);
  });

  it('rounds oldestMs to whole seconds', async () => {
    const sec = async (oldestMs) => (await writeBeat({ egptHome: '/home', pid: '9', oldestMs, now: () => 0, io: fakeIo() })).match(/oldest=(\d+)s/)[1];
    expect(await sec(1499)).toBe('1');
    expect(await sec(1500)).toBe('2');
    expect(await sec(12000)).toBe('12');
    expect(await sec(0)).toBe('0');
  });
});

describe('alive.mjs CLI', () => {
  const scriptPath = fileURLToPath(new URL('../src/tools/alive.mjs', import.meta.url));

  it('reads EGPT_HOME / EGPT_SPINE_PID / EGPT_QUEUE_* and writes the beat under EGPT_HOME/state', () => {
    const home = join(os.tmpdir(), `egpt-alive-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const r = spawnSync(process.execPath, [scriptPath], {
        env: { ...process.env, EGPT_HOME: home, EGPT_SPINE_PID: '4242', EGPT_QUEUE_DEPTH: '5', EGPT_QUEUE_OLDEST_MS: '1600' },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      const line = readFileSync(ALIVE(home), 'utf8');
      // the injected SPINE pid + pump stats, in the contract shape
      expect(line).toMatch(/^tic \S+ 4242 q=5 oldest=2s\n$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
