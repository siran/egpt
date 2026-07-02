// alive.mjs — the FUNDAMENTAL heartbeat, as a plain, readable script (operator
// 2026-07-02: "the readonly file must show the actual command, and the logic must
// live in a small readable script, not a closure buried in boot" — transparency
// over cleverness). The spine registers this as a normal `command:` heartbeat
// (state/heartbeats.readonly.yaml shows `command: node src/tools/alive.mjs`,
// nothing hidden) and spawns it on its own tick, so a fresh alive.txt beat
// attests the loop's time-driven half is actually turning — not merely that the
// process is up.
//
// THE LINE IS A CONTRACT (do not change the shape):
//   "<tic|toc> <ISO> <pid> q=<queueDepth> oldest=<oldestSec>s\n"
// consumed by src/daemon-runtime.mjs (newestBeatMs → wedge check) and
// src/daemon-singleton.mjs (liveDaemonPid → refuse a second daemon). The pid it
// checks MUST be the long-lived SPINE process: daemon-singleton refuses a second
// daemon iff alive.txt's pid is a LIVE process, so if this short-lived script
// wrote its OWN (already-dead-by-check-time) pid, a second daemon could start and
// fight over WhatsApp. The spine injects EGPT_SPINE_PID for exactly this reason.
//
// DEADMAN, by design: if this script fails to write (bad EGPT_HOME, full disk),
// no beat lands, the beat goes stale, and the daemon SIGTERM-respawns the node.
// That respawn IS the deadman working — so the CLI only exits non-zero when the
// write genuinely failed, never for a routine beat.

import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Write one alive beat. Pure w.r.t. its injected IO + clock so it unit-tests
 * against fakes and never touches the real profile.
 * @param {object} a
 * @param {string} a.egptHome            profile root; the beat goes to <egptHome>/state/alive.txt
 * @param {string|number} a.pid          the SPINE's pid (the daemon-singleton contract) — NOT this script's own
 * @param {string|number} [a.queueDepth] pump depth (spine.stats()); surfaced in the line, no effect on cadence
 * @param {string|number} [a.oldestMs]   oldest pending item's age in ms; written rounded to whole seconds
 * @param {() => number} [a.now]         clock seam (epoch ms)
 * @param {{readFile?:Function, writeFile?:Function, mkdir?:Function}} [a.io]
 * @returns {Promise<string>} the exact line written
 */
export async function writeBeat({ egptHome, pid, queueDepth = 0, oldestMs = 0, now = Date.now, io = {} } = {}) {
  const readFile = io.readFile ?? fsReadFile;
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;

  const stateDir = join(egptHome, 'state');
  const path = join(stateDir, 'alive.txt');

  // tic/toc alternation without an in-process counter (this script is one beat
  // per run): flip the CURRENT first token. tic→toc, toc→tic; absent/unreadable
  // → tic. Purely cosmetic — the daemon accepts either token.
  let prev = '';
  try { prev = (await readFile(path, 'utf8')).trimStart().slice(0, 3); } catch { prev = ''; }
  const token = prev === 'tic' ? 'toc' : 'tic';

  const iso = new Date(now()).toISOString();
  const oldestSec = Math.round((Number(oldestMs) || 0) / 1000);
  const line = `${token} ${iso} ${pid} q=${Number(queueDepth) || 0} oldest=${oldestSec}s\n`;

  await mkdir(stateDir, { recursive: true });
  await writeFile(path, line);
  return line;
}

// ── CLI: `node src/tools/alive.mjs` (how the spine runs it) ───────────────────
const _invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (_invokedDirectly) {
  const egptHome = process.env.EGPT_HOME;
  if (!egptHome) { console.error('alive: EGPT_HOME required'); process.exit(1); }
  // The spine injects its pid + pump stats into every command-beat's env. Fall
  // back to our OWN pid only if EGPT_SPINE_PID is absent — that's wrong (see
  // header: a dead script pid could let a second daemon start), but a beat with a
  // stale pid still proves the loop turned, which beats no beat at all.
  const pid = process.env.EGPT_SPINE_PID || String(process.pid);
  try {
    await writeBeat({ egptHome, pid, queueDepth: process.env.EGPT_QUEUE_DEPTH, oldestMs: process.env.EGPT_QUEUE_OLDEST_MS });
  } catch (e) {
    // A genuine write failure = no beat = the daemon's wedge check respawns us.
    // Exit loud so the deadman is visible in the logs.
    console.error(`alive: ${e?.message ?? e}`);
    process.exit(1);
  }
}
