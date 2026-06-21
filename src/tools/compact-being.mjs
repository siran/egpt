// tools/compact-being.mjs — deterministic compaction worker for ccode beings
// and active conversation threads.
//
// A `ccode` session (Claude Code CLI, resumed per turn via --resume <session_id>)
// accumulates context until a big incoming message overflows the model window
// ("Prompt is too long"). This worker keeps sessions thin from the OUTSIDE so the
// being never reaches that wall.
//
// COMPACTION = SUMMARIZE-AND-RESEED (NOT `/compact`). Verified 2026-06-21:
// `claude --resume <id> -p "/compact"` on claude 2.1.185 does NOT run the slash
// command — it feeds "/compact" to the model as literal text and writes no
// boundary. The old worker silently no-op'd for months (SPOILER grew to 4 MB /
// 179k tok / 0 boundaries while the hourly scan logged compact-failed). Instead:
//
//   distil the session's recent turns into a CONTINUITY BRIEF  →  seed a FRESH
//   small session with ONLY that brief  →  repoint the thread pointer to it
//
// The daemon's warm-pool session-identity guard (src/warm-sessions.mjs) drops the
// stale session and resumes the new one on the next turn. The old session jsonl
// is orphaned, not touched — no reaping, so a live daemon turn is never killed.
//
// The TRIGGER is deterministic: read Claude Code's OWN per-turn token accounting
// (input + cache_read + cache_creation = everything that was sent last turn) and
// reseed when it crosses a fraction of the model window. No byte-guessing.
//
// Driven by the maintenance command-heartbeat (egpt-spine.mjs heartbeat scan),
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

