// tools/compact-being.mjs — the deterministic compaction TRIGGER for ccode
// beings and active conversation threads. The ACTION lives in the spine.
//
// A `ccode` session (Claude Code CLI, resumed per turn) accumulates context until
// a big incoming message overflows the model window ("Prompt is too long"). To
// keep sessions thin we run Anthropic's NATIVE `/compact` — NOT a custom
// summarizer.
//
// HOW /compact is invoked (verified 2026-06-21 on claude 2.1.185):
//   - `claude --resume <id> -p "/compact"`  → DEAD: the prompt-arg form treats
//     "/compact" as literal text and writes no boundary (the old compactor's
//     months-long silent no-op — SPOILER grew to 4 MB / 0 boundaries).
//   - `/compact` sent as a stream-json USER MESSAGE → WORKS: the real command
//     runs and writes an isCompactSummary boundary, compacting IN PLACE (same
//     session id, no reseed/repoint).
//
// The warm session (src/warm-cli-session.mjs) already talks to claude over that
// exact stream-json channel, so the spine compacts by sending "/compact" through
// the warm pool for the session's own key (egpt-spine.mjs compaction tick). That
// keeps it in-process (no spawned worker resuming the session behind the spine's
// back) and serialized with normal turns (ccode warm sessions expose no `inject`,
// so a /compact queues behind any in-flight turn — never woven into it).
//
// This module is the pure decision layer: which sessions exist, their per-model
// window, the live token size from Claude Code's own usage accounting, and the
// warm-pool keys (which MUST match the dispatch/spine keys — see the comments on
// compactionTargets). The deterministic trigger fires at COMPACT_RATIO of the
// window; once compacted, latestContextTokens reads ~0 (boundary newer than the
// last usage) so it won't re-fire until the session grows again.
//
// CLI (`node src/tools/compact-being.mjs`) is now READ-ONLY diagnostics — it
// reports token sizes + what's over threshold; the spine does the compacting.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Context window is PER-MODEL: haiku is 200k, the large-context 4.x models
// (sonnet/opus) are ~1M. Match by substring; a being may override with
// `context_window` in its sibling config.
export const MODEL_WINDOWS = { haiku: 200_000, sonnet: 1_000_000, opus: 1_000_000 };
export const DEFAULT_WINDOW = 200_000;
export const COMPACT_RATIO  = 0.25;   // keep sessions THIN — compact at 25% of the window (An 2026-06-19)
// A session whose jsonl changed within this window is treated as a turn IN FLIGHT
// (or just-ran). Kept for callers/tests that still reason about activity; the
// in-spine compactor serializes through the warm pool instead of mtime-guessing.
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
//    usage. Return 0 then, so we never re-compact an already-compacted session. ──
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

// ── pure: decision gate. ──
export function needsCompaction(tokens, { window = DEFAULT_WINDOW, ratio = COMPACT_RATIO } = {}) {
  return tokens >= Math.round(window * ratio);
}

// ── pure: is a session "active" right now? Claude writes the session jsonl at
//    turn START and during streaming, so a recent mtime ⇒ a turn is in flight. ──
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

// ── pure: ACTIVE conversations are ccode threads too — each contact entry holds
//    its own persona session (threadId) + cwd (threadCwd). Same compaction, so
//    busy chats stay thin alongside the beings (An 2026-06-19: "not only the
//    being, the active conversations"). cwd is null when there's no threadCwd; the
//    caller fills it with the slug-dir (the cwd the daemon resumes with). ──
export function compactableConversations(state, model = 'haiku') {
  const out = [];
  const contacts = state?.contacts ?? {};
  for (const surface of Object.keys(contacts)) {
    const bucket = contacts[surface] ?? {};
    for (const [jid, e] of Object.entries(bucket)) {
      if (!e || e.aliasOf || typeof e.threadId !== 'string' || !e.threadId) continue;   // no live thread → nothing to compact
      const slug = e.slug || jid;
      out.push({ name: `${surface}/${slug}`, surface, slug, sessionId: e.threadId, cwd: e.threadCwd || null, model, window: windowForModel(model) });
    }
  }
  return out;
}

// ── side-effecting: locate a session's jsonl across the Claude Code projects. ──
export function findSessionFile(sessionId) {
  const proj = join(homedir(), '.claude', 'projects');
  let dirs; try { dirs = readdirSync(proj); } catch { return null; }
  for (const d of dirs) {
    const f = join(proj, d, `${sessionId}.jsonl`);
    try { if (statSync(f).isFile()) return f; } catch { /* not here */ }
  }
  return null;
}

// Build the full compaction target list (beings + ccode conversation threads),
// each carrying the WARM-POOL KEY the spine must send "/compact" through. NO file
// reads here (cheap) — the spine reads token sizes only for the WARM ones.
//
// The keys MUST match the warm-pool keys the dispatch/spine build, or "/compact"
// would open a SECOND warm session resuming the same jsonl (corruption):
//   - conversation: `e:<brainType>:<surface>:<slug>`  — dispatch.mjs (warmScope)
//   - being:        `sib:<name>:<session_id>`          — egpt-spine.mjs sibling path
export function compactionTargets({ config, convState, slugDir, convBrainType = 'ccode' } = {}) {
  const targets = [];
  for (const b of compactableBeings(config)) {
    targets.push({ name: b.name, key: `sib:${b.name}:${b.sessionId}`, sessionId: b.sessionId, cwd: b.cwd, model: b.model, window: b.window, klass: 'resident' });
  }
  const model = config?.default_brain?.model || 'haiku';
  for (const c of compactableConversations(convState, model)) {
    const cwd = c.cwd || (typeof slugDir === 'function' ? slugDir(c.surface, c.slug) : c.cwd);
    targets.push({ name: c.name, key: `e:${convBrainType}:${c.surface}:${c.slug}`, sessionId: c.sessionId, cwd, model: c.model, window: c.window, klass: 'conversation' });
  }
  return targets;
}

// ── side-effecting: is ONE target over its compaction threshold right now? Reads
//    the session jsonl. Returns { due, tokens, threshold }. ──
export function dueForCompaction(target, { ratio = COMPACT_RATIO, resolveFile = findSessionFile } = {}) {
  const file = resolveFile(target.sessionId);
  if (!file) return { due: false };
  let tokens; try { tokens = latestContextTokens(readFileSync(file, 'utf8')); } catch { return { due: false }; }
  const window = target.window || windowForModel(target.model);
  return { due: needsCompaction(tokens, { window, ratio }), tokens, threshold: Math.round(window * ratio) };
}

// ── CLI: READ-ONLY diagnostics. Compaction itself runs in the spine. ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { readConfigSync } = await import('./config-io.mjs');
  const config = readConfigSync();
  let convState = {};
  let slugDir = null;
  try {
    const cs = await import('../../conversations-state.mjs');
    convState = await cs.readState(cs.CONV_YAML_PATH);
    slugDir = cs.slugDir;
  } catch (e) { console.error(`compact: conversation scan skipped — ${e?.message ?? e}`); }
  const targets = compactionTargets({ config, convState, slugDir });
  let over = 0;
  console.error('compact (read-only — compaction runs in the spine):');
  for (const t of targets) {
    const { due, tokens, threshold } = dueForCompaction(t);
    if (due) over++;
    console.error(`  ${t.name}: ${tokens ?? '?'} tok (25%=${threshold ?? Math.round((t.window || DEFAULT_WINDOW) * COMPACT_RATIO)}) — ${tokens == null ? 'no-session-file' : due ? 'OVER' : 'ok'}`);
  }
  console.log(`compact: ${over}/${targets.length} session(s) over threshold`);
}
