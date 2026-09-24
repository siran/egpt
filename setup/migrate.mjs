#!/usr/bin/env node
// setup/migrate.mjs — bring THIS node's structure forward: run migrations/NNNN-*.mjs in order.
//
// WHY (operator, 2026-09-16: "nothing should be hand-applied, everything structural"). kg and do
// drifted apart because every structural change was hand-applied to one node and forgotten on
// the other - six such drifts surfaced in two days. A migration is written ONCE, in the repo,
// and each node brings itself forward.
//
//   node setup/migrate.mjs                      # run what is pending on ~/.egpt (or EGPT_HOME)
//   node setup/migrate.mjs --dry-run            # print what each pending migration would change; change nothing
//   node setup/migrate.mjs --egpt-home <dir>
//
// Exit: 0 = nothing left pending; 1 = a migration FAILED or refused (the chain stopped there);
//       2 = what is left is PENDING ELEVATION (or BLOCKED behind such a migration).
//       A dry run exits 0 unless a plan refuses.
//
// THE RULES, each one decided with the operator:
//   - Migrations live in migrations/, one file per migration, NNNN-<slug>.mjs, and are never
//     moved or renamed after they ship.
//   - WHICH migrations a node has applied is NODE state, never git: the ledger is
//     <EGPT_HOME>/state/migrations-applied.json. Moving applied files around in the repo was
//     rejected - it dirties the checkout upgrade.ps1 pulls, and two nodes would each want to
//     move the same file somewhere different.
//   - It runs at DEPLOY (setup/upgrade.ps1), never at boot: boot is what the watchdog retries in
//     a loop, so a broken migration there becomes a crash loop.
//   - Every migration is idempotent. Its plan() looks at the node first and reports "already
//     satisfied" rather than acting, so a lost ledger is survivable - and after apply() the
//     runner asks plan() again and records nothing unless the node now IS satisfied.
//   - A failure or refusal stops the chain, and is never recorded.
//   - A migration DECLARES whether it needs elevation. Unelevated, a pending elevated migration
//     is reported loudly as PENDING with the exact command to run, is not recorded, and does
//     not block the migrations after it - unless one of them lists it in `after`.
//
// THE LEDGER is one JSON file, not one marker per migration: a single `cat` shows the node's
// whole history in order, and the kg and do ledgers diff against each other directly, which is
// the drift question this exists to answer. It is rewritten temp -> rename, and re-read just
// before each write, so a concurrent run can at worst drop one entry - which costs a re-check,
// not a wrong answer, because every migration is idempotent. A ledger that does not parse is
// refused, never overwritten.
//
// A MIGRATION MODULE exports:
//   elevated: boolean                  - required; does apply() need administrator rights?
//   summary:  string                   - one line
//   after?:   string[]                 - ids that must be recorded before this one may act
//   plan(ctx) -> { satisfied: true, notes?: string[] }
//              | { satisfied: false, changes: string[], apply: async () => void }
//     plan() is READ-ONLY. It throws to refuse, and the message must name what it refused.
//
// Everything is printed to STDOUT: upgrade.ps1 runs this under PowerShell 5.1, where a captured
// native stderr line can become a terminating error.
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(HERE);
export const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const FILE_RE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.mjs$/;

export const ledgerPath = (egptHome) => join(egptHome, 'state', 'migrations-applied.json');

