// tools/compact-being.mjs — deterministic compaction worker for ccode beings.
//
// A `ccode` being (Claude Code CLI, resumed per turn via --resume <session_id>)
// accumulates context until a big incoming message overflows the model window
// ("Prompt is too long" — the session itself still resumes; it's session + the
// new message that overflows). This worker compacts a being's session from the
// OUTSIDE — the only safe way, since a session can't self-compact while its
// resident holds it (single-active):
//
//   reap the resident  →  `claude --resume <id> -p "/compact"`  →  being re-resumes compacted
//
// The TRIGGER is deterministic: read Claude Code's OWN per-turn token accounting
// (input + cache_read + cache_creation = everything that was sent last turn) and
// compact when it crosses a fraction of the model window. No byte-guessing.
//
// Driven by the butler-e maintenance heartbeat (egpt-spine.mjs heartbeat scan),
// so it runs automatically, periodically, and logged — never by hand. Also a
// CLI: `node src/tools/compact-being.mjs [--scan|<being>] [--force]`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Context window is PER-MODEL: haiku is 200k, the large-context 4.x models
// (sonnet/opus) are ~1M. Getting this right matters — Don (haiku) overflowed at
// ~200k while Wren (opus) runs fine at 769k. Match by substring; a being may
// override with `context_window` in its sibling config. 0.65 leaves generous
// headroom for the next incoming message (the thing that actually overflowed Don
// on 2026-06-19) plus the system prompt + tools.
export const MODEL_WINDOWS = { haiku: 200_000, sonnet: 1_000_000, opus: 1_000_000 };
export const DEFAULT_WINDOW = 200_000;
export const COMPACT_RATIO  = 0.65;

export function windowForModel(model) {
  const m = String(model || '').toLowerCase();
  for (const [k, v] of Object.entries(MODEL_WINDOWS)) if (m.includes(k)) return v;
  return DEFAULT_WINDOW;
}

// ── pure: the real context size (tokens) of the most recent turn, from Claude
//    Code's own usage accounting. Scans up for the last record carrying a
//    message.usage and sums everything that counts against the window. ──
export function latestContextTokens(jsonlText) {
  const lines = String(jsonlText ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const u = o?.message?.usage;
    if (u) {
      const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (t > 0) return t;
    }
  }
  return 0;   // no usage yet (fresh/empty session) → nothing to compact
}

// ── pure: decision gate. ──
export function needsCompaction(tokens, { window = DEFAULT_WINDOW, ratio = COMPACT_RATIO } = {}) {
  return tokens >= Math.round(window * ratio);
}

// ── pure: the LOCAL ccode siblings with a resumable session (the only kind
//    /compact applies to — sdk/codex/llama manage context differently). ──
export function compactableBeings(config) {
  const sib = config?.siblings ?? {};
  return Object.entries(sib)
    .filter(([name, s]) => name !== '_note' && s && typeof s === 'object'
      && (s.type === 'ccode' || s.type === 'claude-code')
      && typeof s.session_id === 'string' && s.session_id
      && s.enabled !== false)
    .map(([name, s]) => {
      const model = s.model || 'haiku';
      return { name, sessionId: s.session_id, cwd: s.cwd || process.cwd(), model, window: s.context_window || windowForModel(model) };
    });
}

// ── side-effecting helpers (Windows-first; POSIX fallbacks). ──
function findSessionFile(sessionId) {
  const proj = join(homedir(), '.claude', 'projects');
  let dirs; try { dirs = readdirSync(proj); } catch { return null; }
  for (const d of dirs) {
    const f = join(proj, d, `${sessionId}.jsonl`);
    try { if (statSync(f).isFile()) return f; } catch { /* not here */ }
  }
  return null;
}

