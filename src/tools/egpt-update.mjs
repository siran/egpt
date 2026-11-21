// egpt-update.mjs — keeping eGPT itself current: the 6-hourly look at the checkout's upstream, the
// log_to_group notice, auto-full → `/upgrade full` when the daemon's own files changed (else `/upgrade`),
// auto → `/upgrade`, and the ask_on_boot line. The sibling of beeper-update.mjs
// (same cadence, same noticed/autoTried state, same say/hint). Applying is the existing `/upgrade [full]`:
// boot's announceAndExit(46 | 42), which drains turns (the next quiet moment) and waits for a busy Beeper update.
//
// config: auto_update.egpt = auto-full | auto | manual | none (default auto-full), auto_update.ask_on_boot = true | false
// (default true) (config-schema.mjs). Beeper's own method stays in beeper.auto_update.<os>.method.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { EGPT_HOME } from '../egpt-home.mjs';
import { gitEnv } from '../git-env.mjs';
import { CHECK_EVERY_MS, autoUpdateMethod } from './beeper-update.mjs';
import { daemonGraph, daemonChanges } from './daemon-graph.mjs';

const EGPT_METHODS = ['auto-full', 'auto', 'manual', 'none'];
const SUBJECTS = 3;            // commit subjects the notice names
const SUBJECT_CAP = 60;        // each cut to this many characters
const GIT_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 60_000;
const QUIET = 'at the next quiet moment';
const short = (sha) => String(sha).slice(0, 8);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// { method, note }: the method this node runs; note = the one log line when what is configured is not one.
export function egptMethod(cfg) {
  const raw = cfg?.auto_update?.egpt;
  const method = raw == null ? 'auto-full' : String(raw).trim().toLowerCase();
  if (!EGPT_METHODS.includes(method)) return { method: 'none', note: `auto_update.egpt "${raw}" is not auto-full | auto | manual | none — treated as none` };
  return { method, note: null };
}

