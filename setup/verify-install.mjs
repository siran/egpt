#!/usr/bin/env node
// verify-install.mjs — GUARD 2: check the LIVE machine's egpt node install for the
// drift a vitest can never see. Read-only: it PROBES, it never fixes.
//
// The failure this catches: on 2026-07-03 the profile relayout moved logs to
// config/logs, but the Windows service's NSSM AppStdout/AppStderr still pointed at the
// DELETED old logs dir — so the service died with "The system cannot open the file" 80
// times before a single line of our code ran. No vitest sees the service config; this
// script does. It also checks the profile is in the canonical shape (no stale
// old-layout residue), the spine pid/alive-beat look live, and `claude` resolves.
//
// Usage:  node setup/verify-install.mjs [serviceName] [egptHome]
//   serviceName defaults to egpt-daemon; egptHome is taken from the service's own
//   NSSM AppEnvironmentExtra when readable (the source of truth for which profile the
//   service uses), else the arg / $EGPT_HOME / ~/.egpt2.
//
// Dependency-light: node builtins + the repo's `yaml`.
import { spawnSync } from 'node:child_process';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as YAML from 'yaml';

// ── pure helpers (unit-tested; no live probes) ─────────────────────────────

// nssm prints UTF-16LE with a BOM + trailing NULs. Strip the NUL/BOM/CR noise and
// return the FIRST non-empty line (the value; stderr noise like LsaOpenPolicy is on
// the other stream). Accepts an already-decoded string.
export function firstLine(raw) {
  const clean = String(raw ?? '').replace(/[\u0000\uFEFF\r]/g, '');
  for (const line of clean.split('\n')) { const t = line.trim(); if (t) return t; }
  return '';
}

// Extract EGPT_HOME=... from an NSSM AppEnvironmentExtra blob (one KEY=VALUE per line).
export function egptHomeFromEnvExtra(raw) {
  const clean = String(raw ?? '').replace(/[\u0000\uFEFF\r]/g, '');
  for (const line of clean.split('\n')) {
    const m = line.match(/^\s*EGPT_HOME\s*=\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
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

// nssm get <service> <key> — tolerant: nssm missing / non-zero exit → null.
function nssmGet(service, key) {
  let res;
  try { res = spawnSync('nssm', ['get', service, key], { windowsHide: true }); }
  catch { return null; }
  if (!res || res.error) return null;
  const buf = res.stdout;
  if (!buf || !buf.length) return null;
  // Decode UTF-16LE when NUL bytes are present (nssm's default), else UTF-8.
  const hasNul = Buffer.isBuffer(buf) && buf.includes(0);
  const text = Buffer.isBuffer(buf) ? buf.toString(hasNul ? 'utf16le' : 'utf8') : String(buf);
  const line = firstLine(text);
  return line || null;
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

export function runChecks({ service, egptHome, out = console.log } = {}) {
  const results = [];
  const add = (level, msg) => { results.push({ level, msg }); out(`${ICON[level]} ${msg}`); };

  out(`egpt install verify — service '${service}', profile '${egptHome}'`);
  out('');

  // (1) NSSM service log config — the drift that killed the service 80×.
  const nssmProbe = nssmGet(service, 'AppStdout');   // one probe tells us if nssm+service are reachable
  if (nssmProbe === null) {
    add('warn', `NSSM: 'nssm get ${service} …' unreadable (nssm missing / service absent / not elevated) — cannot verify service log config`);
  } else {
    const logsDir = expectedLogsDir(egptHome);
    for (const key of ['AppStdout', 'AppStderr']) {
      const val = key === 'AppStdout' ? nssmProbe : nssmGet(service, key);
      if (!val) { add('fail', `NSSM ${key}: empty/unreadable`); continue; }
      const under = isUnderDir(val, logsDir);
      const parentOk = existsSync(join(val, '..'));
      if (under && parentOk) add('ok', `NSSM ${key} → ${val} (under config/logs, dir exists)`);
      else if (under && !parentOk) add('fail', `NSSM ${key} → ${val} — parent dir MISSING (service will die "cannot open the file")`);
      else add('fail', `NSSM ${key} → ${val} — NOT under ${logsDir} (log-dir drift)`);
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
    else {
      const hasPersona = Object.entries(cfg.agents).some(([name, a]) =>
        a && typeof a === 'object' && !Array.isArray(a) &&
        [name, ...(Array.isArray(a.handles) ? a.handles : [])].map((h) => String(h).toLowerCase()).some((h) => h === 'e' || h === 'egpt'));
      if (hasPersona) add('ok', 'config: parses, agents block has a persona entry');
      else add('fail', 'config: agents block has NO persona entry (name/handles incl. e/egpt) — fatal boot');
    }
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

  // (4) claude binary — note the SERVICE-env caveat regardless.
  const claude = resolveClaude();
  if (claude) add('ok', `claude: ${claude} (NOTE: the service runs under its own env — confirm this dir is on the SERVICE account's PATH, not just this shell's)`);
  else add('warn', `claude: not resolvable on THIS shell's PATH (the service needs it on ITS PATH — verify the service account)`);

  const code = overallExit(results.map((r) => r.level));
  const n = (lvl) => results.filter((r) => r.level === lvl).length;
  out('');
  out(`${code === 0 ? ICON.ok : code === 1 ? ICON.fail : ICON.warn} verify-install: ${n('ok')} ok, ${n('warn')} warn, ${n('fail')} fail → exit ${code}`);
  return code;
}

function resolveEgptHome(service, argHome) {
  const fromNssm = egptHomeFromEnvExtra(nssmGet(service, 'AppEnvironmentExtra'));
  return fromNssm || argHome || process.env.EGPT_HOME || join(homedir(), '.egpt2');
}

function main() {
  const service = process.argv[2] || 'egpt-daemon';
  const egptHome = resolveEgptHome(service, process.argv[3]);
  process.exit(runChecks({ service, egptHome }));
}

// Run only when invoked directly (so the pure helpers import cleanly in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
