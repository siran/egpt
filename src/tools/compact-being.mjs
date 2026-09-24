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

import { readFileSync, statSync,
         openSync as _openSync, fstatSync as _fstatSync,
         readSync as _readSync, closeSync as _closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// THE readers of the per-being conversation shape — imported, never re-derived here: residentsOf
// knows which object-valued keys are residents and which are contact-level containers
// (readonly/agents/guard), and getBeing layers the `agents.<name>` override over the block.
import { residentsOf, getBeing, findThreadJsonl } from '../conversations-state.mjs';
import { jsonlStoreDirOf } from '../sandbox-cli-session.mjs';

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

// ── pure: THE SPINE'S COMPACTION POLICY, in one place (2026-09-24). It lived as closures inside
//    src/spine/compaction.mjs, so /status could only approximate it: every conversation read the
//    node's default brain (haiku, 200k) and the node ratio, and an opus being showed a threshold
//    of 160k while the spine compacted it at 0.8 x 1M = 800k. The service and /status now both
//    ask these functions. compaction.mjs re-exports compactionRatio and DEFAULT_RATIO unchanged. ──

// THE NODE RATIO the spine applies: `compaction.ratio` from config, else 0.20. It is not this
// module's COMPACT_RATIO (0.25), which is only dueForCompaction's default PARAMETER when a caller
// passes none; the spine always passes this one.
export const DEFAULT_RATIO = 0.20;    // compact at 20% of the model window (operator 2026-06-30)
export function compactionRatio(config) {
  return Number(config?.compaction?.ratio ?? DEFAULT_RATIO) || DEFAULT_RATIO;
}

// A positive number, or null. BOOLEANS ARE REJECTED: `Number(true)` is 1, so `ratio: true` would
// read as "compact at 100% of the window", i.e. never, and a thread that overshoots is not
// compacted late, it is LOST (brainpool's overflow backstop resets it). Zero and negatives are
// rejected too (a ratio of 0 means "after every turn"). Numeric STRINGS still coerce: '0.6' is an
// ordinary YAML quoting accident, and it means what it says.
export function positiveOrNull(v) {
  const n = typeof v === 'boolean' ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// THE PER-CONVERSATION OVERRIDE a turn carries (operator 2026-09-03): this conversation's own
// `compaction:` block for the being, else the being's `agents.<being>.conversation_defaults.
// compaction` in config.yaml, else null (the node-global block). The same order brainpool's
// resolveConv has always read; a non-mapping is null, which is what the service made of it anyway.
export function compactionOverrideOf(beingView, config, being) {
  const o = beingView?.compaction ?? config?.agents?.[being]?.conversation_defaults?.compaction ?? null;
  return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
}

// What the spine compacts a being's thread at: the override's `ratio` when it is a usable one
// (0 < r <= 1), else the node ratio; the override's `context_window`, else the node's
// `compaction.context_window`, else the MODEL's own window. `model` is the being's resolved model
// (brainpool passes def.model on afterTurn); a null model reads DEFAULT_WINDOW, exactly as the
// spine does.
export function compactionPolicy(config, model, over = null) {
  const o = (over && typeof over === 'object' && !Array.isArray(over)) ? over : null;
  const r = positiveOrNull(o?.ratio);
  const ratio = r && r <= 1 ? r : compactionRatio(config);
  const window = positiveOrNull(o?.context_window) ?? (Number(config?.compaction?.context_window) || windowForModel(model));
  return { ratio, window, threshold: Math.round(window * ratio) };
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

// THE BOUNDED READ the CRITICAL probe uses (operator 2026-09-14). The ordinary compaction
// check runs once per cooling period and can afford readFileSync on the whole jsonl; the
// critical probe runs after EVERY turn, and a long-lived being's session is already megabytes
// (wren's was 4.2 MB the day this was written), so a full synchronous read there would put a
// multi-MB blocking read on the bridge's event loop once per reply -- on a bridge whose
// latency the operator had already flagged.
//
// BOUNDED IS SOUND HERE, not a shortcut: latestContextTokens needs only the LAST usage record
// and any compact boundary NEWER than it, and if the last usage is inside the tail then every
// boundary after it is inside the tail too. What the tail cannot answer is a session whose
// last usage is further back than TAIL_PROBE_BYTES -- and that answer is UNKNOWN, never zero.
// tailContextTokens returns null there and the caller falls back to the ordinary cooling wait,
// so a probe that cannot see is a probe that does not act.
export const TAIL_PROBE_BYTES = 2 * 1024 * 1024;

export function tailContextTokens(file, { bytes = TAIL_PROBE_BYTES, io = {} } = {}) {
  const open = io.openSync ?? _openSync, fstat = io.fstatSync ?? _fstatSync;
  const read = io.readSync ?? _readSync, close = io.closeSync ?? _closeSync;
  let fd;
  try { fd = open(file, 'r'); } catch { return null; }
  let text, from;
  try {
    const size = fstat(fd).size;
    from = Math.max(0, size - bytes);
    const len = size - from;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = read(fd, buf, got, len - got, from + got);
      if (!n) break;
      got += n;
    }
    text = buf.subarray(0, got).toString('utf8');
  } catch { return null; }
  finally { try { close(fd); } catch { /* already gone */ } }

  // A tail that did not start at byte 0 opens mid-line; that fragment is not JSON and must go,
  // or the first real record is silently skipped by the parse-and-continue below.
  if (from > 0) {
    const nl = text.indexOf('\n');
    if (nl === -1) return null;       // the tail is one unterminated line -- nothing readable
    text = text.slice(nl + 1);
  }

  const lines = text.split('\n');
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
  if (lastUsage === -1) return null;          // UNKNOWN, not zero -- see the note above
  if (lastBoundary > lastUsage) return 0;     // compacted since the last measured turn
  return lastUsageTokens;
}

// Is this session ALREADY past the critical ratio, i.e. too big to keep waiting for quiet?
// Same decision gate as dueForCompaction, over the bounded tail read instead of the whole file,
// and FALSE on every uncertainty (no session file, unreadable, tail too short to hold a usage
// record) -- the ordinary cooling path is the fallback and it reads the file properly.
export function criticallyOver(target, { ratio, resolveFile = findSessionFile, bytes = TAIL_PROBE_BYTES, io = {} } = {}) {
  if (!(Number.isFinite(ratio) && ratio > 0)) return false;
  const file = resolveFile(target?.sessionId);
  if (!file) return false;
  const tokens = tailContextTokens(file, { bytes, io });
  if (tokens == null) return false;
  return needsCompaction(tokens, { window: target.window || windowForModel(target.model), ratio });
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

// ── pure: ACTIVE conversations are ccode threads too — same compaction, so busy chats stay
//    thin alongside the beings (An 2026-06-19: "not only the being, the active conversations").
//
//    ONE TARGET PER RESIDENT BEING (fix 2026-07-26, HANDOFF C4). A conversation hosts residents,
//    each with its OWN thread in its `agents.<being>` block (phase 1, operator 2026-08-14 — was
//    `entry[<being>]` before); a pre-phase-1 `entry.threadId` or `entry[<being>]` block is a dead
//    slot getBeing no longer reads (see conversations-state.mjs's getBeing doc comment) — so it
//    contributes nothing here either, by the same degrade. `engine` is ALWAYS null now (phase 1:
//    there is no more per-conversation freeze of the brain type to read) — the caller
//    (compactionTargets) falls back to its own `convBrainType` default for the warm key, exactly
//    as it already did for a never-instanced conversation. `threadCwd` is retired, so no cwd
//    travels here: the caller resolves the slug-dir, which is the cwd the daemon actually
//    resumes with. ──
//
//    EACH BEING'S OWN MODEL AND POLICY (2026-09-24). `model` is only the fallback; a caller that
//    can resolve a being's def hands `modelOf({ being, surface, slug, beingView })` (/status does,
//    through brainpool's resolveBeingDef - the resolver turn() itself uses), and its answer is
//    taken AS IS, null included, because the spine passes def.model as is. `config` gives each
//    target the ratio and window compactionPolicy says the spine applies, override included.
export function compactableConversations(state, model = 'haiku', { config = null, modelOf = null } = {}) {
  const out = [];
  const contacts = state?.contacts ?? {};
  for (const surface of Object.keys(contacts)) {
    const bucket = contacts[surface] ?? {};
    for (const [jid, e] of Object.entries(bucket)) {
      if (!e || e.aliasOf) continue;
      const slug = e.slug || jid;
      for (const being of residentsOf(e)) {
        const b = getBeing(state, surface, jid, being);
        if (typeof b?.threadId !== 'string' || !b.threadId) continue;   // no live thread → nothing to compact
        let own = model;
        if (typeof modelOf === 'function') {
          try { own = modelOf({ being, surface, slug, beingView: b }) ?? null; } catch { own = model; }
        }
        const { window, ratio } = compactionPolicy(config, own, compactionOverrideOf(b, config, being));
        out.push({ name: `${surface}/${slug}#${being}`, surface, slug, being, sessionId: b.threadId, engine: null, model: own, window, ratio });
      }
    }
  }
  return out;
}

// ── side-effecting: locate a session's jsonl, BY ID, wherever its CLI keeps it. ──
// TWO ROOTS (operator 2026-09-24). An unboxed being's CLI files its sessions under the operator's
// ~/.claude/projects; a BOXED being's runs with CLAUDE_CONFIG_DIR=~/.egpt-jsonl/<threadId>
// (src/sandbox-cli-session.mjs), so its session lives under THAT root. Looking only in ~/.claude
// found no boxed session at all, dueForCompaction answered { due: false } for every one, and no
// boxed being was ever compacted - measured on kg: 0 compactions of either kind across 65 boxed
// sessions, the largest at 478k tokens. Both roots are asked BY ID (findThreadJsonl), never by the
// folder a cwd would name. When both hold the thread (0026 copies, never moves), the one written
// last is the live one. The roots are parameters only so a test never reads a real profile.
export function findSessionFile(sessionId, { claudeProjects = join(homedir(), '.claude', 'projects'), storeRoot = null } = {}) {
  if (!sessionId) return null;
  const storeDir = jsonlStoreDirOf(sessionId, storeRoot ? { jsonlStoreRoot: storeRoot } : {});
  const found = [
    storeDir ? findThreadJsonl(sessionId, [], { projectsRoot: join(storeDir, 'projects') }) : null,
    findThreadJsonl(sessionId, [], { projectsRoot: claudeProjects }),
  ].filter(Boolean).map((f) => f.jsonlPath);
  let newest = null, newestAt = -Infinity;
  for (const f of found) {
    let at; try { at = statSync(f).mtimeMs; } catch { continue; }
    if (at > newestAt) { newest = f; newestAt = at; }
  }
  return newest;
}

// Build the full compaction target list (beings + ccode conversation threads),
// each carrying the WARM-POOL KEY the spine must send "/compact" through. NO file
// reads here (cheap) — the spine reads token sizes only for the WARM ones.
//
// The keys MUST match the warm-pool keys the dispatch/spine build, or "/compact"
// would open a SECOND warm session resuming the same jsonl (corruption):
//   - conversation: `<being>:<engine>:<surface>:<slug>` — brainpool.mjs:366 (`def.type ?? brainType`)
//   - being:        `sib:<name>:<session_id>`           — egpt-spine.mjs sibling path
// The conversation half was written `e:<brainType>:…` when the persona was hardcoded 'e'; the
// resident's own name is what brainpool keys on (live profiles run `egpt`), so it comes from the
// enumeration now instead of being spelled a second time here.
export function compactionTargets({ config, convState, slugDir, convBrainType = 'ccode', modelOf = null } = {}) {
  const targets = [];
  for (const b of compactableBeings(config)) {
    targets.push({ name: b.name, key: `sib:${b.name}:${b.sessionId}`, sessionId: b.sessionId, cwd: b.cwd, model: b.model, window: b.window, klass: 'resident' });
  }
  const model = config?.default_brain?.model || 'haiku';
  for (const c of compactableConversations(convState, model, { config, modelOf })) {
    const cwd = typeof slugDir === 'function' ? slugDir(c.surface, c.slug) : null;
    targets.push({ name: c.name, key: `${c.being}:${c.engine ?? convBrainType}:${c.surface}:${c.slug}`, sessionId: c.sessionId, cwd, model: c.model, window: c.window, ratio: c.ratio, klass: 'conversation' });
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
    const cs = await import('../conversations-state.mjs');
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