// Kill any claude process currently holding the session (single-active guard):
// a second `claude --resume <id>` racing this one would corrupt the .jsonl.
function reapResident(sessionId, log) {
  if (process.platform === 'win32') {
    const ps = `Get-CimInstance Win32_Process -Filter "name='claude.exe'" | Where-Object { $_.CommandLine -like '*--resume ${sessionId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    const killed = (r.stdout || '').trim().split(/\s+/).filter(Boolean);
    if (killed.length) log(`compact: reaped resident pid(s) ${killed.join(',')} holding ${sessionId}`);
    return killed.length;
  }
  const r = spawnSync('pkill', ['-f', `--resume ${sessionId}`]);
  return r.status === 0 ? 1 : 0;
}

// Run the compaction turn. `/compact` works in -p print mode (claude 2.1.x); it
// appends an isCompactSummary boundary that resume reads from. stdin is closed
// (input:'') so claude doesn't wait on it.
function runCompactTurn({ sessionId, cwd, model, log }) {
  const args = ['--resume', sessionId, '--model', model, '--dangerously-skip-permissions', '-p', '/compact'];
  const r = spawnSync('claude', args, { cwd, input: '', encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000 });
  if (r.error) { log(`!! compact: claude spawn failed for ${sessionId} — ${r.error.message}`); return false; }
  if (r.status !== 0) log(`compact: claude exit ${r.status} for ${sessionId} (may still have compacted)`);
  return !r.error;
}

// Compact ONE being iff it's over threshold (or force). Returns a report row.
// dryRun reports the decision (ok / would-compact) without touching anything —
// for safe inspection.
export function compactBeingIfNeeded(being, { log = () => {}, ratio = COMPACT_RATIO, force = false, dryRun = false } = {}) {
  const window = being.window || windowForModel(being.model);
  const file = findSessionFile(being.sessionId);
  if (!file) return { ...being, status: 'no-session-file' };
  const before = latestContextTokens(readFileSync(file, 'utf8'));
  const over = force || needsCompaction(before, { window, ratio });
  if (!over) return { ...being, before, status: 'ok' };
  if (dryRun) return { ...being, before, status: 'would-compact' };
  log(`compact: ${being.name} at ${before} tok (threshold ${Math.round(window * ratio)}) — compacting…`);
  reapResident(being.sessionId, log);
  const ran = runCompactTurn({ sessionId: being.sessionId, cwd: being.cwd, model: being.model, log });
  const after = latestContextTokens(readFileSync(file, 'utf8'));
  return { ...being, before, after, status: ran ? 'compacted' : 'compact-failed' };
}

// Scan every local ccode being and compact the oversized ones. Returns reports.
export function scanAndCompact(config, opts = {}) {
  return compactableBeings(config).map(b => compactBeingIfNeeded(b, opts));
}

// One-line human summary of a report set (for the heartbeat log / butler reply).
export function summarize(reports) {
  const acted = reports.filter(r => r.status === 'compacted' || r.status === 'compact-failed');
  if (!acted.length) return 'compact: nothing over threshold';
  return 'compact: ' + acted.map(r =>
    r.status === 'compacted' ? `${r.name} ${r.before}→${r.after} tok` : `${r.name} FAILED`).join(', ');
}

// ── CLI ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run') || argv.includes('--check');
  const target = argv.find(a => !a.startsWith('--'));   // a being name → force-compact just it
  const { readConfigSync } = await import('./config-io.mjs');
  const config = readConfigSync();
  const log = (m) => console.error(m);   // diagnostics to stderr; the summary to stdout
  let reports;
  if (target) {
    const b = compactableBeings(config).find(x => x.name === String(target).toLowerCase());
    if (!b) { console.log(`compact: no compactable ccode being "${target}"`); process.exit(1); }
    reports = [compactBeingIfNeeded(b, { log, force: !dryRun, dryRun })];   // named target → force (unless dry-run)
  } else {
    reports = scanAndCompact(config, { log, force, dryRun });
  }
  for (const r of reports) {
    const tag = r.status === 'compacted' ? `compacted ${r.before}→${r.after} tok`
      : r.status === 'would-compact' ? `WOULD compact (${r.before} tok)`
      : r.status === 'ok' ? `ok (${r.before} tok)` : r.status;
    log(`  ${r.name}: ${tag}`);
  }
  console.log(dryRun ? `compact[dry-run]: ${reports.filter(r => r.status === 'would-compact').length} over threshold` : summarize(reports));
}