export function readLedger(egptHome) {
  const file = ledgerPath(egptHome);
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(`the ledger ${file} does not parse (${e.message}) - refusing to guess what this node has applied. Every migration is idempotent: move the file aside and re-run.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`the ledger ${file} is not a JSON object - refusing to overwrite it`);
  return data;
}

function recordInLedger(egptHome, id, entry) {
  const file = ledgerPath(egptHome);
  mkdirSync(dirname(file), { recursive: true });
  const data = { ...readLedger(egptHome), [id]: entry };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function listMigrations(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const bad = files.filter((f) => !FILE_RE.test(f));
  if (bad.length) throw new Error(`not a migration file name (NNNN-<slug>.mjs): ${bad.join(', ')}`);
  const seen = new Map();
  for (const f of files) {
    const n = f.slice(0, 4);
    if (seen.has(n)) throw new Error(`two migrations share the number ${n}: ${seen.get(n)} and ${f}`);
    seen.set(n, f);
  }
  return files.map((f) => ({ id: f.slice(0, -4), file: join(dir, f) }));
}

// ── the Windows seams. Kept here so every migration shares one way of talking to PowerShell ──

// Run a PowerShell SCRIPT TEXT. Written to a temp .ps1 (UTF-8 WITH BOM - PowerShell 5.1 reads a
// BOM-less script as ANSI) and run with -File, which gives a real exit code and plain-text
// errors; -EncodedCommand would print errors as CLIXML. Returns stdout; throws on a nonzero exit.
export function runPowerShell(script) {
  const file = join(tmpdir(), `egpt-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  const body = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" +
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false\n' + script;
  writeFileSync(file, `\uFEFF${body}`, 'utf8');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`PowerShell exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
    return r.stdout;
  } finally {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

// Run a repo script (setup\*.ps1) with the console INHERITED, so the operator sees its own lines.
export function runPowerShellFile(file, args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { stdio: 'inherit', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${basename(file)} exited ${r.status}`);
}