// git in the checkout → its stdout; a failure is git's own first line. Never a credentials prompt.
export function runGit(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split('\n')[0] || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

// r = { branch, upstream, from, to, behind, ahead, subjects, how }, how: auto-full | auto | manual | diverged.
export function noticeLine(node, r, hint) {
  const subjects = r.subjects.map((s) => (s.length > SUBJECT_CAP ? `${s.slice(0, SUBJECT_CAP - 1)}…` : s)).join('; ');
  const more = r.behind > r.subjects.length ? ` (+${r.behind - r.subjects.length} more)` : '';
  const how = {
    'auto-full': `upgrading (/upgrade full) ${QUIET}`,
    auto: `upgrading (/upgrade) ${QUIET}`,
    manual: `send ${hint}`,
    diverged: `not upgrading: this checkout has ${plural(r.ahead, 'commit')} ${r.upstream} lacks, so /upgrade (git pull --ff-only) would fail`,
  }[r.how];
  return `⬆ ${node} · eGPT ${plural(r.behind, 'new commit')} on ${r.branch} (${short(r.from)} → ${short(r.to)}): ${subjects}${more} — ${how}`;
}

// items = [{ text, ask }]: ask = a human still has to type something.
export const askLine = (items) => (items.length ? `⬆ pending: ${items.map((i) => i.text).join(' · ')}${items.some((i) => i.ask) ? '. Apply now?' : ''}` : null);

export function createEgptUpdate({
  getConfig = () => ({}),
  platform = process.platform,
  home = EGPT_HOME,
  repoRoot = process.cwd(),
  git = (args, timeoutMs) => runGit(args, { cwd: repoRoot, timeoutMs }),
  upgrade = async () => {},           // (full) boot: announceAndExit(46 | 42), the /upgrade [full] drain, never forced
  restartPending = () => false,       // a /restart or /upgrade is draining: it goes first
  supervised = () => true,            // a daemon respawns this spine (boot: EGPT_SUPERVISED=1); without one, auto would only stop the node
  logToGroup = async () => false,     // (text) => posts one line to log_to_group
  daemonRespawns = () => true,        // something brings the daemon back when /upgrade full ends it (daemon-runtime's respawnsOf); else full is never run
  daemonFiles = () => daemonGraph(repoRoot),   // → { files, packages }: what the daemon process loads, from its import graph
  hint = (cmd) => `/${cmd}`,          // (cmd: 'upgrade' | 'upgrade full') what a human types on this node
  beeperPending = async () => null,   // boot: beeperUpdate?.pending?.() → { from, to, hint } | null
  now = Date.now,
  everyMs = CHECK_EVERY_MS,
  io = { readFile, writeFile, mkdir, rename },
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};
  const node = () => cfg().node_name ?? '?';
  const statePath = join(home, 'state', 'egpt-update.json');
  let st = null, lastCheck = null, run = null, noted = false;
  let firstLook;
  const bootLook = new Promise((resolve) => { firstLook = resolve; });   // the look the spine's first tick makes

  const load = async () => {
    if (!st) { try { st = JSON.parse(String(await io.readFile(statePath, 'utf8'))); } catch { st = {}; } }
    return st;
  };
  const save = async () => {
    await io.mkdir(join(home, 'state'), { recursive: true });
    await io.writeFile(`${statePath}.tmp`, JSON.stringify(st), 'utf8');
    await io.rename(`${statePath}.tmp`, statePath);
  };
  const say = (text) => { onLog(text); return logToGroup(text); };   // the spine log keeps it when log_to_group is unset

  // The checkout's upstream, fetched, against HEAD → r without `how`; null when the state is unknown
  // (no upstream, detached HEAD) or the fetch failed: a log line, nothing else.
  async function probe() {
    let branch, upstream;
    try { [branch, upstream] = (await git(['rev-parse', '--abbrev-ref', 'HEAD', '@{u}'])).split('\n'); }
    catch (e) { onLog(`state unknown — ${e.message}`); return null; }
    try { await git(['fetch', '--quiet'], FETCH_TIMEOUT_MS); }
    catch (e) { onLog(`fetch failed — ${e.message}`); return null; }
    const [from, to] = (await git(['rev-parse', 'HEAD', '@{u}'])).split('\n');
    const [behind, ahead] = (await Promise.all([git(['rev-list', '--count', 'HEAD..@{u}']), git(['rev-list', '--count', '@{u}..HEAD'])])).map(Number);
    const subjects = behind ? (await git(['log', '--format=%s', '-n', String(SUBJECTS), 'HEAD..@{u}'])).split('\n') : [];
    const changed = behind ? (await git(['diff', '--name-only', 'HEAD..@{u}'])).split('\n').filter(Boolean) : [];
    return { branch, upstream, from, to, behind, ahead, subjects, changed };
  }

  // At boot, every 6 h: ONE notice per new upstream sha; auto-full / auto apply it, ONCE per sha (persisted
  // before the exit: a pull that leaves the checkout behind must not loop the node).
  async function check() {
    const m = egptMethod(cfg());
    if (m.method === 'none') return null;
    const r = await probe();
    if (!r?.behind) return r;
    await load();
    const live = !r.ahead && (m.method === 'auto-full' || m.method === 'auto') && supervised() && st.autoTried !== r.to;
    // auto-full: the daemon is renewed only when a file it loads changed (its import graph, or package files if it
    // imports a package); where nothing respawns it, that is NOT done: spine only, and a human is told.
    let mode = m.method, why = null, stuck = false;
    if (live && mode === 'auto-full') {
      const hit = daemonChanges(r.changed, await daemonFiles());
      const names = `${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ` (+${hit.length - 5} more)` : ''}`;
      if (!hit.length) { mode = 'auto'; why = 'daemon unchanged → spine-only upgrade'; }
      else if (!daemonRespawns()) { mode = 'auto'; stuck = true; why = `daemon files changed: ${names} → /upgrade full needed, but nothing respawns the daemon here (EGPT_DAEMON_RESPAWNS unset): spine-only upgrade now, send ${hint('upgrade full')} by hand to renew the daemon`; }
      else why = `daemon files changed: ${names} → full`;
    }
    r.how = r.ahead ? 'diverged' : live ? mode : 'manual';
    r.cmd = mode === 'auto' ? 'upgrade' : 'upgrade full';
    if (st.noticed !== r.to) {
      st.noticed = r.to;
      await save();
      await say(noticeLine(node(), r, hint(r.cmd)));
      if (why) await (stuck ? say(`⬆ ${node()} · ${why}`) : onLog(why));
    }
    if ((r.how === 'auto-full' || r.how === 'auto') && !restartPending()) {
      st.autoTried = r.to;
      await save();
      await upgrade(r.how === 'auto-full');
    }
    return r;
  }

  // → the promise of the latest look: this check, or the one made within everyMs.
  function tick(nowMs = now()) {
    if (!noted) { noted = true; const n = egptMethod(cfg()).note; if (n) onLog(n); }
    if (lastCheck != null && nowMs - lastCheck < everyMs) return run;
    lastCheck = nowMs;
    run = check().catch((e) => { onLog(`check: ${e?.message ?? e}`); return null; });
    firstLook(run);
    return run;
  }

  // Boot, after the "back up" line: ONE line of what is pending (eGPT and/or Beeper), or null. It waits
  // for the boot look, which the spine's first tick makes, and asks Beeper only after it: nothing here
  // reaches out on its own (a node whose spine never ticks reads no install and fetches no feed).
  async function askOnBoot() {
    if (String(cfg().auto_update?.ask_on_boot ?? true).trim().toLowerCase() === 'false') return null;
    const r = await bootLook;
    const b = await beeperPending().catch((e) => { onLog(`beeper pending: ${e?.message ?? e}`); return null; });
    const items = [];
    if (r?.behind) {
      const what = `eGPT ${plural(r.behind, 'commit')} (${short(r.from)} → ${short(r.to)})`;
      items.push({
        diverged: { text: `${what} — this checkout has ${plural(r.ahead, 'commit')} ${r.upstream} lacks: /upgrade would not fast-forward`, ask: false },
        'auto-full': { text: `${what} — ${QUIET}`, ask: false },
        auto: { text: `${what} — ${QUIET}`, ask: false },
        manual: { text: `${what} — ${hint(r.cmd)}`, ask: true },
      }[r.how]);
    }
    if (b) {
      const auto = autoUpdateMethod(cfg(), platform).method === 'auto';
      items.push({ text: `Beeper ${b.from} → ${b.to} — ${auto ? QUIET : b.hint}`, ask: !auto });
    }
    return askLine(items);
  }

  return { tick, check, askOnBoot };
}
