import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { closeSync as nodeCloseSync, existsSync as nodeExistsSync, fstatSync as nodeFstatSync, mkdirSync as nodeMkdirSync, openSync as nodeOpenSync, readFileSync as nodeReadFileSync, renameSync as nodeRenameSync, statSync as nodeStatSync, unlinkSync as nodeUnlinkSync, writeFileSync as nodeWriteFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as YAML from 'yaml';
import { liveDaemonPid as defaultLiveDaemonPid } from './daemon-singleton.mjs';
import { createPeerLiveness, tcpProbe, DEFAULT_EVERY_MS as PEER_PROBE_EVERY_MS } from './spine/peer-liveness.mjs';

export const RESTART_MIN_MS = 2_000;
export const RESTART_MAX_MS = 60_000;
export const UPGRADE_EXIT_CODE = 42;
export const RESTART_EXIT_CODE = 43;
export const REWIND_EXIT_CODE = 44;
// The one lifecycle code that does NOT respawn: a PEER took the profile (the Session 0 →
// Session 1 handover). Two spines share one EGPT_HOME on this node, so exactly one may hold
// it; the departing spine drains and leaves with 45, and the daemon waits for the successor
// to die with its session before bringing this one back. CLEAN_EXIT_CODE could not carry
// this: it means "the user wanted out" and stops the daemon entirely (see the branch below).
export const STANDDOWN_EXIT_CODE = 45;
export const CLEAN_EXIT_CODE = 0;

// --- the boot-failure recovery ladder (operator 2026-08-30) ------------------------------
// THE INCIDENT: ~/bin/egpt is both the production checkout and an agent's working dir. An
// agent left 9 files uncommitted, one with markdown backticks inside a template literal in
// config/config-schema.mjs. The spine then died at MODULE LOAD with a SyntaxError — before
// it could boot, before it could beat, before it could announce anything. This daemon
// restarted it every few seconds for 33 minutes, never escalated, and never told anyone;
// daemon-startup-err.log grew to 2.8 MB of the identical stack trace and the operator found
// it by hand. Verbatim ruling: "if the problem was a dirty tree, every[thing] can be
// archived to a branch or whatever, try 3 more restarts, the rollback... a spine being down,
// with a watcher, is just unjustifiable."
//
// So: consecutive crashes where the child NEVER became healthy (never advanced alive.txt —
// see childEverBeat) escalate. 3 and 3 are the operator's numbers. They are counts, not
// durations, because the failure mode is instant: a module-load SyntaxError dies in under a
// second, so a wall-clock threshold would either fire on one slow boot or wait forever.
export const NEVER_HEALTHY_RESCUE_AT = 3;     // step 2: archive + clean a dirty working tree
export const NEVER_HEALTHY_ROLLBACK_AT = 6;   // step 3: 3 MORE failures -> roll code back
// Uptime after which a beating child's HEAD is trusted as "last known good". Must be
// comfortably longer than a boot: aliveGraceMs is 90s and the heartbeat is ~60s, so 10
// minutes means the spine finished booting and wrote ~10 beats. It is also far longer than
// the whole ladder's wall time (~2min of capped backoff), so a spine that is merely
// surviving the ladder can never mark a broken commit as good.
export const LAST_GOOD_UPTIME_MS = 600_000;

const DEFAULT_ROOT = dirname(fileURLToPath(new URL('../egpt-daemon.mjs', import.meta.url)));
// The console port a profile serves when its config says nothing — shell-port.mjs's
// SHELL_WS_PORT / shellPortFrom() own this rule. It is re-stated rather than imported for
// exactly the reason resolveSelfChatId re-reads config.yaml below: this supervisor shares NO
// module graph with the spine (egpt-daemon.mjs imports this file and nothing else), and
// shell-port pulls in ws + half the surface — a module-load failure there would then take the
// watchdog down with the thing it watches, which is the 33-minute incident with no survivor.
// 23475, not 23375: Beeper Desktop takes the next free port from 23373 upward, so the old
// default sat four ports inside a range another program helps itself to — and did collide, at
// the 2026-09-11 logon described in standDownAndWatch below. Moved in lockstep with
// shell-port.mjs's SHELL_WS_PORT (and its two other re-statements), because a supervisor
// watching a different number from the one its spine binds is worse than either number.
const DEFAULT_CONSOLE_PORT = 23475;
const validPort = (n) => (Number.isInteger(n) && n > 0 && n < 65536 ? n : null);

// --- the supervision axis is the SESSION, not the account (operator 2026-09-11) -----------
// THE ONE THING THAT BLOCKED THE HANDOVER. checkSingleton used to read state/spine.pid under
// the SHARED EGPT_HOME, so a daemon starting at logon always met a live pid and a fresh beat
// (the incumbent spine beats every 60s, staleMs is 120s) and exited before spawning anything.
// A supervisor that self-refuses at the only moment it is ever launched is not a supervisor —
// setup/register-session1-autostart.ps1's DECISION 1 is a page about exactly that. So the
// singleton is keyed by (profile, SESSION) now: one daemon per profile PER SESSION.
//
// THE SESSION KEY IS EGPT_SESSION1, not a number from the OS. It is already this node's
// per-process session marker — set by the logon launcher, read by the spine
// (src/spine/successor-announce.mjs) to know it is the successor — and it is STABLE across
// logons, which a Windows session id is not (log out and back in and the interactive session
// is 2, then 3). The name is re-stated here rather than imported for the same reason
// DEFAULT_CONSOLE_PORT is: successor-announce.mjs pulls in `ws` and the shell auth surface,
// and a module-load failure there must never take the watchdog down with the thing it watches.
const SESSION1_ENV = 'EGPT_SESSION1';
// TRIMMED, not `=== '1'`: cmd yields "1 " for the unquoted `set A=1 && …` form (measured on
// reve 2026-09-06), and successor-announce.mjs compares defensively for that reason. The two
// must agree — a daemon that read itself as s0 while its spine read itself as the successor
// would key its marker to the wrong session.
const isSession1 = (env) => String(env?.[SESSION1_ENV] ?? '').trim() === '1';

// The cap a per-profile child log is rolled at, and the shape of the rolled name. Both are
// NSSM's: AppRotateBytes 10485760 and `service-stderr-20260911T204353.610.log`. Matched rather
// than invented so the rotated files keep sitting in the same directory looking the same to
// whoever tails them — and so the cost is identical to the one this replaces.
export const CHILD_LOG_MAX_BYTES = 10 * 1024 * 1024;
const humanBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${n} bytes`);
const rolledName = (path, at) => {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').replace(/Z$/, '');
  return path.replace(/\.log$/, '') + `-${stamp}.log`;
};

// Profiles this process supervises: EGPT_HOMES if set, else the single EGPT_HOME. Pure over
// the environment so the fan-out below and its tests share one rule.
export function resolveProfiles(env = process.env, platform = process.platform) {
  const single = () => [env?.EGPT_HOME || join(homedir(), '.egpt')];
  const raw = String(env?.EGPT_HOMES ?? '').trim();
  if (!raw) return single();
  const seen = new Set();
  const out = [];
  // COMMA OR SEMICOLON, matching what install-nssm-service.ps1 accepts on -EgptHomes (05d7236:
  // a `;` is a statement separator in bash, so an unquoted paste loses the argument). The
  // installer normalises to `;` before writing the variable, but the two parsers disagreeing
  // would be worse than either rule, so this takes both.
  for (const entry of raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
    // Dedupe on a normalised form so `C:/a` and `C:/a/` are not supervised twice — two
    // supervisors on one profile is the failure the singleton exists to prevent, and it must
    // not be reachable by a typo in one environment variable.
    let key = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    if (platform === 'win32') key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.length ? out : single();
}

export function createDaemonRuntime(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  // Profile-aware: EGPT_HOME selects the node, so independent nodes (each its own
  // ~/.egptN) get their own singleton + alive.txt and don't fight each other.
  const egptHome = opts.egptHome ?? process.env.EGPT_HOME ?? join(homedir(), '.egpt');
  const argv = opts.argv ?? process.argv.slice(2);
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? nodeSpawn;
  const spawnSync = opts.spawnSync ?? nodeSpawnSync;
  const readFileSync = opts.readFileSync ?? nodeReadFileSync;
  const statSync = opts.statSync ?? nodeStatSync;
  const unlinkSync = opts.unlinkSync ?? nodeUnlinkSync;
  const existsSync = opts.existsSync ?? nodeExistsSync;
  const writeFileSync = opts.writeFileSync ?? nodeWriteFileSync;
  const mkdirSync = opts.mkdirSync ?? nodeMkdirSync;
  const openSync = opts.openSync ?? nodeOpenSync;
  const closeSync = opts.closeSync ?? nodeCloseSync;
  const renameSync = opts.renameSync ?? nodeRenameSync;
  const fstatSync = opts.fstatSync ?? nodeFstatSync;
  const liveDaemonPid = opts.liveDaemonPid ?? defaultLiveDaemonPid;
  const processObj = opts.processObj ?? process;
  const stdout = opts.stdout ?? process.stdout;
  const setTimeoutFn = opts.setTimeout ?? setTimeout;
  const setImmediateFn = opts.setImmediate ?? setImmediate;
  const setIntervalFn = opts.setInterval ?? setInterval;
  const clearIntervalFn = opts.clearInterval ?? clearInterval;
  const importModule = opts.importModule ?? ((url) => import(url));
  const now = opts.now ?? Date.now;

  const rewindSidecar = opts.rewindSidecar ?? join(egptHome, 'rewind-target.txt');
  // The stand-down's equivalent of rewind-target.txt: the departing spine names the port its
  // successor is taking, written the same way /rewind writes its ref and consumed the same way.
  const standdownSidecar = opts.standdownSidecar ?? join(egptHome, 'standdown-target.txt');
  // The observation seam — peer-liveness's own TCP probe by default; tests inject a fake.
  const peerProbe = opts.peerProbe ?? tcpProbe;
  const alivePath = opts.alivePath ?? join(egptHome, 'state', 'alive.txt');
  const spinePidPath = opts.spinePidPath ?? join(egptHome, 'state', 'spine.pid');
  // WHICH SESSION THIS DAEMON SUPERVISES (see the SESSION1_ENV block above). s0 = the service
  // session, s1 = the logon session. The successor's spine reads the same flag out of the same
  // environment, so the daemon and the spine it spawns can never disagree about which they are.
  const session1 = opts.session1 ?? isSession1(processObj.env);
  const sessionKey = session1 ? 's1' : 's0';
  const sessionLabel = session1 ? 'the s1 (logon) session' : 'the s0 (service) session';
  // The singleton's own file, written by the DAEMON, one per session. Distinct from
  // state/spine.pid, which the spine writes and which is shared by whichever spine holds the
  // profile — that file cannot say which session a supervisor is in, and it is why the old
  // guard could only ever be profile-scoped.
  const daemonPidPath = opts.daemonPidPath ?? join(egptHome, 'state', `daemon-${sessionKey}.pid`);
  // --- where this profile's spine writes (operator 2026-09-11) ----------------------------
  // `stdio: 'inherit'` gives the child the SERVICE's own handles. For one node that is exactly
  // right and stays: NSSM captures them into <EGPT_HOME>/config/logs/service-{stdout,stderr}.log
  // and rotates them at 10 MB. For TWO profiles in one process it is a lie — both children
  // inherit the same two handles, so kg2's lines land in kg's file with nothing to tell them
  // apart and kg2's own file goes dead (measured on reve the day the merge shipped). So when
  // this daemon shares a process, it opens the profile's own pair itself and hands those over.
  // Same paths NSSM used, because that is where every reader of this node already looks.
  const perProfileLogs = opts.perProfileLogs ?? false;
  // Named in the daemon's OWN lines, which stay in one place (the supervisor's narrative is
  // about the supervisor) and therefore have to say which profile each line is about.
  const logTag = opts.logTag ?? null;
  const childLogPaths = opts.childLogPaths ?? {
    stdout: join(egptHome, 'config', 'logs', 'service-stdout.log'),
    stderr: join(egptHome, 'config', 'logs', 'service-stderr.log'),
  };
  const childLogMaxBytes = opts.childLogMaxBytes ?? CHILD_LOG_MAX_BYTES;
  let childLogFds = null;      // the pair the CURRENT child holds, or null
  let childLogWarned = false;  // one oversize warning per child, not one per liveness tick
  // The SAME sidecar boot.mjs's read-back block reads (join(EGPT_HOME, 'state',
  // 'restart-announce.json')) — the daemon writes a fallback here ONLY for the two exit
  // paths where the dying spine never got a chance to write its own (a crash, or a
  // wedge-kill); the spine's own graceful announceAndExit path is untouched.
  const restartAnnouncePath = join(egptHome, 'state', 'restart-announce.json');
  const configYamlPath = join(egptHome, 'config', 'config.yaml');
  // {sha, at} of the last commit a spine was ever observed HEALTHY on — the ladder's step-3
  // rollback target. Written by the daemon only (recordLastGood), never by the spine.
  const lastGoodPath = opts.lastGoodPath ?? join(egptHome, 'state', 'last-good.json');

  // Wedge check: the spine beats alive.txt (~60s). If a running child stops
  // beating (alive process, dead loop), restart it. graceMs covers boot before
  // the first beat; staleMs ~ a couple missed beats.
  const livenessIntervalMs = opts.livenessIntervalMs ?? 30_000;
  const aliveStaleMs = opts.aliveStaleMs ?? 150_000;
  const aliveGraceMs = opts.aliveGraceMs ?? 90_000;
  const lastGoodUptimeMs = opts.lastGoodUptimeMs ?? LAST_GOOD_UPTIME_MS;
  let childStartedAt = 0, livenessTimer = null;
  // Non-null only while the daemon is stood down watching a peer hold the profile.
  let standdownTimer = null;

  // v2 entry takes no role flags; pass argv straight through (egpt-spine.mjs ignores it).
  const shellArgs = argv;

  let stopping = false;
  let backoff = RESTART_MIN_MS;
  let child = null;
  // Consecutive wedge kills without a fresh beat in between. Each one escalates
  // the respawn delay (RESTART_MIN_MS·2^(streak-1), capped at RESTART_MAX_MS) so a
  // permanently-dead heartbeat (e.g. heartbeats disabled) doesn't hot-loop
  // kill+respawn every few minutes forever — it backs off calmly and keeps
  // respawning "until the service is stopped or the heartbeat restored" (operator
  // 2026-07-01). A fresh beat observed by checkLiveness resets it.
  let wedgeStreak = 0;
  // SLEEP IS NOT A WEDGE (operator 2026-09-03, reve found at 14% after a night on battery).
  // beatAge() is WALL-CLOCK age, which is meaningless across a suspend: in Modern Standby the
  // spine's timers do not fire, so alive.txt simply stops moving. reve wakes every 5 min (the
  // egpt-wake-duty timer), and 300s of sleep always exceeds the 150s stale threshold — so on
  // EVERY resume the watchdog killed a perfectly healthy spine. 45 restarts in one night, each
  // dropping every warm CLI and re-resuming every thread.
  //
  // The tell is that OUR OWN loop stopped ticking too, and a watchdog that was itself frozen
  // has no business blaming the thing it watches. So: measure the gap between consecutive
  // ticks, and when it far exceeds the interval, treat it as a resume — then give the child
  // the same grace a freshly-spawned one gets, because after a resume it genuinely needs a
  // moment before its next beat lands (heartbeat ~60s vs a 150s threshold, so merely skipping
  // one 30s tick would not be enough).
  let lastLivenessTickAt = null;
  let resumeGraceUntil = 0;
  // Set by checkLiveness right before it SIGTERMs a wedged child, so the exit
  // handler can tell that kill apart from an operator-initiated stop. On POSIX a
  // wedged child traps SIGTERM and exits 0 (egpt-spine.mjs) — identical to a clean
  // /exit — so without this flag the daemon would stop the whole service instead
  // of respawning. (On Windows kill() hard-terminates with a non-0 code, so it
  // "worked" there by accident; this makes the wedge-restart path uniform.)
  let wedgeKilled = false;
  // Consecutive crashes of children that NEVER became healthy — the 2026-08-30 ladder's
  // counter. Distinct from wedgeStreak (child ALIVE but stopped beating) and from a plain
  // crash (child ran, beat, then died — that keeps today's flat backoff and clears this).
  let neverHealthyStreak = 0;
  // alive.txt's mtime snapshotted immediately BEFORE each spawn. The whole never-healthy
  // test is "did this snapshot move while the child was up" — a spine that could not even
  // parse its own modules never touches the beat file, while one that booted an hour ago
  // and then crashed obviously did.
  let spawnBeatMtime = null;
  let lastGoodRecorded = false;   // once per child; reset in spawnShell

  function log(msg) {
    stdout.write(`[egpt-daemon ${new Date(now()).toISOString()}]${logTag ? ` [${logTag}]` : ''} ${msg}\n`);
  }

  // An escalation must be impossible to miss in a log whose normal texture is one line per
  // respawn — the 33-minute incident was invisible precisely because every line looked the
  // same. Routine respawns keep using log(); only ladder steps get the banner.
  function alarm(msg) {
    const rule = '!'.repeat(78);
    log(rule);
    log(`!! ${msg}`);
    log(rule);
  }

  // Liveness is the alive.txt MTIME now, not its content (operator 2026-07-02):
  // ANY command that writes the file is a valid beat, so the fragile parsed-line
  // contract + its regexes are gone. beatAge() = ms since the file's mtime; a
  // missing file → Infinity (absent).
  function beatMtime() {
    try { return statSync(alivePath).mtimeMs; } catch { return null; /* no beat file yet */ }
  }

  function beatAge() {
    const mtimeMs = beatMtime();
    return mtimeMs == null ? Infinity : now() - mtimeMs;
  }

  // Did the CURRENT child ever reach the point of beating? Compared against the snapshot
  // spawnShell took right before spawning: absent-then-still-absent and unchanged-mtime both
  // mean the spine never got far enough to write alive.txt, i.e. it could not BOOT. Any
  // movement (including the pathological case of the file being recreated with an older
  // mtime) counts as healthy — biasing towards "don't escalate" is the safe direction.
  function childEverBeat() {
    const m = beatMtime();
    return m != null && m !== spawnBeatMtime;
  }

  // Reset the ladder the moment a spawned child is observed healthy, wherever we notice.
  function noteBeatObserved() {
    if (!neverHealthyStreak || !childEverBeat()) return;
    log(`spine is beating again — clearing the never-healthy streak (was ${neverHealthyStreak})`);
    neverHealthyStreak = 0;
  }

  // Last-known-good marker: this child is past the boot grace, beating fresh, and has been
  // up for lastGoodUptimeMs — so whatever commit it is running actually boots. Record it as
  // the ladder's rollback target. Once per child (HEAD cannot change under a running spine;
  // upgrades/rewinds happen between children), and the flag is set even on a failed write so
  // a broken state/ dir can't spam this line every liveness tick.
  function recordLastGood() {
    if (lastGoodRecorded || now() - childStartedAt < lastGoodUptimeMs) return;
    lastGoodRecorded = true;
    try {
      const { sha } = gitVersion(root);
      if (!sha || sha === '???') { log('healthy long enough to mark last-known-good, but git could not name HEAD — not marking'); return; }
      writeFileSync(lastGoodPath, JSON.stringify({ sha, at: new Date(now()).toISOString() }));
      log(`last-known-good = ${sha} (spine healthy for ${Math.round((now() - childStartedAt) / 60_000)}m)`);
    } catch (e) {
      log(`could not write the last-known-good marker (${e.message}) — a future rollback will have nothing to aim at`);
    }
  }

  function readLastGood() {
    try {
      const j = JSON.parse(readFileSync(lastGoodPath, 'utf8'));
      return (typeof j?.sha === 'string' && j.sha.trim()) ? { sha: j.sha.trim(), at: j.at ?? null } : null;
    } catch { return null; }
  }

  // The alive.txt's raw last non-empty line, best-effort, for the wedge log — so
  // the last-known beat content lands in the daemon log when it kills. The content
  // is freeform now (for humans); we only read it, never parse it.
  function lastBeatLine() {
    try {
      const lines = readFileSync(alivePath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      return lines.length ? lines[lines.length - 1].trim() : null;
    } catch { return null; }
  }

  // The wedge check: a running child that stopped beating gets a SIGTERM, which
  // routes through the normal exit handler → respawn. Honors a boot grace window
  // so a just-spawned (still-booting) child is never killed for not-yet-beating.
  function checkLiveness() {
    if (stopping || !child) return;
    const at = now();
    const sinceTick = lastLivenessTickAt == null ? 0 : at - lastLivenessTickAt;
    lastLivenessTickAt = at;
    noteBeatObserved();   // a beat inside the grace window already proves this child booted
    if (at - childStartedAt < aliveGraceMs) return;
    const age = beatAge();
    if (age > aliveStaleMs) {
      // STALE — but a sleep explains staleness perfectly well, so ask that first. Our own
      // loop skipping is the tell (see the note above); a fresh beat never reaches here, so
      // a long gap with a healthy child still takes the ordinary path below.
      if (livenessIntervalMs > 0 && sinceTick > livenessIntervalMs * 3) {
        resumeGraceUntil = at + aliveGraceMs;
        log(`resumed after ~${Math.round(sinceTick / 1000)}s without a liveness tick (the machine slept) — not a wedge; giving the spine ${Math.round(aliveGraceMs / 1000)}s to beat again`);
        return;
      }
      if (at < resumeGraceUntil) return;   // still inside the post-resume grace
      const tail = lastBeatLine();
      log(`spine wedged — alive beat ${age === Infinity ? 'absent' : `${Math.round(age / 1000)}s old`} (> ${Math.round(aliveStaleMs / 1000)}s)${tail ? ` — last beat: ${tail}` : ''} — restarting`);
      wedgeKilled = true;   // exit handler: respawn, don't read a SIGTERM-induced exit 0 as an operator stop
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      return;
    }
    wedgeStreak = 0;   // a fresh beat — heartbeat restored, clear the escalation
    recordLastGood();  // …and the only place we KNOW the child is past grace and beating
    warnIfLogOversize();
  }

  // NSSM rotated online; we can only roll between children (see rollIfOversize). A spine that
  // runs for months therefore grows one file for months, and an unbounded log on an always-on
  // node is a real cost — so it is said out loud rather than left to be discovered by a full
  // disk. Once per child, not once per tick.
  function warnIfLogOversize() {
    if (!childLogFds || childLogWarned) return;
    let size;
    try { size = statSync(childLogPaths.stdout).size; } catch { return; }
    if (!(size >= childLogMaxBytes)) return;
    childLogWarned = true;
    log(`${childLogPaths.stdout} is ${humanBytes(size)} and nothing rotates it while this spine is up — it rolls on the next respawn. Restart the spine, or move the file aside, if that is too big.`);
  }

  // A narrow reimplementation of boot.mjs's selfChatId()/surfaceCfg() lookup — the daemon
  // has no bridge and no resolved config object, so it reads+parses config.yaml directly.
  // SAME priority as boot.mjs (networks.whatsapp new shape, falling back to top-level
  // whatsapp old shape; chat_ids[] if present, else chat_id wrapped as a 1-element array),
  // just narrower (only this one lookup, not the full resolver). Never throws.
  function resolveSelfChatId() {
    try {
      const doc = YAML.parse(readFileSync(configYamlPath, 'utf8')) ?? {};
      const raw = (doc.networks?.whatsapp && typeof doc.networks.whatsapp === 'object') ? doc.networks.whatsapp
                : (doc.whatsapp && typeof doc.whatsapp === 'object') ? doc.whatsapp
                : {};
      const chat_ids = Array.isArray(raw.chat_ids) ? raw.chat_ids : (raw.chat_id != null ? [raw.chat_id] : []);
      return chat_ids[0] ?? null;
    } catch { return null; }
  }

  // Best-effort fallback sidecar for a crash/wedge exit, so boot.mjs's read-back always
  // finds SOMETHING to announce from, even when the dying spine never got a chance to
  // write its own via announceAndExit. Never write over an already-existing sidecar (a
  // crash/wedge could rarely race with a spine mid-graceful-exit).
  // `note` (2026-08-30) is the ladder's voice on the operator's own surface: boot.mjs's
  // read-back appends it to the "egpt back up!" line, so the FIRST successful boot after a
  // recovery says what the daemon did and names the rescue branch. A note-less sidecar
  // renders byte-for-byte as before.
  // `force` overwrites an existing sidecar, which only the ladder does. The no-clobber guard
  // exists for a rare race with a spine mid-announceAndExit — but that path exits 42/43/44
  // and never reaches the crash branch, and by escalation time any sidecar sitting here is
  // from a boot that provably never happened. A stale "crash" marker must not be allowed to
  // swallow "your uncommitted work is on branch rescue/…".
  function writeFallbackAnnounce(kind, pid, { note = null, force = false } = {}) {
    try {
      if (!force && existsSync(restartAnnouncePath)) return;
      const chatId = resolveSelfChatId();
      if (!chatId) return;
      const payload = { chatId, kind, preSha: gitVersion(root).sha, pid };
      if (note) payload.note = note;
      writeFileSync(restartAnnouncePath, JSON.stringify(payload));
    } catch { /* best-effort — never block the respawn */ }
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
    const before = gitVersion(root).sha;
    log(`upgrade requested — git pull (currently ${before})`);
    const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
    if (pull.status !== 0) {
      log('git pull failed; continuing with current code');
      return false;
    }
    const after = gitVersion(root);
    if (after.sha !== before) {
      log(`pulled ${before} -> ${after.sha} — running npm install`);
      const r = spawnSync('npm install', { cwd: root, stdio: 'inherit', shell: true });
      if (r.status !== 0) {
        log(`npm install exited ${r.status}${r.error ? `: ${r.error.message}` : ''}; continuing with current deps`);
      }
    } else {
      log(`already up to date at ${after.sha} (${after.tag}, branch ${after.branch}) — rebuilding dist anyway`);
    }
    await buildExtension(root);
    log(`upgrade complete — now at ${after.sha} (${after.tag}, branch ${after.branch})`);
    return true;
  }

  // The ref comes from the sidecar when the SPINE asked for the rewind (/rewind <ref> →
  // REWIND_EXIT_CODE), or straight from a caller when the DAEMON decided on its own — the
  // 2026-08-30 ladder's step 3 hands it the last-known-good sha. One rollback implementation,
  // not two: checkout + npm install + build:ext is the same job whoever asked for it.
  async function runRewind({ ref: providedRef = null } = {}) {
    let ref = providedRef;
    if (!ref) {
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
    }
    if (ref.startsWith('-') || !/^[\w./^~@-]+$/.test(ref)) {
      log(`rewind ref ${JSON.stringify(ref)} doesn't look like a git ref; refusing — restarting with current code`);
      return false;
    }
    log(`rewind requested → git checkout ${ref} && npm install && build:ext`);
    const co = spawnSync('git', ['checkout', ref], { cwd: root, stdio: 'inherit' });
    if (co.status !== 0) {
      log(`rewind step failed (git checkout ${ref})${co.error ? `: ${co.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
    const ni = spawnSync('npm install', { cwd: root, stdio: 'inherit', shell: true });
    if (ni.status !== 0) {
      log(`rewind step failed (npm install)${ni.error ? `: ${ni.error.message}` : ''}; restarting anyway with current code`);
      return false;
    }
    await buildExtension(root);
    log(`rewind to ${ref} complete`);
    return true;
  }

  const git = (args, extra = {}) => spawnSync('git', args, { cwd: root, stdio: 'pipe', ...extra });
  const gitOut = (r) => (r.stdout?.toString() ?? '').trim();
  const gitWhy = (r) => {
    if (r.error) return `: ${r.error.message}`;
    const err = (r.stderr?.toString() ?? '').trim();
    return err ? `: ${err.split('\n')[0]}` : '';
  };

  // LADDER STEP 2 (operator 2026-08-30, verbatim: "if the problem was a dirty tree,
  // every[thing] can be archived to a branch or whatever"). A BRANCH, not a stash: he asked
  // for the work ARCHIVED, and a stash is a thing you lose. Committing onto rescue/<ts> and
  // then checking the original branch back out is what cleans the tree — the modification
  // leaves the working copy and is preserved in the rescue commit, in one move.
  //
  // Everything up to and including the commit is non-destructive. The ONE destructive step
  // is the final checkout back, and it is gated behind proof that the archive exists: the
  // branch must resolve to a real commit AND the tree must have gone clean. If any of that
  // fails we restore and refuse to clean — the operator losing a day of uncommitted work is
  // strictly worse than the spine staying down for another respawn cycle.
  // Returns {dirty, branch, cleaned, reason}; dirty === null means "couldn't even tell".
  function archiveAndCleanDirtyTree() {
    const st = git(['status', '--porcelain']);
    if (st.status !== 0) return { dirty: null, branch: null, cleaned: false, reason: `git status --porcelain failed${gitWhy(st)}` };
    if (!gitOut(st)) return { dirty: false, branch: null, cleaned: false, reason: null };

    const v = gitVersion(root);
    // The explicit name, not `git checkout -`: a supervisor digging itself out of a crash
    // loop must not depend on reflog state. Detached HEAD (branch reads "HEAD") aims at the sha.
    const original = (v.branch && v.branch !== 'HEAD' && v.branch !== '???') ? v.branch : v.sha;
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const branch = `rescue/${stamp}`;
    // Only ever called BEFORE a commit could have landed, where `git checkout <original>`
    // provably cannot lose anything: git refuses a checkout that would overwrite local
    // changes and otherwise carries them across. After the commit step we never check
    // anything out except through the gate below.
    const restoreBeforeCommit = () => {
      const back = git(['checkout', original]);
      if (back.status !== 0) alarm(`could not return to ${original} after a failed archive${gitWhy(back)} — the repo is left on ${branch} with your work INTACT and uncommitted`);
    };

    const co = git(['checkout', '-b', branch]);
    if (co.status !== 0) return { dirty: true, branch: null, cleaned: false, reason: `git checkout -b ${branch} failed${gitWhy(co)}` };
    const add = git(['add', '-A']);
    if (add.status !== 0) { restoreBeforeCommit(); return { dirty: true, branch: null, cleaned: false, reason: `git add -A failed${gitWhy(add)}` }; }
    const ci = git(['commit', '-m', `rescue: dirty tree at boot failure ${stamp}`]);
    if (ci.status !== 0) { restoreBeforeCommit(); return { dirty: true, branch: null, cleaned: false, reason: `git commit failed${gitWhy(ci)}` }; }

    // --- THE GATE ---------------------------------------------------------------------
    // Past this point a commit may exist, so a checkout could genuinely discard the tree.
    // If we cannot PROVE the archive is real we do not check anything out at all — not even
    // back — and leave the repo sitting on the rescue branch. The work is then either in the
    // rescue commit or still in the working copy; both are intact, and the spine restarting
    // on the same broken code is the cheap half of the trade.
    const verify = git(['rev-parse', '--verify', `${branch}^{commit}`]);
    if (verify.status !== 0 || !gitOut(verify)) return { dirty: true, branch: null, cleaned: false, reason: `${branch} does not resolve to a commit after the archive commit${gitWhy(verify)} — left the repo on ${branch}, nothing checked out` };
    const after = git(['status', '--porcelain']);
    if (after.status !== 0 || gitOut(after)) return { dirty: true, branch: null, cleaned: false, reason: `work is STILL uncommitted after the archive commit${gitOut(after) ? ` (${gitOut(after).split('\n').length} path(s))` : gitWhy(after)} — left the repo on ${branch}, nothing checked out` };

    // Best-effort offsite copy. A push failure must never block recovery — the branch
    // already exists locally, which is what the archive guarantee rests on. Timed out
    // because a hung network call in a supervisor is a second outage.
    const push = git(['push', '-u', 'origin', branch], { timeout: 30_000 });
    if (push.status !== 0) log(`rescue branch ${branch} could not be pushed${gitWhy(push)} — it exists locally; recovery continues`);

    const back = git(['checkout', original]);
    if (back.status !== 0) return { dirty: true, branch, cleaned: false, reason: `archived to ${branch} but could not check ${original} back out${gitWhy(back)}` };
    return { dirty: true, branch, cleaned: true, reason: null };
  }

  // Step 2 driver: archive+clean, or explain why it did neither. Never throws, never leaves
  // the caller unable to respawn.
  function runBootRescue(pid) {
    alarm(`the spine has failed to BOOT ${neverHealthyStreak}x in a row (it never beat once) — checking the working tree before it fails again`);
    const r = archiveAndCleanDirtyTree();
    if (r.dirty === false) {
      log('working tree is clean — nothing to archive; the breakage is in committed code, counting towards the rollback');
      return;
    }
    if (!r.cleaned) {
      const where = r.branch ? `archived to branch ${r.branch}, but the working copy could NOT be restored` : 'NOT archived, so the working copy was left exactly as it was';
      alarm(`REFUSING to clean the working tree: ${r.reason}. Your work is ${where}. The spine will keep restarting, still broken — fix it by hand.`);
      writeFallbackAnnounce('rescue-failed', pid, { force: true, note: `boot failed ${neverHealthyStreak}x with a dirty tree — the rescue did not complete (${r.reason}); your work is ${where}` });
      return;
    }
    alarm(`dirty tree archived to branch ${r.branch} and the working copy cleaned — retrying the boot on committed code`);
    writeFallbackAnnounce('rescue', pid, { force: true, note: `boot failed ${neverHealthyStreak}x with a dirty tree — your uncommitted work is archived on branch ${r.branch}, the working copy was cleaned and the spine restarted` });
  }

  // Step 3 driver: the code itself is bad, roll it back to the last commit a spine was ever
  // seen healthy on. If the marker is missing/unreadable we say so and fall through to step
  // 4 — a supervisor guessing a git ref is how you turn an outage into a worse one.
  async function runBootRollback(pid) {
    const good = readLastGood();
    if (!good) {
      alarm(`the spine has failed to BOOT ${neverHealthyStreak}x — I would roll the code back, but ${lastGoodPath} is missing or unreadable, so there is no commit known to boot. NOT guessing. Restarting on the current code.`);
      writeFallbackAnnounce('rollback-impossible', pid, { force: true, note: `boot failed ${neverHealthyStreak}x and there is no last-known-good marker — could not roll back; still restarting` });
      return;
    }
    alarm(`the spine has failed to BOOT ${neverHealthyStreak}x even after the working tree was dealt with — rolling the code back to last-known-good ${good.sha}${good.at ? ` (healthy at ${good.at})` : ''}`);
    const ok = await runRewind({ ref: good.sha });
    writeFallbackAnnounce(ok ? 'rollback' : 'rollback-failed', pid, {
      force: true,
      note: ok
        ? `boot failed ${neverHealthyStreak}x — the code was rolled back to last-known-good ${good.sha}`
        : `boot failed ${neverHealthyStreak}x and the rollback to ${good.sha} did NOT complete — restarting on the current code`,
    });
    if (!ok) alarm(`rollback to ${good.sha} did not complete — restarting on the current code anyway`);
  }

  // --- the stand-down watch (the Session 0 → Session 1 handover) ---------------------------
  // A peer has taken the profile. The daemon is the only thing alive across the handover, so it
  // does the waiting: no respawn while the peer still HOLDS the profile, one respawn when it
  // lets go (logoff, crash — the session ended and took the spine with it).
  //
  // The observation is peer-liveness's, NOT a second probe. Its ASYMMETRIC HYSTERESIS carries
  // over unchanged, and the asymmetry is if anything more important here than where it was
  // written: believing the peer dead when it is alive would start a SECOND spine on one
  // EGPT_HOME — two Beeper connections, two answers, both writing conversations.yaml — which is
  // the one unrecoverable failure in this design. Believing it alive when it is dead only costs
  // a few more seconds of silence. So this loop drives the module's tick() on the module's own
  // cadence and adds exactly one thing: respawn when it finally claims.
  //
  // --- WHAT "HOLDS" MEANS, AND WHY IT IS NOT A PORT (reve, 2026-09-11 logon) ----------------
  // THE INCIDENT. The handover worked — exit 45, the S0 daemon stood down, the S1 spine took
  // ~/.egpt — and then two spines sat on one profile for about two minutes. This watch used to
  // ask ONE question, tcpProbe on the console port, and read the answer as "has the peer
  // released the profile?". Those are different questions. Beeper claims the first free port
  // upward from 23373 and took 23375 the instant the departing spine released it, so the
  // successor — alive, holding ~/.egpt, beating alive.txt — never bound its console port at all
  // (`SPINE 11924 session=1 listening=-`). The port went quiet, the watch claimed, spawnShell()
  // put a second spine onto a profile that was already held. A spine that is alive but cannot
  // bind its port must not be invisible to the mutex.
  //
  // THE FIX IS TO ASK THE QUESTION checkSingleton ALREADY ASKS, over the same two facts and
  // through the same predicate: livePidIn(spinePidPath) — identity from state/spine.pid (which
  // the spine writes and which is visible across the session boundary, unlike a child handle),
  // liveness from alive.txt's mtime via liveDaemonPid's 120s gate. Pids are reused by the OS, so
  // the pid ALONE is never the answer; that pairing is exactly why liveDaemonPid takes both.
  // One source of truth, reused — no second watcher, no second cadence, no new predicate.
  //
  // NEITHER SIGNAL OVERRIDES THE OTHER. Both are evidence of a HOLDER, so the peer is presumed
  // present while EITHER answers and it takes BOTH saying "nobody" to claim:
  //   • LIVE PID, QUIET PORT — the incident. The pid is direct evidence of the holder; the port
  //     only ever stood in for it. HELD, and the watch must not claim.
  //   • DEAD PID, BUSY PORT — a squatter (Beeper), or a spine whose pid file we could not read,
  //     or one whose beat is stale for a reason that is not death: beatAge is WALL-CLOCK, so
  //     after a suspend every pid on the profile reads dead until the next beat (the same trap
  //     checkLiveness's resume grace exists for). Claiming on a dead pid alone would therefore
  //     respawn onto a live peer after every sleep — the unrecoverable direction — so this is
  //     HELD too. TIME_WAIT is NOT the reason: a socket in TIME_WAIT has no listener and refuses
  //     a connect, so it can only ever make a port read QUIET, never busy. The cost is real and
  //     is said out loud below: a squatter on the console port keeps this daemon stood down
  //     until a human moves it.
  //
  // THE ONE WINDOW WHERE spine.pid CAN NAME A DEAD PROCESS, and why the hysteresis covers it:
  // the successor writes spine.pid immediately after announcing the stand-down (src/spine/
  // boot.mjs — the announce is the block right before the write), so by the time exit 45 reaches
  // us the file normally already names the LIVE successor. Only if the incumbent drains and
  // exits faster than the successor's own mkdir+write lands does the file name the departing pid
  // — for those milliseconds, and with the port not yet bound either. Three consecutive misses
  // at 5s is ~15s of cover for a sub-second window.
  function standdownPort() {
    let named = null;
    try {
      named = validPort(Number(readFileSync(standdownSidecar, 'utf8').trim()));
      unlinkSync(standdownSidecar);   // consumed like the rewind sidecar, valid or not
    } catch { /* no sidecar — the profile's own console port is the answer */ }
    if (named) return named;
    try {
      const doc = YAML.parse(readFileSync(configYamlPath, 'utf8')) ?? {};
      const own = validPort(Number(doc?.shell?.port));
      if (own) return own;
    } catch { /* missing / unreadable / malformed config — the default is the answer */ }
    return DEFAULT_CONSOLE_PORT;
  }

  function standDownAndWatch() {
    const port = standdownPort();
    const serving = peerProbe({ port });
    // The disagreement already said out loud, or null while the two signals agree. Said on the
    // TRANSITION, not every tick: a stand-down can last a whole workday and this must not become
    // the log's texture — but it must be there, because both disagreements mean the daemon is
    // staying down for a reason a human may need to act on.
    let announced = null;
    const probe = async () => {
      const pid = livePidIn(spinePidPath);
      const answers = await serving();
      const disagreement = pid != null && !answers ? 'pid' : (pid == null && answers ? 'port' : null);
      if (disagreement !== announced) {
        announced = disagreement;
        if (disagreement === 'pid') log(`stand-down watch: 127.0.0.1:${port} is quiet, but ${spinePidPath} names LIVE pid ${pid} and alive.txt is fresh — the profile IS held. A spine that is alive but could not bind its console port is still a spine; not claiming.`);
        if (disagreement === 'port') log(`stand-down watch: something answers on 127.0.0.1:${port} but ${spinePidPath} names no live spine — that is a squatter, not the peer. Not claiming (a dead pid alone is also what a machine looks like the moment it wakes from sleep), so this profile stays down until whatever holds that port is moved off it.`);
      }
      return pid != null || answers;
    };
    const watcher = createPeerLiveness({
      probe,
      subject: 'the profile',
      onLog: (m) => log(`stand-down watch: ${m}`),
    });
    log(`stood down — a peer has taken the profile on 127.0.0.1:${port}; NOT respawning while ${spinePidPath} names a live spine or that port answers, re-checked every ${Math.round(PEER_PROBE_EVERY_MS / 1000)}s`);
    let respawned = false;   // a slow probe can overlap the next tick; only ONE respawn ever
    standdownTimer = setIntervalFn(async () => {
      if (respawned || stopping) return;
      await watcher.tick();
      if (respawned || stopping || !watcher.isClaiming()) return;
      respawned = true;
      if (standdownTimer) { clearIntervalFn(standdownTimer); standdownTimer = null; }
      log(`${spinePidPath} names no live spine and 127.0.0.1:${port} is quiet — nothing holds the profile now; respawning the spine`);
      backoff = RESTART_MIN_MS;   // a handover is not a failure; the next boot starts clean
      spawnShell();
    }, PEER_PROBE_EVERY_MS);
    standdownTimer?.unref?.();
  }

  // --- the per-profile child log ------------------------------------------------------------
  // Is `path` the very file our OWN stdout/stderr is already being captured into? Under the
  // merged service NSSM captures the DAEMON's output into the PRIMARY profile's
  // service-stdout.log, which is also where that profile's spine belongs. Opening a second
  // handle on it would give one file two appenders, and NSSM's own rotation would then rename
  // it out from under ours — every later line going to a file nobody tails. Cheap to detect
  // (same inode, same device) and the honest answer is to not do it and say so.
  function isOurOwnCapture(path, fd) {
    try {
      const a = statSync(path);
      const b = fstatSync(fd);
      if (a?.ino == null || b?.ino == null) return false;   // no inode = no answer, so no claim
      if (!a.ino && !b.ino) return false;                   // Windows reports 0 for some handles
      return a.ino === b.ino && a.dev === b.dev;
    } catch { return false; }
  }

  // Roll at the same size and to the same name NSSM used. Done here, at spawn time, because it
  // is the one moment no child holds the handle: renaming a file a live child is writing to
  // just moves the bytes it is still producing into the rolled copy.
  function rollIfOversize(path) {
    let size;
    try { size = statSync(path).size; } catch { return; }   // absent is the ordinary first boot
    if (!(size >= childLogMaxBytes)) return;
    try {
      renameSync(path, rolledName(path, now()));
      log(`rolled ${path} (${humanBytes(size)}) — a fresh one starts now`);
    } catch (e) {
      log(`could not roll ${path} at ${humanBytes(size)} (${e.message}) — it keeps growing`);
    }
  }

  function closeChildLogs() {
    if (!childLogFds) return;
    for (const fd of [childLogFds.out, childLogFds.err]) { try { closeSync(fd); } catch { /* already gone */ } }
    childLogFds = null;
  }

  // The pair for the next child, or null meaning "inherit, like a single-profile node".
  function openChildLogs() {
    if (!perProfileLogs) return null;
    const selfOut = processObj.stdout?.fd ?? 1;
    if (isOurOwnCapture(childLogPaths.stdout, selfOut)) {
      log(`${childLogPaths.stdout} is the file this service is already capturing my own output into, so I will NOT open a second handle on it — this profile's spine keeps writing to the service handles, mixed in with the other profiles. Re-run the service installer with -EgptHomes so the service captures its own output into daemon-{stdout,stderr}.log instead.`);
      return null;
    }
    try { mkdirSync(dirname(childLogPaths.stdout), { recursive: true }); } catch { /* the open below reports it */ }
    const fds = {};
    try {
      for (const [key, path] of [['out', childLogPaths.stdout], ['err', childLogPaths.stderr]]) {
        rollIfOversize(path);
        fds[key] = openSync(path, 'a');
      }
    } catch (e) {
      for (const fd of Object.values(fds)) { try { closeSync(fd); } catch { /* partial open */ } }
      log(`could not open this profile's own log files under ${dirname(childLogPaths.stdout)} (${e.message}) — its spine will write to the service handles, mixed in with the other profiles. Nothing is lost, but nothing distinguishes it either.`);
      return null;
    }
    return fds;
  }

  function spawnShell() {
    if (stopping) return null;
    const appPath = join(root, 'egpt-spine.mjs');
    const args = [appPath, ...shellArgs];
    log('starting node egpt-spine.mjs');
    childStartedAt = now();
    // Snapshot the beat BEFORE the spawn — this, and nothing else, is what separates "the
    // spine could not boot" from "the spine ran and then died" when the child exits.
    spawnBeatMtime = beatMtime();
    lastGoodRecorded = false;
    // Close the pair the PREVIOUS child held before opening the next: one open, one close, so a
    // spine that respawns on 42/43/44 or after a stand-down never leaks a handle. Nothing
    // writes to these between the two — the daemon's own lines go to its own stdout — so the
    // gap costs no lines.
    closeChildLogs();
    childLogWarned = false;
    childLogFds = openChildLogs();
    child = spawn('node', args, {
      cwd: root,
      // One profile: the service's own handles, and NSSM's capture and rotation, untouched.
      // Several: this profile's own two files (stdin dropped — a supervised spine reads none).
      stdio: childLogFds ? ['ignore', childLogFds.out, childLogFds.err] : 'inherit',
      // EGPT_HOME is stated EXPLICITLY rather than inherited: one process now supervises
      // several profiles (see startProfileDaemons), and the ambient EGPT_HOME can only name
      // one of them. A spine that inherited the wrong one would be a second node on somebody
      // else's profile. Identical to today's value when there is only one profile.
      env: { ...processObj.env, EGPT_HOME: egptHome, EGPT_SUPERVISED: '1' },
    });

    child.on('exit', async (code, signal) => {
      const exitedPid = child?.pid;   // capture before child = null, below
      child = null;
      if (stopping) return;
      log(`shell exited code=${code} signal=${signal ?? '-'}`);

      // A wedge-kill must respawn regardless of exit code: on POSIX the SIGTERM'd
      // child exits 0, which would otherwise fall into the clean-exit branch and
      // stop the whole daemon. Respawn — but ESCALATE the delay per consecutive
      // wedge so a permanently-dead heartbeat backs off instead of hot-looping.
      if (wedgeKilled) {
        wedgeKilled = false;
        wedgeStreak += 1;
        const delay = Math.min(RESTART_MIN_MS * 2 ** (wedgeStreak - 1), RESTART_MAX_MS);
        log(`no heartbeat from the spine — respawn #${wedgeStreak} in ${Math.round(delay / 1000)}s (stop the service or restore the heartbeat)`);
        writeFallbackAnnounce('wedge', exitedPid);
        setTimeoutFn(spawnShell, delay);
        return;
      }

      if (code === CLEAN_EXIT_CODE) {
        log('clean exit — egpt-daemon stopping (user wanted out)');
        processObj.exit(0);
        return;
      }

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

      // The one code that does not respawn — a peer holds the profile now (see the watch above).
      if (code === STANDDOWN_EXIT_CODE) {
        standDownAndWatch();
        return;
      }

      // === the boot-failure ladder (operator 2026-08-30) ================================
      // A spine that ran for an hour and then crashed advanced alive.txt: that is today's
      // plain-backoff crash and it CLEARS the ladder. A spine that never advanced it never
      // booted — the SyntaxError case — and 33 minutes of identical restarts is what this
      // branch exists to make impossible. The ladder never stops respawning: step 4 is
      // "keep trying forever, loudly", because "a spine being down, with a watcher, is just
      // unjustifiable".
      if (childEverBeat()) {
        neverHealthyStreak = 0;
        log(`crash — restarting in ${backoff}ms`);
        writeFallbackAnnounce('crash', exitedPid);
      } else {
        neverHealthyStreak += 1;
        if (neverHealthyStreak === NEVER_HEALTHY_RESCUE_AT) {
          runBootRescue(exitedPid);
        } else if (neverHealthyStreak === NEVER_HEALTHY_ROLLBACK_AT) {
          await runBootRollback(exitedPid);
        } else if (neverHealthyStreak > NEVER_HEALTHY_ROLLBACK_AT) {
          // Step 4. Nothing left to try — so keep trying anyway, and keep saying so.
          alarm(`the spine STILL cannot boot after ${neverHealthyStreak} tries, a tree rescue and a rollback — restarting in ${backoff}ms and I will not stop. This needs a human.`);
          writeFallbackAnnounce('boot-failure', exitedPid, { force: true, note: `the spine could not boot ${neverHealthyStreak}x in a row; the tree rescue and the rollback both failed to fix it` });
        } else {
          // Crashes 1..RESCUE_AT-1: today's behaviour exactly, just named for what it is.
          log(`crash before the spine ever beat (never-healthy #${neverHealthyStreak}/${NEVER_HEALTHY_RESCUE_AT}) — restarting in ${backoff}ms`);
          writeFallbackAnnounce('crash', exitedPid);
        }
      }
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
    releaseSession();
    closeChildLogs();
    if (livenessTimer) { clearIntervalFn(livenessTimer); livenessTimer = null; }
    if (standdownTimer) { clearIntervalFn(standdownTimer); standdownTimer = null; }
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
    setTimeoutFn(() => processObj.exit(0), 500);
  }

  // Is a live pid recorded in `path`, by the same two facts liveDaemonPid has always decided
  // over: identity from a pid file, liveness from the alive.txt mtime.
  function livePidIn(path) {
    let pidFileContent = '';
    try { pidFileContent = readFileSync(path, 'utf8'); } catch { /* absent = clear field */ }
    return liveDaemonPid({ pidFileContent, beatAgeMs: beatAge() });
  }

  function checkSingleton() {
    const otherPid = livePidIn(daemonPidPath);
    if (otherPid) {
      log(`another egpt daemon is already alive in ${sessionLabel} on this profile (daemon pid ${otherPid}, alive.txt fresh) — refusing to start a second daemon that would fight over WhatsApp. Exiting.`);
      log('to open an interactive shell instead, run `node egpt.mjs` — it opens the operator shell, which SERVES a WS the running spine dials into (no pidfile handshake, no WA handback; the shell and the spine run as independent processes).');
      processObj.exit(0);
      return false;
    }
    return true;
  }

  // Claim the session. Written before the first spawn and removed on shutdown, so the next
  // daemon in THIS session on THIS profile is refused and one in the other session is not.
  function claimSession() {
    try {
      mkdirSync(dirname(daemonPidPath), { recursive: true });
      writeFileSync(daemonPidPath, String(processObj.pid ?? process.pid));
    } catch (e) {
      // Never silent: without this file the singleton has nothing to read, so a second daemon
      // started in this session would NOT be refused — and two supervisors on one EGPT_HOME is
      // how two spines get onto it.
      log(`could not write ${daemonPidPath} (${e.message}) — a second daemon started in ${sessionLabel} on this profile would NOT be refused. Fix the profile's state/ directory.`);
    }
  }

  function releaseSession() {
    try { unlinkSync(daemonPidPath); } catch { /* never written, or already gone */ }
  }

  function registerSignals() {
    processObj.on('SIGINT', () => shutdown('SIGINT'));
    processObj.on('SIGTERM', () => shutdown('SIGTERM'));
    if (platform !== 'win32') processObj.on('SIGHUP', () => shutdown('SIGHUP'));
  }

  function start() {
    registerSignals();
    if (!checkSingleton()) return null;
    claimSession();
    const v = gitVersion(root);
    log(`egpt-daemon up — running app from ${root} (profile ${egptHome}, ${sessionLabel})`);
    log(`version: ${v.sha} (${v.tag}, branch ${v.branch})`);
    // ARRIVING INTO A PROFILE SOMEBODY ELSE IS HOLDING. Session-scoping the singleton opens a
    // door the profile-scoped guard used to hold shut: this daemon may now start while another
    // session's spine — or an orphan our own crashed predecessor left behind — still holds this
    // EGPT_HOME. Only the SUCCESSOR is entitled to spawn into that: its spine announces the
    // stand-down on the console port and the incumbent drains and leaves (chunk 3). Anyone else
    // spawning here would put a SECOND spine on one profile, which is the one unrecoverable
    // failure in this design. So a non-successor takes the seat the departing daemon takes: it
    // watches the profile and comes back the moment nothing holds it. Same watch, same predicate
    // (this very livePidIn call, re-asked every 5s), same hysteresis, no second mechanism — and
    // it does NOT exit, so a logoff is recovered from without a restart.
    const incumbent = session1 ? null : livePidIn(spinePidPath);
    let c = null;
    if (incumbent) {
      log(`spine pid ${incumbent} is already holding this profile and this daemon is not its successor (${SESSION1_ENV} is unset) — NOT spawning a second spine on one EGPT_HOME`);
      standDownAndWatch();
    } else {
      c = spawnShell();
    }
    if (livenessIntervalMs > 0 && !livenessTimer) {
      livenessTimer = setIntervalFn(checkLiveness, livenessIntervalMs);
      livenessTimer?.unref?.();
    }
    return c;
  }

  return {
    buildExtension,
    checkLiveness,
    checkSingleton,
    gitVersion,
    registerSignals,
    runRewind,
    runUpgrade,
    shutdown,
    spawnShell,
    start,
    get child() { return child; },
    get state() { return { stopping, backoff, wedgeStreak, neverHealthyStreak, standingDown: standdownTimer != null, session: sessionKey, egptHome, shellArgs: [...shellArgs] }; },
  };
}

// --- one daemon, N profiles (operator 2026-09-11) ------------------------------------------
// "egpt-daemon supervises both s0-primary and s0-secondary … an s1 can only be monitored by an
// s1. so we need this other daemon in s1. egpt-daemon should monitor all the configured
// accounts for that session level."
//
// This is a FAN-OUT, not a second supervisor: createDaemonRuntime is already the whole
// supervisor and is already keyed by EGPT_HOME, so N profiles are N runtimes in one process.
// The only thing this owns is the process exit — a runtime calls processObj.exit() when the
// operator's /exit lands or when the singleton refuses, and with several profiles in one
// process that must retire ONE profile, not take the others down with it. Each runtime is
// therefore handed its own exit seam and the real process exits when the last one is gone.
export function startProfileDaemons({ profiles, createRuntime = createDaemonRuntime, ...opts } = {}) {
  const processObj = opts.processObj ?? process;
  const stdout = opts.stdout ?? process.stdout;
  const now = opts.now ?? Date.now;
  const homes = profiles ?? resolveProfiles(processObj.env);
  const say = (m) => stdout.write(`[egpt-daemon ${new Date(now()).toISOString()}] ${m}\n`);
  // THE ONLY THING SHARING A PROCESS CHANGES about a runtime: its child can no longer inherit
  // the service's handles (they belong to every profile at once), and its own log lines can no
  // longer be read without knowing which profile they are about. One profile changes neither.
  const shared = homes.length > 1;
  const perProfileLogs = opts.perProfileLogs ?? shared;
  // ~/.egpt -> egpt, ~/.egpt-secondary -> egpt-secondary. The same name the service and the
  // session-1 task are derived from, so one word finds all three.
  const tagFor = (home) => (shared ? basename(home.replace(/[\\/]+$/, '')).replace(/^\./, '') : null);

  const live = new Set(homes);
  const retire = (home, code) => {
    if (!live.delete(home)) return;   // already retired; a second exit() is a no-op
    if (live.size === 0) { processObj.exit(code); return; }
    say(`profile ${home} is no longer supervised (exit ${code}) — still supervising ${[...live].join(', ')}`);
  };
  const seamFor = (home) => ({
    get env() { return processObj.env; },
    get pid() { return processObj.pid; },
    // Forwarded so each runtime can ask what THIS process's stdout is already going into,
    // which is how it avoids opening a second handle on the file the service is capturing.
    get stdout() { return processObj.stdout; },
    on: (...a) => processObj.on(...a),
    exit: (code) => retire(home, code),
  });

  say(`supervising ${homes.length} profile(s): ${homes.join(', ')}`);
  const runtimes = [];
  const failed = [];
  for (const home of homes) {
    const runtime = createRuntime({
      ...opts, perProfileLogs, logTag: opts.logTag ?? tagFor(home), egptHome: home, processObj: seamFor(home),
    });
    runtimes.push({ egptHome: home, runtime });
    let child = null;
    try { child = runtime.start(); } catch (e) { say(`profile ${home} threw while starting: ${e?.message ?? e}`); }
    // A runtime that stood down IS supervising — the watch is the supervision, and it will
    // spawn the moment nothing holds that profile any more.
    if (child == null && runtime.state?.standingDown !== true) failed.push(home);
  }
  // "Half-alive is worse than down" (INTENT.md): a node asked for two profiles that came up
  // with one must not look healthy. The banner is the ladder's alarm() shape, for the same
  // reason — a log whose normal texture is one line per profile hides a missing one.
  if (failed.length) {
    const rule = '!'.repeat(78);
    say(rule);
    say(`!! asked to supervise ${homes.length} profile(s) but ${failed.length} did not come up: ${failed.join(', ')} — this node is supervising ${homes.length - failed.length} of ${homes.length}`);
    say(rule);
  }
  return { profiles: homes, runtimes, failed };
}
