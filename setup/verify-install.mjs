#!/usr/bin/env node
// verify-install.mjs — GUARD 2: check the LIVE machine's egpt node install for the
// drift a vitest can never see. Read-only: it PROBES, it never fixes.
//
// It checks the node's two runners - the Session 1 task (setup/register-session1-daemon-task.ps1)
// registered for this profile, at logon, Interactive, logging under config/logs; and the Session 0
// service of the same name (setup/install-nssm-service.ps1): Automatic, as the user, AppExit 0 =
// Exit, the user's start/stop ACE. Off Windows, the daemon itself (daemonChecks). Then the profile
// shape (no stale old-layout residue), the spine pid/alive-beat, and that `claude` resolves.
//
// Usage:  node setup/verify-install.mjs [egptHome]      (default $EGPT_HOME, else ~/.egpt)
//
// Dependency-light: node builtins + the repo's `yaml`.
import { spawnSync } from 'node:child_process';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { runPowerShell } from './migrate.mjs';
import { configWarnings } from '../src/spine/router.mjs';
import { liveDaemonPid } from '../src/daemon-singleton.mjs';

// ── pure helpers (unit-tested; no live probes) ─────────────────────────────

// Strip NUL/BOM/CR noise and return the FIRST non-empty line. Accepts an already-decoded string.
export function firstLine(raw) {
  const clean = String(raw ?? '').replace(/[\u0000\uFEFF\r]/g, '');
  for (const line of clean.split('\n')) { const t = line.trim(); if (t) return t; }
  return '';
}

// Windows path compare: backslashes → slashes, drop a trailing slash, lowercase
// (NTFS is case-insensitive). Pure string shaping.
export function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Is `child` inside `parent` (or equal)? Boundary-safe (…/logsX is NOT under …/logs).
export function isUnderDir(child, parent) {
  const c = normPath(child), d = normPath(parent);
  return c === d || c.startsWith(d + '/');
}

// Boot's agents rule (src/spine/router.mjs configWarnings, logged at boot): there is no default
// agent — `default:` is ignored — and an on/auto mode set for a being or the node applies in every chat.
export function agentsCheck(cfg) {
  const warns = configWarnings(cfg);
  return warns.length ? warns.map((w) => ['warn', `config: ${w}`]) : [['ok', `config: parses, ${Object.keys(cfg?.agents ?? {}).length} agents`]];
}

export function expectedLogsDir(egptHome) { return join(egptHome, 'config', 'logs'); }

// The RETIRED old-layout paths — flagged if any is present in the new profile.
export function staleResiduePaths(egptHome) {
  return [
    { label: 'EGPT_HOME/conversations.yaml', path: join(egptHome, 'conversations.yaml') },
    { label: 'EGPT_HOME/identities/',        path: join(egptHome, 'identities') },
    { label: 'EGPT_HOME/ingest/',            path: join(egptHome, 'ingest') },
    { label: 'EGPT_HOME/logs/',              path: join(egptHome, 'logs') },
  ];
}

// ~/.egpt -> egpt-daemon, as the registrar derives it. The Session 0 service shares the name.
export function daemonTaskName(egptHome) {
  const base = basename(String(egptHome ?? '').replace(/[\\/]+$/, '')).replace(/^\./, '');
  return base ? `${base}-daemon` : null;
}

