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

import { readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
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
export const COMPACT_RATIO  = 0.25;   // keep sessions THIN — compact at 25% of the window (An 2026-06-19)
// A session whose jsonl changed within this window is treated as a turn IN FLIGHT
// (or just-ran) and is NOT reaped — reaping a live turn guillotines it (the
// 2026-06-20 bug: the hourly scan killed Wren's 2.4-min answer, claude exited
// 4294967295). Generous on purpose: skipping a cycle is free (next beat retries
// once the session goes quiet). An 2026-06-20: "if there is a turn going on, skip".
export const BUSY_WINDOW_MS = 10 * 60 * 1000;

export function windowForModel(model) {
  const m = String(model || '').toLowerCase();
  for (const [k, v] of Object.entries(MODEL_WINDOWS)) if (m.includes(k)) return v;
  return DEFAULT_WINDOW;
}

// ── pure: the real context size (tokens) of the most recent turn, from Claude
//    Code's own usage accounting (input + cache_read + cache_creation = all that
//    counts against the window). CRUCIAL: if a compact boundary is NEWER than the
//    last usage record, the session was just compacted and hasn't run a real turn
//    since — its effective context is the small summary, not the stale pre-compact
//    usage. Return 0 then, so we never re-compact an already-compacted being. ──
export function latestContextTokens(jsonlText) {
  const lines = String(jsonlText ?? '').split('\n');
  let lastUsage = -1, lastUsageTokens = 0, lastBoundary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.isCompactSummary === true) lastBoundary = i;
    const u = o?.message?.usage;
    if (u) {
      const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (t > 0) { lastUsage = i; lastUsageTokens = t; }
    }
  }
  if (lastBoundary > lastUsage) return 0;   // compacted since the last measured turn → effectively small
  return lastUsageTokens;                    // 0 if no usage yet (fresh/empty session)
}

// ── pure: number of compact boundaries — its DELTA across a /compact is the
//    reliable success signal (the post-compact token size isn't measurable until
//    the being runs a real turn). ──
export function countBoundaries(jsonlText) {
  let n = 0;
  for (const l of String(jsonlText ?? '').split('\n')) if (l && l.includes('"isCompactSummary":true')) n++;
  return n;
}

// ── pure: decision gate. ──
export function needsCompaction(tokens, { window = DEFAULT_WINDOW, ratio = COMPACT_RATIO } = {}) {
  return tokens >= Math.round(window * ratio);
}

