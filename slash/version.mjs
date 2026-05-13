// slash/version.mjs — show current git state of the egpt repo.

import { spawnSync } from 'node:child_process';

export const meta = {
  cmd: '/version',
  section: 'ROOM',
  surface: 'shell',
  usage: '/version',
  desc: 'show current commit, branch, last tag, and dirty state',
};

export async function run({ ctx }) {
  // ctx keys consumed:
  //   sysOut(text)  — print a system line to the room
  //   APP_DIR       — the egpt repo root (cwd for git invocations)
  const { sysOut, APP_DIR } = ctx;

  // Snapshot current git state so the operator can see what's running
  // before /upgrade or /rewind.
  const sha    = spawnSync('git', ['rev-parse', '--short', 'HEAD'],      { cwd: APP_DIR, stdio: 'pipe' });
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: APP_DIR, stdio: 'pipe' });
  const tag    = spawnSync('git', ['describe', '--tags', '--abbrev=0'],  { cwd: APP_DIR, stdio: 'pipe' });
  const dirty  = spawnSync('git', ['status', '--porcelain'],             { cwd: APP_DIR, stdio: 'pipe' });
  const recent = spawnSync('git', ['tag', '--sort=-creatordate'],        { cwd: APP_DIR, stdio: 'pipe' });
  const get = (r) => (r.stdout?.toString() ?? '').trim();
  const dirtyText = get(dirty) ? '  (working tree dirty)' : '';
  const tagList = get(recent).split('\n').slice(0, 5).filter(Boolean).join(', ');
  sysOut(
    `commit: ${get(sha) || '???'}${dirtyText}\n` +
    `branch: ${get(branch) || '???'}\n` +
    `last tag: ${get(tag) || '(none)'}\n` +
    `recent tags: ${tagList || '(none)'}`,
  );
  return true;
}