// `task` as probeRunner reports it: { state, logonType, triggers[], actions[{ execute, arguments }] }.
// The launcher's arguments: "<shim>" "<node>" "<repo>" "<EGPT_HOME>" "<log>".
export function taskChecks(task, { name, egptHome, exists = existsSync }) {
  if (!task) return [{ level: 'fail', msg: `runner: no scheduled task ${name} - nothing runs this node (setup\\register-session1-daemon-task.ps1 -EgptHome "${egptHome}")` }];
  const out = [];
  const bad = (msg) => out.push({ level: 'fail', msg: `runner: task ${name} ${msg}` });
  if (task.state === 'Disabled') bad('is Disabled - nothing starts at logon');
  if (task.logonType !== 'Interactive') bad(`LogonType is ${task.logonType}, not Interactive - it would run in session 0`);
  if (![].concat(task.triggers ?? []).includes('MSFT_TaskLogonTrigger')) bad('has no logon trigger');
  const actions = [].concat(task.actions ?? []);
  const args = actions.length === 1 ? [...String(actions[0].arguments ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [];
  const log = args[4] ?? '';
  if (!/[\\/]session1-daemon-launcher\.vbs$/i.test(args[0] ?? '')) bad(`does not run setup\\session1-daemon-launcher.vbs (${actions.map((a) => `${a.execute} ${a.arguments}`).join(' | ')})`);
  else if (normPath(args[3]) !== normPath(egptHome)) bad(`serves the profile ${args[3]}, not ${egptHome}`);
  else if (!isUnderDir(log, expectedLogsDir(egptHome))) bad(`logs to ${log} - NOT under ${expectedLogsDir(egptHome)} (log-dir drift)`);
  else if (!exists(dirname(log))) bad(`logs to ${log} - its dir is MISSING (the launcher dies before node starts)`);
  if (!out.length) out.push({ level: 'ok', msg: `runner: task ${name} ${task.state}, at logon, Interactive, logs to ${log}` });
  return out;
}

// '.\an' / 'REVE\an' name the same local account as 'reve\an'; 'LocalSystem' names none.
export function sameAccount(account, user) {
  const split = (s) => { const m = String(s ?? '').match(/^(.*)\\([^\\]+)$/); return m ? { d: m[1].toLowerCase(), u: m[2].toLowerCase() } : null; };
  const a = split(account), b = split(user);
  return !!(a && b && a.u === b.u && (a.d === '.' || a.d === b.d));
}

// The Session 0 runner, as probeRunner reports it: { status, startType, account, exit0, userAce, user }
// (Win32_Service State/StartMode/StartName; Parameters\AppExit value 0; whether sc.exe sdshow gives
// `user` start and stop, by beeper-desktop.ps1's Test-BeeperServiceAce).
export function serviceChecks(service, name) {
  const fix = 'setup\\install-nssm-service.cmd, at the console';
  if (!service) return [{ level: 'fail', msg: `S0 runner: no ${name} service - nothing runs this node while nobody is logged on (${fix})` }];
  const out = [];
  const bad = (msg) => out.push({ level: 'fail', msg: `S0 runner: service ${name} ${msg} (${fix})` });
  if (!/^auto(matic)?$/i.test(service.startType ?? '')) bad(`is ${service.startType}, not Automatic - nothing starts it at boot`);
  if (!sameAccount(service.account, service.user)) bad(`logs on as ${service.account || '?'}, not ${service.user} - it must run as the desktop user, never LocalSystem`);
  if (service.exit0 !== 'Exit') bad(`has AppExit 0 = ${service.exit0 || '(none)'}, not Exit - NSSM would restart it behind a STOP file`);
  if (!service.userAce) bad(`gives ${service.user} no start/stop right - stop-egpt and start-egpt cannot drive it unelevated`);
  if (!out.length) out.push({ level: 'ok', msg: `S0 runner: service ${name} ${service.status}, Automatic, as ${service.account}, AppExit 0 = Exit, ${service.user} may stop and start it` });
  return out;
}

// Off Windows the runner is the daemon itself: state/daemon-<s0|s1>.pid contents, judged by the
// daemon's own singleton rule (a live pid and a fresh alive.txt).
export function daemonChecks(pidFiles, beatAgeMs, isProcessAlive) {
  for (const key of ['s1', 's0']) {
    const pid = liveDaemonPid({ pidFileContent: pidFiles[key], beatAgeMs }, { isProcessAlive });
    if (pid) return [{ level: 'ok', msg: `runner: egpt daemon pid ${pid} (${key}) alive, alive.txt fresh` }];
  }
  return [{ level: 'fail', msg: 'runner: no live egpt daemon (state/daemon-s0.pid or daemon-s1.pid with a fresh alive.txt) - nothing runs this node' }];
}

// Beat-age → status. Alive beats every 60s; generous thresholds so a slow tick
// doesn't false-alarm, but a truly dead loop trips.
export function beatStatus(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return { level: 'fail', note: 'unreadable' };
  if (ageMs <= 180_000) return { level: 'ok', note: `${Math.round(ageMs / 1000)}s ago` };
  if (ageMs <= 600_000) return { level: 'warn', note: `${Math.round(ageMs / 1000)}s ago (stale?)` };
  return { level: 'fail', note: `${Math.round(ageMs / 1000)}s ago (dead?)` };
}

// The overall exit code: 0 iff every check is ✅; 1 if any ❌; 2 for ⚠️-only.
export function overallExit(levels) {
  if (levels.includes('fail')) return 1;
  if (levels.includes('warn')) return 2;
  return 0;
}

// ── live probes (not unit-tested) ──────────────────────────────────────────

const BEEPER_DESKTOP = join(dirname(fileURLToPath(import.meta.url)), 'beeper-desktop.ps1');

// The task and the service named `name`, read-only. Unelevated is enough for both (the service's
// SDDL grants interactive users read control, so sc.exe sdshow answers).
function probeRunner(name) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return JSON.parse(runPowerShell(`. ${q(BEEPER_DESKTOP)}
$name = ${q(name)}
$out = @{}
$t = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue
if ($t) { $out.task = @{ state = "$($t.State)"; logonType = "$($t.Principal.LogonType)"; triggers = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }); actions = @($t.Actions | ForEach-Object { @{ execute = "$($_.Execute)"; arguments = "$($_.Arguments)" } }) } }
$w = Get-CimInstance Win32_Service -Filter "Name='$name'"
if ($w) {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $exit = Get-Item "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$name\\Parameters\\AppExit" -ErrorAction SilentlyContinue
  $sddl = ((& sc.exe sdshow $name) -join '').Trim()
  $out.service = @{ status = "$($w.State)"; startType = "$($w.StartMode)"; account = "$($w.StartName)"; exit0 = $(if ($exit) { "$($exit.GetValue('0'))" } else { '' }); userAce = [bool](Test-BeeperServiceAce $sddl $me.User.Value); user = $me.Name }
}
ConvertTo-Json -Depth 5 -Compress -InputObject $out
`));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }   // EPERM = exists but not ours; ESRCH = gone
}

