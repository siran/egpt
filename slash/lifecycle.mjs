// slash/lifecycle.mjs — daemon lifecycle commands: /restart, /upgrade, /rewind.
//
// All three exit with a distinguished code that egpt-daemon.mjs reads
// to decide what to do next:
//
//   43  /restart   — respawn from current disk state (picks up any
//                    external git-pulls without re-running pull itself)
//   42  /upgrade   — daemon runs `git pull && npm install &&
//                    npm run build:ext`, then respawns
//   44  /rewind    — daemon `git checkout`s a stored ref, installs,
//                    builds, respawns. Ref is written to a sidecar at
//                    ~/.egpt/rewind-target.txt before exit.
//
// If the daemon isn't running, /restart and /upgrade just exit with
// their codes and the operator restarts manually; /rewind leaves the
// sidecar in place for the next daemon start.

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const meta = [
  {
    cmd: '/restart',
    section: 'ROOM',
    surface: 'shell',
    usage: '/restart',
    desc: 'exit with code 43; egpt-daemon respawns from current disk (picks up external git pulls)',
  },
  {
    cmd: '/upgrade',
    section: 'ROOM',
    surface: 'shell',
    usage: '/upgrade',
    desc: 'exit with code 42; egpt-daemon pulls + rebuilds + restarts',
  },
  {
    cmd: '/rewind',
    section: 'ROOM',
    surface: 'shell',
    usage: '/rewind <ref>',
    desc: 'exit with code 44; egpt-daemon checks out <ref>, installs, builds, restarts',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)       — print a system line
  //   exitClean(code)    — _exitClean from egpt.mjs; stops bridges,
  //                        clears pidfile, then process.exit(code).
  //   APP_DIR            — egpt repo root (for /rewind's git ref-verify)
  //   EGPT_HOME          — ~/.egpt (for /rewind's sidecar file)
  const { sysOut, exitClean, APP_DIR, EGPT_HOME } = ctx;

  if (cmd === '/restart') {
    sysOut('exiting with code 43 — egpt-daemon (if running) will respawn the shell');
    setTimeout(() => exitClean(43), 100);
    return true;
  }

  if (cmd === '/upgrade') {
    sysOut('exiting with code 42 — egpt-daemon (if running) will pull, rebuild, and restart');
    setTimeout(() => exitClean(42), 100);
    return true;
  }

  if (cmd === '/rewind') {
    const ref = arg.trim();
    if (!ref) {
      const tags = spawnSync('git', ['tag', '--sort=-creatordate'], { cwd: APP_DIR });
      const tagList = (tags.stdout?.toString() ?? '').trim().split('\n').slice(0, 10).join(', ');
      sysOut(`usage: /rewind <ref>     (commit SHA, tag, branch, or HEAD~N)\nrecent tags: ${tagList || '(none)'}`);
      return true;
    }
    const verify = spawnSync('git', ['rev-parse', '--verify', ref], { cwd: APP_DIR });
    if (verify.status !== 0) {
      sysOut(`!! unknown git ref "${ref}" — /rewind with no arg lists tags`);
      return true;
    }
    try {
      await mkdir(EGPT_HOME, { recursive: true });
      await writeFile(join(EGPT_HOME, 'rewind-target.txt'), ref);
    } catch (e) {
      sysOut(`!! could not write rewind sidecar: ${e.message}`);
      return true;
    }
    sysOut(`exiting with code 44 — egpt-daemon (if running) will checkout ${ref}, install, build, restart`);
    setTimeout(() => exitClean(44), 100);
    return true;
  }

  return false;
}