// ── pure: pull the human-readable user/assistant turns out of a session jsonl,
//    keeping only the TAIL within a char budget. This is the material we hand the
//    summarizer; bounding it means the summarizer call itself can't overflow. ──
export function extractConversationText(jsonlText, { maxChars = 200_000 } = {}) {
  const out = [];
  for (const line of String(jsonlText ?? '').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const role = o?.message?.role || (o.type === 'user' ? 'user' : o.type === 'assistant' ? 'assistant' : null);
    if (role !== 'user' && role !== 'assistant') continue;
    const content = o?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('');
    }
    text = String(text).trim();
    if (!text) continue;
    out.push(`${role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  let joined = out.join('\n\n');
  if (joined.length > maxChars) joined = joined.slice(joined.length - maxChars);   // keep the most RECENT
  return joined;
}

// ── pure: the two prompts. STEP 1 distils the conversation into a brief; STEP 2
//    seeds a FRESH session with ONLY that brief (so the new session is small —
//    feeding the whole conversation into one -p call would leave it inside the
//    new session and defeat the compaction). ──
export function buildReseedPrompt(text) {
  return [
    'You are distilling a conversation that has grown too large for its context window.',
    'Write a CONTINUITY BRIEF that carries everything needed to continue with no loss of important context: participants, durable facts, decisions, commitments, open questions, and the current topic/state. Be thorough but compact. Output ONLY the brief — no preamble, no questions.',
    '',
    '=== CONVERSATION ===',
    text || '(no recoverable history)',
  ].join('\n');
}
export function buildSeedPrompt(brief) {
  return [
    'This session continues an ongoing conversation. The following continuity brief carries everything important so far — treat it as established context. Reply with a single short acknowledgement; we continue from here.',
    '',
    '=== CONTINUITY BRIEF ===',
    brief,
  ].join('\n');
}

// ── side-effecting default summarizer: one throwaway claude call to produce the
//    brief, then a SECOND fresh call seeded with only the brief — the keeper. We
//    return the keeper's session_id (small) + the brief. `/compact` is NOT used:
//    verified 2026-06-21 that `claude --resume -p "/compact"` on 2.1.185 treats
//    the slash command as literal text (no boundary written) — the whole reason
//    the old compactor silently no-op'd for months. ──
function defaultSummarize(text, { model, cwd, log = () => {} } = {}) {
  const runJson = (promptStr) => {
    const args = ['--model', model, '--dangerously-skip-permissions', '--output-format', 'json', '-p'];
    const r = spawnSync('claude', args, { cwd, input: promptStr, encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 });
    if (r.error) { log(`!! reseed: claude spawn failed — ${r.error.message}`); return null; }
    let o; try { o = JSON.parse(r.stdout); } catch { log(`!! reseed: non-JSON output — ${String(r.stdout).slice(0, 160)}`); return null; }
    return o;
  };
  const sum = runJson(buildReseedPrompt(text));
  const brief = sum && typeof sum.result === 'string' ? sum.result.trim() : '';
  if (!brief) { log('reseed: summarizer produced an empty brief'); return null; }
  const seed = runJson(buildSeedPrompt(brief));
  const sessionId = seed?.session_id ?? null;
  if (!sessionId) { log('reseed: seed session produced no session_id'); return null; }
  return { sessionId, brief };
}

// Reseed ONE session: read its jsonl, distil a brief, seed a fresh small session,
// and report the new session id. Does NOT persist the pointer (the async CLI main
// does that) and does NOT touch the old session (the daemon's warm-pool
// session-identity guard drops it on the next turn once the pointer moves). The
// summarizer + persistence are injectable for testing.
export function reseedSession(being, { log = () => {}, summarize = defaultSummarize, resolveFile = findSessionFile } = {}) {
  const file = resolveFile(being.sessionId);
  if (!file) return { ...being, status: 'no-session-file' };
  let text;
  try { text = extractConversationText(readFileSync(file, 'utf8')); }
  catch (e) { log(`!! reseed: read ${being.name} failed — ${e?.message ?? e}`); return { ...being, status: 'reseed-failed' }; }
  const res = summarize(text, { model: being.model, cwd: being.cwd, log });
  if (!res?.sessionId) return { ...being, status: 'reseed-failed' };
  if (res.sessionId === being.sessionId) { log(`reseed: ${being.name} got the same session id — abort`); return { ...being, status: 'reseed-failed' }; }
  log(`reseed: ${being.name} → ${String(res.sessionId).slice(0, 8)}… (brief ${String(res.brief || '').length}ch)`);
  return { ...being, newSessionId: res.sessionId, status: 'reseeded' };
}

// Compact ONE being iff it's over threshold (or force). Returns a report row.
// dryRun reports the decision (ok / would-compact) without touching anything —
// for safe inspection. A success carries `newSessionId` for the caller to persist
// (status stays 'compacted'/'compact-failed' so the reporting layer is unchanged).
export function compactBeingIfNeeded(being, { log = () => {}, ratio = COMPACT_RATIO, force = false, dryRun = false, busyWindowMs = BUSY_WINDOW_MS, summarize, resolveFile = findSessionFile } = {}) {
  const window = being.window || windowForModel(being.model);
  const file = resolveFile(being.sessionId);
  if (!file) return { ...being, status: 'no-session-file' };
  const before = latestContextTokens(readFileSync(file, 'utf8'));
  const over = force || needsCompaction(before, { window, ratio });
  if (!over) return { ...being, before, status: 'ok' };
  // BUSY-SKIP (An 2026-06-20): a turn in flight ⇒ skip this cycle. Reseeding a
  // session the daemon is actively writing risks the daemon re-persisting the old
  // pointer over ours. The scan is periodic, so skipping is free — it reseeds once
  // the session goes quiet. A manual `force` (named target) is the operator's override.
  if (!force && sessionActive(file, busyWindowMs)) {
    log(`compact: ${being.name} active (jsonl touched <${Math.round(busyWindowMs / 60000)}m ago) — skip this cycle`);
    return { ...being, before, status: 'busy-skip' };
  }
  if (dryRun) return { ...being, before, status: 'would-compact' };
  log(`compact: ${being.name} at ${before} tok (threshold ${Math.round(window * ratio)}) — reseeding…`);
  const r = reseedSession(being, { log, resolveFile, ...(summarize ? { summarize } : {}) });
  return { ...being, before, newSessionId: r.newSessionId, status: r.status === 'reseeded' ? 'compacted' : 'compact-failed' };
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
      const slug = e.slug || jid;
      // cwd left null when there's no threadCwd — the CLI runner fills it with the
      // slug-dir (the SAME cwd the daemon resumes with) so the reseeded session
      // lands in the right claude project and `--resume` finds it. surface+slug
      // ride along so the runner can persist the new pointer + threadCwd.
      out.push({ name: `${surface}/${slug}`, surface, slug, sessionId: e.threadId, cwd: e.threadCwd || null, model, window: windowForModel(model) });
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
  const { readConfigSync, writeConfig } = await import('./config-io.mjs');
  const config = readConfigSync();
  const log = (m) => console.error(m);   // diagnostics to stderr; the summary to stdout
  let convState = null;   // imported conversations-state module (null if unavailable)
  // Targets = local ccode beings + ACTIVE conversation threads (each chat carries
  // its own persona session, so busy chats stay thin too).
  const targets = [...compactableBeings(config)];
  try {
    convState = await import('../../conversations-state.mjs');
    const state = await convState.readState(convState.CONV_YAML_PATH);
    const convTargets = compactableConversations(state, config.default_brain?.model || 'haiku');
    // Fill the reseed cwd with the slug-dir (the cwd the daemon resumes with) so
    // the new session lands in the matching claude project and `--resume` finds it.
    for (const t of convTargets) { if (!t.cwd) t.cwd = convState.slugDir(t.surface, t.slug); }
    targets.push(...convTargets);
  } catch (e) { log(`compact: conversation scan skipped — ${e?.message ?? e}`); }
  let reports;
  if (target) {
    const _t = String(target).toLowerCase();
    const t = targets.find(x => x.name.toLowerCase() === _t || x.name.toLowerCase().endsWith('/' + _t));
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
  // Persist the new session pointers (reseed succeeded). Done HERE, async, after
  // the sync scan: a conversation repoints its threadId+threadCwd in
  // conversations.yaml; a being repoints siblings.<name>.session_id in config.
  // The daemon's warm-pool session-identity guard drops the stale session and
  // resumes the new (small) one on the contact's next turn. Re-read each file
  // immediately before writing to minimize clobbering a concurrent daemon write.
  for (const r of reports) {
    if (r.status !== 'compacted' || !r.newSessionId) continue;
    try {
      if (r.surface && r.slug && convState) {
        const now = new Date().toISOString();
        const fresh = await convState.readState(convState.CONV_YAML_PATH);
        const next = convState.patchContact(fresh, r.surface, r.slug, {
          threadId: r.newSessionId, threadCwd: r.cwd ?? null, threadCreatedAt: now, identityInjectedAt: now,
        });
        await convState.writeState(convState.CONV_YAML_PATH, next);
        log(`compact: repointed ${r.name} → ${String(r.newSessionId).slice(0, 8)}…`);
      } else if (!r.surface) {
        const fresh = readConfigSync();
        if (fresh.siblings?.[r.name]) {
          fresh.siblings[r.name].session_id = r.newSessionId;
          await writeConfig(fresh);
          log(`compact: repointed being ${r.name} → ${String(r.newSessionId).slice(0, 8)}…`);
        }
      }
    } catch (e) { log(`!! compact: repoint ${r.name} failed — ${e?.message ?? e}`); }
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
