// The Session 1 task's launcher (setup/session1-daemon-launcher.vbs), run for real under cscript with
// a fake egpt-daemon.mjs that records its environment and exits with the codes it is given in turn.
// /upgrade full ends the daemon with 46: the launcher is what brings it back, so it is also what says so.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respawnsOf, UPGRADE_FULL_EXIT_CODE } from '../src/daemon-runtime.mjs';

const LAUNCHER = join(import.meta.dirname, '..', 'setup', 'session1-daemon-launcher.vbs');

const FAKE_DAEMON = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const codes = JSON.parse(readFileSync('codes.json', 'utf8'));
const runs = existsSync('runs.jsonl') ? readFileSync('runs.jsonl', 'utf8').split('\\n').filter(Boolean).length : 0;
const { EGPT_DAEMON_RESPAWNS = null, EGPT_SESSION1 = null, EGPT_HOME = null } = process.env;
appendFileSync('runs.jsonl', JSON.stringify({ EGPT_DAEMON_RESPAWNS, EGPT_SESSION1, EGPT_HOME }) + '\\n');
process.exit(codes[Math.min(runs, codes.length - 1)]);
`;

describe.skipIf(process.platform !== 'win32')('session1-daemon-launcher.vbs', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  const launch = (codes) => {
    dir = mkdtempSync(join(tmpdir(), 'egpt-s1-launcher-'));
    writeFileSync(join(dir, 'egpt-daemon.mjs'), FAKE_DAEMON);
    writeFileSync(join(dir, 'codes.json'), JSON.stringify(codes));
    const home = join(dir, 'home');
    const log = join(dir, 'session1-daemon.log');
    const r = spawnSync('cscript.exe', ['//nologo', LAUNCHER, process.execPath, dir, home, log], { timeout: 30_000 });
    const runs = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { status: r.status, runs, home, log: readFileSync(log, 'utf8') };
  };

  it('46 (/upgrade full): the daemon runs again, and it knows the relaunch exists', () => {
    const { status, runs, home, log } = launch([UPGRADE_FULL_EXIT_CODE, 0]);
    expect(runs).toHaveLength(2);
    for (const env of runs) {
      expect(env).toEqual({ EGPT_DAEMON_RESPAWNS: '1', EGPT_SESSION1: '1', EGPT_HOME: home });
      expect(respawnsOf(env, 'win32')).toBe(true);
    }
    expect(log.match(/session1-daemon-launcher: starting egpt-daemon\.mjs/g)).toHaveLength(2);
    expect(status).toBe(0);
  });

  it('any other exit ends the launcher with that code, for Task Scheduler to read', () => {
    for (const code of [0, 1, 45]) {
      const { status, runs } = launch([code, 0]);
      expect(runs, `exit ${code}`).toHaveLength(1);
      expect(status, `exit ${code}`).toBe(code);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