function mtimeMs(p) { try { return statSync(p).mtimeMs; } catch { return NaN; } }

function resolveClaude() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  let res;
  try { res = spawnSync(finder, ['claude'], { windowsHide: true }); }
  catch { return null; }
  if (!res || res.status !== 0) return null;
  return firstLine(Buffer.isBuffer(res.stdout) ? res.stdout.toString('utf8') : String(res.stdout)) || null;
}

// ── the check run ──────────────────────────────────────────────────────────

const ICON = { ok: '✅', warn: '⚠️', fail: '❌' };

export function runChecks({ egptHome, out = console.log } = {}) {
  const results = [];
  const add = (level, msg) => { results.push({ level, msg }); out(`${ICON[level]} ${msg}`); };
  const name = daemonTaskName(egptHome);

  out(`egpt install verify — task '${name}', profile '${egptHome}'`);
  out('');

  // (1) the runners: the Session 1 task and the Session 0 service.
  if (process.platform !== 'win32') {
    const pidFile = (key) => { try { return readFileSync(join(egptHome, 'state', `daemon-${key}.pid`), 'utf8'); } catch { return ''; } };
    const beatAgeMs = Date.now() - mtimeMs(join(egptHome, 'state', 'alive.txt'));
    for (const r of daemonChecks({ s0: pidFile('s0'), s1: pidFile('s1') }, beatAgeMs, pidAlive)) add(r.level, r.msg);
  } else if (!name) add('fail', `runner: cannot derive a task name from ${egptHome}`);
  else {
    let facts = null;
    try { facts = probeRunner(name); } catch (e) { add('warn', `runner: cannot read Task Scheduler / the SCM - ${e.message}`); }
    if (facts) {
      for (const r of [...taskChecks(facts.task, { name, egptHome }), ...serviceChecks(facts.service, name)]) add(r.level, r.msg);
    }
  }

  // (2) profile shape.
  const cfgPath = join(egptHome, 'config', 'config.yaml');
  if (!existsSync(cfgPath)) add('fail', `config: ${cfgPath} MISSING`);
  else {
    let cfg = null, perr = null;
    try { cfg = YAML.parse(readFileSync(cfgPath, 'utf8')); } catch (e) { perr = e; }
    if (perr) add('fail', `config: ${cfgPath} FAILED to parse — ${perr.message}`);
    else if (!cfg?.agents || typeof cfg.agents !== 'object' || Array.isArray(cfg.agents)) add('fail', 'config: no agents block (fatal boot)');
    else for (const r of agentsCheck(cfg)) add(...r);
  }
  for (const [label, p] of [
    ['config/conversations.yaml', join(egptHome, 'config', 'conversations.yaml')],
    ['config/agents/', join(egptHome, 'config', 'agents')],
    ['config/skeletons/room/', join(egptHome, 'config', 'skeletons', 'room')],
  ]) {
    if (existsSync(p)) add('ok', `profile: ${label} present`);
    else add('fail', `profile: ${label} MISSING (${p})`);
  }
  // stale old-layout residue.
  for (const { label, path } of staleResiduePaths(egptHome)) {
    if (existsSync(path)) add('warn', `stale residue: ${label} still present — old layout, should be gone`);
  }
  if (!staleResiduePaths(egptHome).some(({ path }) => existsSync(path))) add('ok', 'profile: no stale old-layout residue');

  // (3) liveness — spine.pid + alive.txt.
  const pidPath = join(egptHome, 'state', 'spine.pid');
  if (!existsSync(pidPath)) add('warn', `liveness: state/spine.pid MISSING (node never booted, or stopped)`);
  else {
    const pid = parseInt(String(readFileSync(pidPath, 'utf8')).trim(), 10);
    if (pidAlive(pid)) add('ok', `liveness: spine.pid ${pid} is alive`);
    else add('warn', `liveness: spine.pid ${pid} not running (stale pid — node stopped/crashed)`);
  }
  const alivePath = join(egptHome, 'state', 'alive.txt');
  if (!existsSync(alivePath)) add('fail', `liveness: state/alive.txt MISSING (loop never beat)`);
  else { const s = beatStatus(Date.now() - mtimeMs(alivePath)); add(s.level, `liveness: alive.txt beat ${s.note}`); }

  // (4) claude binary. The task runs with the operator's logon PATH.
  const claude = resolveClaude();
  if (claude) add('ok', `claude: ${claude}`);
  else add('warn', `claude: not resolvable on THIS shell's PATH (the task runs with the operator's logon PATH)`);

  const code = overallExit(results.map((r) => r.level));
  const n = (lvl) => results.filter((r) => r.level === lvl).length;
  out('');
  out(`${code === 0 ? ICON.ok : code === 1 ? ICON.fail : ICON.warn} verify-install: ${n('ok')} ok, ${n('warn')} warn, ${n('fail')} fail → exit ${code}`);
  return code;
}

function main() {
  const egptHome = process.argv[2] || process.env.EGPT_HOME || join(homedir(), '.egpt');
  process.exit(runChecks({ egptHome }));
}

// Run only when invoked directly (so the pure helpers import cleanly in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
