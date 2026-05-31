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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { liveDaemonPid } from '../src/daemon-singleton.mjs';
import { outboxSend } from '../src/tools/outbox-send.mjs';

// Drop the Self-DM breadcrumbs a lifecycle bounce needs: a "going down" line in
// the outbox + a state/restart-announce.json sidecar the NEXT process reads to
// post "back online". Used by BOTH /restart and /upgrade so each reports the
// cycle in Self — the "exiting…" sysOut only reaches the shell, and the dying
// process tears the bridge down before any mirror flushes. HEAD captured here
// is pre-bounce; the boot-announce re-reads HEAD, so /upgrade shows the NEW
// commit it pulled to.
async function announceBounce({ ctx, meta, preBody }) {
  const { APP_DIR, EGPT_HOME, sysOut } = ctx;
  const selfJid = meta?.waChatId || ctx.EGPT_CONFIG?.whatsapp?.chat_id || null;
  if (!selfJid) {
    sysOut?.(`!! announceBounce: no selfJid (meta.waChatId=${meta?.waChatId ?? '?'}, config.whatsapp.chat_id=${ctx.EGPT_CONFIG?.whatsapp?.chat_id ?? '?'}) — no pre-bounce wa-send will be queued`);
    return;
  }
  let sha = '?', subj = '';
  try {
    const r = spawnSync('git', ['log', '-1', '--format=%h\t%s'], { cwd: APP_DIR });
    if (r.status === 0) { const [h, s] = (r.stdout?.toString() ?? '').trim().split('\t'); sha = h || '?'; subj = s || ''; }
  } catch { /* git optional */ }
  // outboxSend uses atomic-rename (.tmp-<uuid>.json → final), critical on
  // Windows where the watcher fires on creation and would read a half-written
  // raw writeFile, JSON.parse-throw, and unlink the file as poison — losing
  // the restart confirmation. Bug: 2026-05-31, operator saw no /restart
  // confirmation in WA Self.
  try {
    const { filename } = await outboxSend({ type: 'wa-send', jid: selfJid, body: preBody(sha) }, { from: 'system' });
    sysOut?.(`announceBounce: pre-bounce wa-send queued in outbox as ${filename} for jid=${selfJid}`);
  } catch (e) {
    sysOut?.(`!! announceBounce: outboxSend failed (${e?.message ?? e}) — no pre-bounce wa-send delivered`);
    throw e;   // surface to the caller; don't pretend it worked
  }
  try {
    await mkdir(join(EGPT_HOME, 'state'), { recursive: true });
    await writeFile(join(EGPT_HOME, 'state', 'restart-announce.json'), JSON.stringify({ jid: selfJid, sha, subj, at: Date.now() }));
    sysOut?.(`announceBounce: state/restart-announce.json written (sha=${sha}) — next daemon will post "back online" to ${selfJid}`);
  } catch (e) {
    sysOut?.(`!! announceBounce: sidecar write failed (${e?.message ?? e}) — back-online ack will be skipped`);
    throw e;
  }
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
    '/restart': { code: 43, pre: (sha) => `🧠 eGPT · ↻ /restart (exit 43) — respawning on ${sha}…`,
                  exitMsg: 'exiting with code 43 — egpt-daemon will respawn the shell' },
    '/upgrade': { code: 42, pre: (sha) => `🧠 eGPT · ⬆ /upgrade (exit 42) — pull + rebuild from ${sha}…`,
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
      // /restart in an unsupervised shell: if a daemon IS alive elsewhere
      // (Option A: one home, one daemon, multiple thin-client shells), kick
      // IT via a daemon-restart outbox event instead of refusing. The
      // daemon's supervised egpt picks up the event, exits 43, and the
      // wrapper respawns it — so code changes go live without the operator
      // touching Task Scheduler. /upgrade and /rewind keep the strict
      // refusal because they need git ops on the daemon's source root and
      // aren't expressible via a single outbox event (yet).
      if (cmd === '/restart') {
        let daemonPid = null;
        try {
          const content = await readFile(join(EGPT_HOME, 'state', 'alive.txt'), 'utf8');
          daemonPid = liveDaemonPid(content);
        } catch { /* alive.txt missing → no daemon */ }
        if (daemonPid) {
          try {
            await mkdir(join(EGPT_HOME, 'outbox'), { recursive: true });
            const _id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-daemon-restart`;
            await writeFile(join(EGPT_HOME, 'outbox', `${_id}.json`),
              JSON.stringify({ type: 'daemon-restart', from: `shell-pid-${process.pid}`, ts: Date.now() }));
            sysOut(`/restart: this shell isn't supervised, but daemon pid ${daemonPid} is — dropped a daemon-restart event in the outbox. The daemon will exit 43 and egpt-daemon will respawn its egpt.mjs.`);
          } catch (e) {
            sysOut(`!! /restart: failed to write daemon-restart event — ${e.message}`);
          }
          return true;
        }
      }
      sysOut(`${cmd}: this shell isn't under egpt-daemon supervision — ` +
             `exit ${b.code} would just kill the shell with no respawn. ` +
             `Use /exit and re-run \`node egpt.mjs\` if you want a fresh boot, ` +
             `or run egpt under the daemon (Task Scheduler / systemd / launchd).`);
      return true;
    }
    // Trace EVERY supervised invocation so the headless log unambiguously
    // proves the slash reached the daemon (operator 2026-05-31: "/restart from
    // WA didn't work — was it received at all?"). The trace includes the
    // arriving surface (waChatId / telegramChatId / 'shell') so we can tell
    // whether the round-trip from WA actually landed on the daemon's bridge.
    const _src = meta?.waChatId ? `wa:${meta.waChatId}`
      : meta?.telegramChatId ? `tg:${meta.telegramChatId}`
      : 'shell';
    sysOut(`${cmd}: invoked (supervised) from ${_src} — running announceBounce + scheduling exitClean(${b.code})`);
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
