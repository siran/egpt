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
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// fs-direct restart-flow trace (sibling of wa-bridge.log). The shell's sysOut
// goes to the Ink/headless render buffer, which drops lines, so the restart
// announce chain was unobservable. Append-only, best-effort. Read with
// `cat ~/.egpt/restart.log`. Operator 2026-06-02: "no egpt back!".
function _rlog(EGPT_HOME, m) {
  try { appendFileSync(join(EGPT_HOME, 'restart.log'), `${new Date().toISOString()} [${process.pid}] ${m}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}

// Drop the Self-DM breadcrumbs a lifecycle bounce needs: a "going down" line in
// the outbox + a state/restart-announce.json sidecar the NEXT process reads to
// post "back online". Used by BOTH /restart and /upgrade so each reports the
// cycle in Self — the "exiting…" sysOut only reaches the shell, and the dying
// process tears the bridge down before any mirror flushes. HEAD captured here
// is pre-bounce; the boot-announce re-reads HEAD, so /upgrade shows the NEW
// commit it pulled to.
async function announceBounce({ ctx, meta, preBody }) {
  const { APP_DIR, EGPT_HOME } = ctx;
  const selfJid = meta?.waChatId || ctx.EGPT_CONFIG?.whatsapp?.chat_id || null;
  _rlog(EGPT_HOME, `announceBounce: fromWhatsApp=${!!meta?.fromWhatsApp} metaWaChatId=${meta?.waChatId ?? 'none'} cfgChatId=${ctx.EGPT_CONFIG?.whatsapp?.chat_id ?? 'none'} → selfJid=${selfJid ?? 'NULL'}`);
  if (!selfJid) { _rlog(EGPT_HOME, 'announceBounce: SKIPPED — no selfJid → NO sidecar → there will be no "egpt back!"'); return; }
  let sha = '?', subj = '';
  try {
    const r = spawnSync('git', ['log', '-1', '--format=%h\t%s'], { cwd: APP_DIR });
    if (r.status === 0) { const [h, s] = (r.stdout?.toString() ?? '').trim().split('\t'); sha = h || '?'; subj = s || ''; }
  } catch { /* git optional */ }
  // The outbox "going down" pre-ack is only needed when the restart was
  // initiated from a NON-WA surface (limb/shell) — so the operator's WA self-DM
  // still hears the spine is bouncing. A WA-initiated /restart already got an
  // IMMEDIATE live-socket ack at ingress, so skip this — otherwise the operator
  // gets a duplicate, and often out-of-order (it's outbox-delayed until the new
  // spine reconnects), "respawning on <sha>" message (operator 2026-06-01).
  if (!meta?.fromWhatsApp) {
    await mkdir(join(EGPT_HOME, 'outbox'), { recursive: true });
    await writeFile(join(EGPT_HOME, 'outbox', `${Date.now()}-restart-pre.json`), JSON.stringify({
      type: 'wa-send', from: 'system', ts: Date.now(), jid: selfJid, body: preBody(sha),
    }));
  }
  await mkdir(join(EGPT_HOME, 'state'), { recursive: true });
  await writeFile(join(EGPT_HOME, 'state', 'restart-announce.json'), JSON.stringify({ jid: selfJid, sha, subj, at: Date.now() }));
  _rlog(EGPT_HOME, `announceBounce: sidecar WRITTEN → ${join(EGPT_HOME, 'state', 'restart-announce.json')} (jid=${selfJid}, sha=${sha})`);
}

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

export async function run({ cmd, arg, meta = {}, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)       — print a system line
  //   exitClean(code)    — _exitClean from egpt.mjs; stops bridges,
  //                        clears pidfile, then process.exit(code).
  //   APP_DIR            — egpt repo root (for /rewind's git ref-verify)
  //   EGPT_HOME          — ~/.egpt (for /rewind's sidecar file)
  //   EGPT_CONFIG        — for the operator's Self-DM jid (restart announce)
  const { sysOut, exitClean, APP_DIR, EGPT_HOME } = ctx;

  // /restart and /upgrade are ONE slash-side flow: announce the bounce in Self
  // (the "exiting…" sysOut only reaches the shell, and the dying process tears
  // the bridge down before any mirror flushes — so announceBounce leaves a
  // breadcrumb the respawned daemon delivers + a "back online" sidecar). The
  // ONLY difference is the exit code the wrapper reads:
  //   43 /restart — respawn from current disk (HEAD unchanged across the bounce)
  //   42 /upgrade — git pull + npm install + build:ext, THEN respawn (HEAD may
  //                 change; the boot-announce re-reads HEAD so it reports the
  //                 commit actually running).
  // Table-driven so the two never drift into copy-paste.
  const BOUNCE = {
    '/restart': { code: 43, pre: (sha) => `🧠 restart initiated — respawning on ${sha}…`,
                  exitMsg: 'exiting with code 43 — egpt-daemon will respawn the shell' },
    '/upgrade': { code: 42, pre: (sha) => `🧠 upgrade initiated — pull + rebuild from ${sha}…`,
                  exitMsg: 'exiting with code 42 — egpt-daemon will pull, rebuild, and restart' },
  };
  if (BOUNCE[cmd]) {
    const b = BOUNCE[cmd];
    // Supervision check: exit 42/43/44 is meaningful ONLY when egpt-daemon.mjs
    // is the parent process and will read the exit code to decide whether to
    // respawn. A user running `node egpt.mjs` directly has no supervisor, so
    // /restart just kills the shell with no respawn (operator 2026-05-29:
    // it died and dropped them back at a bash prompt). egpt-daemon sets
    // EGPT_SUPERVISED in the child's env so we can tell the difference.
    if (!process.env.EGPT_SUPERVISED) {
      sysOut(`${cmd}: this shell isn't under egpt-daemon supervision — ` +
             `exit ${b.code} would just kill the shell with no respawn. ` +
             `Use /exit and re-run \`node egpt.mjs\` if you want a fresh boot, ` +
             `or run egpt under the daemon (Task Scheduler / systemd / launchd).`);
      return true;
    }
    try {
      await announceBounce({ ctx, meta, preBody: b.pre });
    } catch (e) { sysOut(`!! ${cmd}: announce write failed — ${e.message}`); }
    sysOut(b.exitMsg);
    setTimeout(() => exitClean(b.code), 100);
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
    // Same supervision check as /restart and /upgrade — exit 44 only does
    // something when egpt-daemon reads it.
    if (!process.env.EGPT_SUPERVISED) {
      sysOut(`/rewind: this shell isn't under egpt-daemon supervision — ` +
             `exit 44 would just kill the shell with no respawn. ` +
             `Run egpt under the daemon (Task Scheduler / systemd / launchd) for /rewind to work.`);
      return true;
    }
    sysOut(`exiting with code 44 — egpt-daemon will checkout ${ref}, install, build, restart`);
    setTimeout(() => exitClean(44), 100);
    return true;
  }

  return false;
}