export function isElevated(platform = process.platform) {
  if (platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  const out = runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
  return out.trim() === 'True';
}

// Local time, the shape the operator's hand-made backups already use: config.yaml.bak-cooling-20260914T181826
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// The exact way to re-run this chain elevated, for a PENDING report.
function elevatedCommand(egptHome) {
  const runner = join(HERE, 'migrate.mjs');
  const cmd = join(HERE, 'migrate.cmd');
  return [
    `from an ADMINISTRATOR shell:  "${process.execPath}" "${runner}" --egpt-home "${egptHome}"`,
    `or from this one:             Start-Process -Verb RunAs "${cmd}" -ArgumentList '--egpt-home "${egptHome}"'`,
  ];
}

export async function runMigrations({
  dir = MIGRATIONS_DIR,
  egptHome,
  repo = REPO_ROOT,
  dryRun = false,
  elevated,
  platform = process.platform,
  log = (line) => console.log(line),
  now = () => new Date(),
  ctx: ctxOverrides = {},
  // Stop the chain after this migration number ('0025'): a migration's own runner test runs the
  // chain AS IT STOOD WHEN THAT MIGRATION SHIPPED, so a later one acting on the same fixture (0027
  // resting kg's relays in 0025's kg fixture) cannot invalidate it. Never set in production.
  through = null,
} = {}) {
  if (!egptHome) throw new Error('runMigrations: egptHome is required');
  const results = [];
  const say = (line = '') => log(line);
  let exitCode = 0;

  say(`migrations: ${dir}`);
  say(`  profile  ${egptHome}`);
  say(`  ledger   ${ledgerPath(egptHome)}`);
  say(`  mode     ${dryRun ? 'DRY RUN - nothing is changed and nothing is recorded' : 'apply'}${elevated ? ' (elevated)' : ' (not elevated)'}`);

  let ledger;
  let migrations;
  try {
    ledger = readLedger(egptHome);
    migrations = listMigrations(dir);
    if (through) migrations = migrations.filter(({ id }) => id.slice(0, 4) <= String(through).slice(0, 4));
  } catch (e) {
    say(`FAILED before any migration ran: ${e.message}`);
    return { results, exitCode: 1 };
  }

  const recordedNow = new Set();
  for (const { id, file } of migrations) {
    if (ledger[id]) {
      say(`  ${id}  done (${ledger[id].outcome}, ${ledger[id].at})`);
      results.push({ id, outcome: 'in-ledger' });
      continue;
    }

    const fail = (why) => {
      say('');
      say(`  ${id}  FAILED - the chain stops here, nothing after it runs, and it is not recorded`);
      for (const ln of String(why).split('\n')) say(`      ${ln}`);
      results.push({ id, outcome: 'failed', error: String(why) });
      exitCode = 1;
    };

    let mod;
    try { mod = await import(pathToFileURL(file).href); } catch (e) { fail(`cannot load ${file}: ${e.message}`); break; }
    if (typeof mod.elevated !== 'boolean' || typeof mod.plan !== 'function') {
      fail(`${basename(file)} must export \`elevated\` (boolean) and \`plan\` (function)`);
      break;
    }

    const missing = (mod.after ?? []).filter((dep) => !ledger[dep] && !recordedNow.has(dep));
    if (missing.length) {
      say(`  ${id}  BLOCKED - waits for ${missing.join(', ')}; not recorded`);
      results.push({ id, outcome: 'blocked', waitingFor: missing });
      if (exitCode === 0) exitCode = 2;
      continue;
    }

    const ctx = {
      id, egptHome, repo, platform, elevated, dryRun,
      log: (line) => say(`      ${line}`),
      exists: existsSync,
      ps: runPowerShell,
      psFile: runPowerShellFile,
      backup: (path) => {
        const to = `${path}.bak-${id.slice(0, 4)}-${stamp(now())}`;
        copyFileSync(path, to);
        return to;
      },
      ...ctxOverrides,
    };

    let plan;
    try { plan = await mod.plan(ctx); } catch (e) { fail(e.message); break; }

    if (plan?.satisfied === true) {
      if (dryRun) {
        say(`  ${id}  already satisfied - would be recorded`);
        results.push({ id, outcome: 'would-record' });
      } else {
        recordInLedger(egptHome, id, { outcome: 'already-satisfied', at: now().toISOString() });
        recordedNow.add(id);
        say(`  ${id}  already satisfied - recorded, nothing changed`);
        results.push({ id, outcome: 'satisfied' });
      }
      for (const n of plan.notes ?? []) say(`      ${n}`);
      continue;
    }
    if (plan?.satisfied !== false || !Array.isArray(plan.changes) || !plan.changes.length || typeof plan.apply !== 'function') {
      fail(`${basename(file)}: plan() must return { satisfied: true } or { satisfied: false, changes: [..], apply }`);
      break;
    }

    say('');
    say(`  ${id}  PENDING - ${mod.summary ?? ''}${mod.elevated ? '  [needs elevation]' : ''}`);
    for (const c of plan.changes) say(`      ${c}`);

    if (dryRun) {
      say(`      (dry run: not applied)`);
      results.push({ id, outcome: 'would-apply', changes: plan.changes });
      continue;
    }

    if (mod.elevated && !elevated) {
      say('');
      say(`  ******************************************************************************`);
      say(`  ${id} NEEDS ELEVATION and was NOT applied. It is not recorded; the node is not`);
      say(`  converged until it runs. The migrations after it still run.`);
      for (const ln of elevatedCommand(egptHome)) say(`    ${ln}`);
      say(`  ******************************************************************************`);
      results.push({ id, outcome: 'pending-elevation', changes: plan.changes });
      if (exitCode === 0) exitCode = 2;
      continue;
    }

    try {
      await plan.apply();
      const after = await mod.plan(ctx);
      if (after?.satisfied !== true) throw new Error('apply() finished but plan() still reports changes pending - not recording it');
    } catch (e) { fail(e.message); break; }

    recordInLedger(egptHome, id, { outcome: 'applied', at: now().toISOString() });
    recordedNow.add(id);
    say(`  ${id}  APPLIED - recorded`);
    results.push({ id, outcome: 'applied', changes: plan.changes });
  }

  say('');
  if (exitCode === 1) say('migrations: FAILED - see above. Nothing after the failure ran.');
  else if (exitCode === 2) say('migrations: NOT CONVERGED - a migration is PENDING ELEVATION (or BLOCKED behind one), see above.');
  else say(`migrations: ${dryRun ? 'dry run complete' : 'node is current'}`);
  return { results, exitCode };
}

function parseArgs(argv) {
  const out = { dryRun: false, egptHome: process.env.EGPT_HOME || join(homedir(), '.egpt') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-WhatIf' || a === '--whatif') out.dryRun = true;
    else if (a === '--egpt-home') out.egptHome = argv[++i];
    else throw new Error(`unknown argument: ${a}  (usage: migrate.mjs [--dry-run] [--egpt-home <dir>])`);
  }
  if (!out.egptHome) throw new Error('--egpt-home needs a directory');
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.log(e.message); process.exit(1); }
  let elevated;
  try { elevated = isElevated(); } catch (e) { console.log(`cannot tell whether this process is elevated: ${e.message}`); process.exit(1); }
  try {
    const { exitCode } = await runMigrations({ ...args, elevated });
    process.exit(exitCode);
  } catch (e) {
    // e.g. the ledger could not be written after a migration acted. Loud, and never exit 0.
    console.log(`migrations: FAILED - ${e.stack ?? e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