// ── pure: is a session "active" right now? Claude writes the session jsonl at
//    turn START (the user message) and during streaming, so a recent mtime ⇒ a
//    turn is in flight (or just ran). The compactor must NOT reap an active
//    session — that guillotines the live turn. ──
export function isActiveMtime(mtimeMs, now = Date.now(), windowMs = BUSY_WINDOW_MS) {
  return Number.isFinite(mtimeMs) && (now - mtimeMs) < windowMs;
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

// Is a turn in flight on this session (don't reap it)? Reads the jsonl mtime.
function sessionActive(file, windowMs = BUSY_WINDOW_MS) {
  try { return isActiveMtime(statSync(file).mtimeMs, Date.now(), windowMs); } catch { return false; }
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
export function compactBeingIfNeeded(being, { log = () => {}, ratio = COMPACT_RATIO, force = false, dryRun = false, busyWindowMs = BUSY_WINDOW_MS } = {}) {
  const window = being.window || windowForModel(being.model);
  const file = findSessionFile(being.sessionId);
  if (!file) return { ...being, status: 'no-session-file' };
  const before = latestContextTokens(readFileSync(file, 'utf8'));
  const over = force || needsCompaction(before, { window, ratio });
  if (!over) return { ...being, before, status: 'ok' };
  // BUSY-SKIP (An 2026-06-20): a turn in flight ⇒ skip this cycle, never reap it.
  // The scan is automatic + periodic, so skipping is free — it compacts once the
  // session goes quiet. A manual `force` (named target) is the operator's override.
  if (!force && sessionActive(file, busyWindowMs)) {
    log(`compact: ${being.name} active (jsonl touched <${Math.round(busyWindowMs / 60000)}m ago) — skip this cycle`);
    return { ...being, before, status: 'busy-skip' };
  }
  if (dryRun) return { ...being, before, status: 'would-compact' };
  log(`compact: ${being.name} at ${before} tok (threshold ${Math.round(window * ratio)}) — compacting…`);
  // Success = a NEW compact boundary appears (the post-compact token size isn't
  // measurable until the being next runs a real turn, so don't read it back).
  const boundariesBefore = countBoundaries(readFileSync(file, 'utf8'));
  reapResident(being.sessionId, log);
  runCompactTurn({ sessionId: being.sessionId, cwd: being.cwd, model: being.model, log });
  const compacted = countBoundaries(readFileSync(file, 'utf8')) > boundariesBefore;
  return { ...being, before, status: compacted ? 'compacted' : 'compact-failed' };
}

// ── pure: ACTIVE conversations are ccode threads too — each contact entry holds
//    its own persona session (threadId) + cwd (threadCwd). Same compaction, so
//    busy chats stay thin alongside the beings (An 2026-06-19: "not only the
//    being, the active conversations"). ──
export function compactableConversations(state, model = 'haiku') {
  const out = [];
  const contacts = state?.contacts ?? {};
  for (const surface of Object.keys(contacts)) {
    const bucket = contacts[surface] ?? {};
    for (const [jid, e] of Object.entries(bucket)) {
      if (!e || e.aliasOf || typeof e.threadId !== 'string' || !e.threadId) continue;   // no live thread → nothing to compact
      out.push({ name: `${surface}/${e.slug || jid}`, sessionId: e.threadId, cwd: e.threadCwd || process.cwd(), model, window: windowForModel(model) });
    }
  }
  return out;
}

// Compact the oversized sessions among a list of targets (beings and/or
// conversations). Returns one report per target.
export function scanAndCompact(targets, opts = {}) {
  return (Array.isArray(targets) ? targets : []).map(t => compactBeingIfNeeded(t, opts));
}

// One-line human summary of a report set (for the heartbeat log / butler reply).
export function summarize(reports) {
  const acted = reports.filter(r => r.status === 'compacted' || r.status === 'compact-failed');
  const busy = reports.filter(r => r.status === 'busy-skip').length;
  const busyNote = busy ? ` (${busy} busy-skipped)` : '';
  if (!acted.length) return 'compact: nothing over threshold' + busyNote;
  return 'compact: ' + acted.map(r =>
    r.status === 'compacted' ? `${r.name} compacted (was ${r.before} tok)` : `${r.name} FAILED`).join(', ') + busyNote;
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
  // Targets = local ccode beings + ACTIVE conversation threads (each chat carries
  // its own persona session, so busy chats stay thin too).
  const targets = [...compactableBeings(config)];
  try {
    const { readState, CONV_YAML_PATH } = await import('../../conversations-state.mjs');
    const state = await readState(CONV_YAML_PATH);
    targets.push(...compactableConversations(state, config.default_brain?.model || 'haiku'));
  } catch (e) { log(`compact: conversation scan skipped — ${e?.message ?? e}`); }
  let reports;
  if (target) {
    const t = targets.find(x => x.name === String(target).toLowerCase() || x.name.endsWith('/' + String(target).toLowerCase()));
    if (!t) { console.log(`compact: no compactable target "${target}"`); process.exit(1); }
    reports = [compactBeingIfNeeded(t, { log, force: !dryRun, dryRun })];   // named target → force (unless dry-run)
  } else {
    reports = scanAndCompact(targets, { log, force, dryRun });
  }
  for (const r of reports) {
    const tag = r.status === 'compacted' ? `compacted (was ${r.before} tok)`
      : r.status === 'would-compact' ? `WOULD compact (${r.before} tok)`
      : r.status === 'busy-skip' ? `busy — skipped (${r.before} tok)`
      : r.status === 'ok' ? `ok (${r.before} tok)` : r.status;
    log(`  ${r.name}: ${tag}`);
  }
  // Durable record of EVERY maintenance run — this is the actually-loggable bit:
  // the spine's sysLog goes to the dropped render buffer, so the butler heartbeat
  // is otherwise invisible. `cat ~/.egpt/logs/compact.log` shows every scan.
  try {
    const logDir = join(homedir(), '.egpt', 'logs');
    mkdirSync(logDir, { recursive: true });
    const detail = reports.map(r => `${r.name}=${r.status}${r.before != null ? `(${r.before})` : ''}`).join(' ') || 'no ccode beings';
    appendFileSync(join(logDir, 'compact.log'), `${new Date().toISOString()} ${dryRun ? '[dry] ' : ''}${summarize(reports)} | ${detail}\n`);
  } catch { /* logging is best-effort */ }
  console.log(dryRun ? `compact[dry-run]: ${reports.filter(r => r.status === 'would-compact').length} over threshold` : summarize(reports));
}
