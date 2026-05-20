// conversations-state.mjs — pure-logic module for @e's per-contact
// conversation registry, personalities, and heartbeat resolution.
//
// Per-contact (NOT per-JID) model: each human or group gets ONE
// contact entry, keyed by a slug (e.g., "diego", "premise-driven-bitcoin").
// Multiple WA JIDs can map to one contact (lid + phone-number form for
// the same person) — they all live in the entry's `jids` array, share
// one `threadId`, one personality.
//
// Operator (2026-05-19): registry is YAML for human readability,
// personalities are markdown files shipped with egpt + overridable in
// ~/.egpt/personalities/, heartbeats per personality/contact follow
// the same resolution chain, all timestamps ISO 8601.
//
// This file: pure functions only — no fs/io side effects EXCEPT in
// explicit read/write helpers at the bottom that take paths. Easy to
// test, easy to call from any host.

import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import * as YAML from 'yaml';

const _here = dirname(fileURLToPath(import.meta.url));
const PERSONALITIES_SHIPPED_DIR  = join(_here, 'personalities');
const PERSONALITIES_OPERATOR_DIR = join(homedir(), '.egpt', 'personalities');
const HEARTBEATS_OPERATOR_DIR    = join(homedir(), '.egpt', 'heartbeats');
const LEGACY_HEARTBEAT_PATH      = join(homedir(), '.egpt', 'e-heartbeat.md');

// Canonical location of the per-contact YAML registry. Exported so
// daemon + slashes + tools all agree. The registry sits OUTSIDE the
// per-conversation dirs so conversation-e (cwd-locked to its own
// slug dir) can't read it.
export const CONV_YAML_PATH = join(homedir(), '.egpt', 'conversations.yaml');

// Per-conversation directory. Each contact gets its own folder; that
// folder is the only filesystem location conversation-e is given
// access to via --cwd / --add-dir. Layout:
//
//   ~/.egpt/conversations/<slug>/
//     transcript.md                ← per-thread play-script log
//     daily-YYYY-MM-DD.md (opt)    ← optional daily summaries written by @e
//     media/ (linked from ~/.egpt/media/<jid>/ — not moved for now)
export function slugDir(slug) {
  return join(homedir(), '.egpt', 'conversations', sanitizeSlug(slug));
}
export function slugTranscriptPath(slug) {
  return join(slugDir(slug), 'transcript.md');
}

// Per-JID media directory the bridge writes to (unchanged; for
// permissioning purposes we add it to conversation-e's --add-dir set).
export function jidMediaDir(jid) {
  const sanitized = String(jid ?? '').replace(/@/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(homedir(), '.egpt', 'media', sanitized);
}

// Best-effort reverse-engineer of claude's project-dir sanitization.
// Claude-code stores session JSONLs at ~/.claude/projects/<sanitized>/
// where sanitized = cwd.replace(/[\\\/:]/g, '-'). Reversing is lossy
// (a '-' in the result could have been '/' or '\' or ':') but the
// typical case is unambiguous:
//   Windows 'C:/Users/an/src/egpt'         → 'C--Users-an-src-egpt'
//   POSIX   '/home/user/.egpt'             → '-home-user-.egpt'
// Heuristic recovers the leading drive-letter or root, then maps
// remaining '-' back to '/'. Returns null when the input doesn't
// look like a recognizable path.
export function reverseSanitizeCwd(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return null;
  // Windows: 'X--rest' came from 'X:/rest'
  const winMatch = projectDir.match(/^([A-Za-z])--(.+)$/);
  if (winMatch) {
    return `${winMatch[1]}:/${winMatch[2].replace(/-/g, '/')}`;
  }
  // POSIX: '-rest' came from '/rest'
  if (projectDir.startsWith('-')) {
    return '/' + projectDir.slice(1).replace(/-/g, '/');
  }
  return null;
}

// Scan ~/.claude/projects/*/<threadId>.jsonl. Returns { projectDir, cwd }
// or null when not found anywhere.
import { readdirSync as _readdirSync, existsSync as _existsSync } from 'node:fs';
export function findThreadJsonl(threadId) {
  if (!threadId) return null;
  const projects = join(homedir(), '.claude', 'projects');
  if (!_existsSync(projects)) return null;
  let entries;
  try { entries = _readdirSync(projects); } catch { return null; }
  for (const d of entries) {
    const candidate = join(projects, d, `${threadId}.jsonl`);
    if (_existsSync(candidate)) {
      return { projectDir: d, cwd: reverseSanitizeCwd(d), jsonlPath: candidate };
    }
  }
  return null;
}

// Move media for each contact from ~/.egpt/media/<jid-sanitized>/ into
// the contact's <slug-dir>/media/. Operator (2026-05-20): media should
// live inside the conversation's own dir so conversation-e sees it at
// ./media without crossing its sandbox.
// Multi-JID contacts merge contents (filename-collision tolerant — on
// collision the existing file in slug-dir wins, the legacy stays for
// audit). Idempotent: skips contacts whose jid-media-dirs no longer
// exist (already migrated).
export async function migrateMediaToSlugDirs() {
  if (!existsSync(CONV_YAML_PATH)) return { migrated: 0, files: 0 };
  const state = await readState(CONV_YAML_PATH);
  let contactsTouched = 0, filesMoved = 0;
  for (const [slug, entry] of Object.entries(state.contacts ?? {})) {
    const dstDir = join(slugDir(slug), 'media');
    let touched = false;
    for (const jid of (entry.jids ?? [])) {
      const srcDir = jidMediaDir(jid);
      if (!existsSync(srcDir)) continue;
      try { await mkdir(dstDir, { recursive: true }); } catch {}
      // Move every file (and .media-index.json) from srcDir → dstDir.
      const { readdir } = await import('node:fs/promises');
      let names;
      try { names = await readdir(srcDir); } catch { continue; }
      for (const name of names) {
        const srcPath = join(srcDir, name);
        const dstPath = join(dstDir, name);
        if (existsSync(dstPath)) continue;   // don't clobber existing in slug-dir
        try { await rename(srcPath, dstPath); filesMoved++; touched = true; }
        catch (_) { /* cross-volume rename or perm — leave file in place */ }
      }
    }
    if (touched) contactsTouched++;
  }
  return { migrated: contactsTouched, files: filesMoved };
}

// Rename any contact whose slug lacks the '-yymmddhhmm' suffix.
// Idempotent: skips entries that already match the pattern. Suffix is
// derived from firstSeenAt (set once at creation) → threadCreatedAt
// (best-effort proxy for old entries) → file mtime → now. Renames the
// on-disk dir and updates the YAML key.
export async function migrateSlugSuffix() {
  if (!existsSync(CONV_YAML_PATH)) return { renamed: 0, skipped: 0 };
  const state = await readState(CONV_YAML_PATH);
  const oldContacts = state.contacts ?? {};
  const nextContacts = {};
  let renamed = 0, skipped = 0;
  for (const [oldSlug, entry] of Object.entries(oldContacts)) {
    if (hasSlugSuffix(oldSlug) || !entry?.jids?.length) {
      // Already migrated or has no JIDs to derive from — keep as-is.
      // Backfill firstSeenAt for already-suffixed entries that lack it.
      if (hasSlugSuffix(oldSlug) && !entry.firstSeenAt) {
        const inferredFromSlug = (() => {
          const m = oldSlug.match(/-(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
          if (!m) return null;
          const [, yy, MM, dd, HH, mm] = m;
          return new Date(Date.UTC(2000 + Number(yy), Number(MM) - 1, Number(dd), Number(HH), Number(mm))).toISOString();
        })();
        nextContacts[oldSlug] = { ...entry, firstSeenAt: inferredFromSlug ?? entry.threadCreatedAt ?? new Date().toISOString() };
      } else {
        nextContacts[oldSlug] = entry;
      }
      skipped++;
      continue;
    }
    // Determine firstSeenAt: explicit field, then threadCreatedAt,
    // then dir mtime, then now.
    let firstSeenAt = entry.firstSeenAt;
    if (!firstSeenAt) {
      if (entry.threadCreatedAt) firstSeenAt = entry.threadCreatedAt;
      else {
        try {
          const s = await stat(slugDir(oldSlug));
          firstSeenAt = new Date(s.birthtimeMs || s.mtimeMs).toISOString();
        } catch { firstSeenAt = new Date().toISOString(); }
      }
    }
    const newSlug = appendSlugSuffix(oldSlug, new Date(firstSeenAt));
    const oldDir = slugDir(oldSlug);
    const newDir = slugDir(newSlug);
    if (existsSync(oldDir) && !existsSync(newDir)) {
      try { await rename(oldDir, newDir); } catch (_) {}
    }
    nextContacts[newSlug] = { ...entry, firstSeenAt };
    renamed++;
  }
  if (renamed > 0 || Object.keys(nextContacts).some(k => oldContacts[k]?.firstSeenAt !== nextContacts[k]?.firstSeenAt)) {
    await writeState(CONV_YAML_PATH, { ...state, contacts: nextContacts });
  }
  return { renamed, skipped };
}

// ── State shape ─────────────────────────────────────────────────────────────

// emptyState() returns the empty registry.
export function emptyState() {
  return { contacts: {} };
}

// ── Slug uniqueness ────────────────────────────────────────────────────────

// Operator (2026-05-20): use a local-time suffix so the slug encodes
// the contact's creation time at a glance — '-yymmddhhmm'. Two groups
// with the same name across time will have different suffixes and
// won't collide.
//   diego-2605201243  =  contact 'diego' first seen 2026-05-20 12:43 local
export function slugSuffix(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  // UTC — stable across operator's TZ changes; not the local clock.
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return yy + MM + dd + HH + mm;
}
export function hasSlugSuffix(slug) {
  return /-\d{10}$/.test(String(slug ?? ''));
}
export function appendSlugSuffix(baseSlug, date = new Date()) {
  const base = sanitizeSlug(baseSlug);
  const suf = slugSuffix(date);
  return suf ? `${base}-${suf}` : base;
}

// ── Slug sanitization (filename + YAML-key safe) ───────────────────────────

export function sanitizeSlug(s) {
  return String(s ?? '')
    .replace(/[@:.\\/]/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

// ── Lookups ─────────────────────────────────────────────────────────────────

// Find which contact slug owns a given JID. O(N) but N is small.
export function findContactByJid(state, jid) {
  const contacts = state.contacts ?? {};
  for (const [slug, entry] of Object.entries(contacts)) {
    if (Array.isArray(entry?.jids) && entry.jids.includes(jid)) return slug;
  }
  return null;
}

// Get the contact entry for a JID, or null if not registered.
export function getContact(state, jid) {
  const slug = findContactByJid(state, jid);
  return slug ? { slug, entry: state.contacts[slug] } : null;
}

// ── Upsert ─────────────────────────────────────────────────────────────────

// Idempotent: add JID → existing contact, OR create new contact when JID is
// new. Refreshes pushedName when WA gives us a new one. Never overwrites
// operator-edited fields (personality, customName, threadId once set).
//
// Returns { state, slug, entry, isNew, changed }.
//
// ctx fields:
//   pushedName  — WA push name / group subject (best effort, may be '')
//   slugHint    — preferred slug when creating new (e.g., from getChatSlug);
//                 falls back to sanitize(pushedName) → 'contact_<short-hash>'
export function ensureContact(state, jid, ctx = {}) {
  if (!jid) return { state, slug: null, entry: null, isNew: false, changed: false };
  const next = { contacts: { ...(state.contacts ?? {}) } };

  // 1. JID already registered?
  const existingSlug = findContactByJid(state, jid);
  if (existingSlug) {
    const cur = next.contacts[existingSlug];
    let changed = false;
    if (ctx.pushedName && cur.pushedName !== ctx.pushedName) {
      next.contacts[existingSlug] = { ...cur, pushedName: ctx.pushedName };
      changed = true;
    }
    return { state: changed ? next : state, slug: existingSlug, entry: next.contacts[existingSlug], isNew: false, changed };
  }

  // 2. Does a contact with our intended slug already exist? If so, merge
  //    this JID into it (multi-JID auto-merge by slug). The slug carries
  //    a local-time suffix '-yymmddhhmm' tied to firstSeenAt so the dir
  //    name encodes when the contact was first registered (operator
  //    2026-05-20).
  const firstSeen = new Date();
  const baseSlug = (
    sanitizeSlug(ctx.slugHint)
    || sanitizeSlug(ctx.pushedName)
    || 'contact'
  );
  const candidateSlug = appendSlugSuffix(baseSlug, firstSeen);
  if (next.contacts[candidateSlug]) {
    const cur = next.contacts[candidateSlug];
    const jids = Array.isArray(cur.jids) ? [...cur.jids, jid] : [jid];
    next.contacts[candidateSlug] = {
      ...cur,
      jids,
      ...(ctx.pushedName && !cur.pushedName ? { pushedName: ctx.pushedName } : {}),
    };
    return { state: next, slug: candidateSlug, entry: next.contacts[candidateSlug], isNew: false, changed: true };
  }

  // 3. Brand-new contact. firstSeenAt is set once and never overwritten —
  //    that's what the slug-suffix is derived from, so /egpt new resets
  //    don't rename the dir.
  const entry = {
    personality: 'default',
    threadId: null,
    threadCreatedAt: null,
    firstSeenAt: firstSeen.toISOString(),
    identityInjectedAt: null,
    pushedName: ctx.pushedName ?? '',
    jids: [jid],
    heartbeatEnabled: false,
    heartbeatIntervalMin: null,
    heartbeatLastFiredAt: null,
  };
  next.contacts[candidateSlug] = entry;
  return { state: next, slug: candidateSlug, entry, isNew: true, changed: true };
}

// Set a specific field on a contact entry. Operator-grade edits go via this
// (or operator just edits the YAML by hand — same shape).
export function patchContact(state, slug, patch) {
  const cur = state.contacts?.[slug];
  if (!cur) return state;
  const next = { contacts: { ...state.contacts, [slug]: { ...cur, ...patch } } };
  return next;
}

// Record that a new thread was just spawned for a contact.
export function recordThread(state, slug, threadId, nowIso = nowIsoString()) {
  return patchContact(state, slug, {
    threadId,
    threadCreatedAt: nowIso,
    identityInjectedAt: nowIso,
  });
}

// ── Predicates ─────────────────────────────────────────────────────────────

export function isMuted(entry) {
  return entry?.personality === 'mute';
}

// Heartbeat opt-in: contact's heartbeatEnabled flag AND interval elapsed.
export function shouldFireHeartbeat(entry, nowMs = Date.now()) {
  if (!entry?.heartbeatEnabled) return false;
  const interval = (entry.heartbeatIntervalMin ?? 30) * 60 * 1000;
  const last = entry.heartbeatLastFiredAt
    ? Date.parse(entry.heartbeatLastFiredAt) || 0
    : 0;
  return (nowMs - last) >= interval;
}

// ── Personality file resolution ────────────────────────────────────────────

// Resolution chain: operator dir → shipped dir. Returns absolute path or null.
export function resolvePersonalityFile(name, opts = {}) {
  const safeName = sanitizeSlug(name || 'default') || 'default';
  const opDir   = opts.operatorDir   ?? PERSONALITIES_OPERATOR_DIR;
  const shipDir = opts.shippedDir    ?? PERSONALITIES_SHIPPED_DIR;
  const candidates = [
    join(opDir, `${safeName}.md`),
    join(shipDir, `${safeName}.md`),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export async function readPersonality(name, opts = {}) {
  const p = resolvePersonalityFile(name, opts);
  if (!p) return null;
  try { return await readFile(p, 'utf8'); }
  catch { return null; }
}

// ── Heartbeat file resolution ──────────────────────────────────────────────

// Resolution: contact-specific → personality-specific → default. Plus a
// last-ditch fallback to ~/.egpt/e-heartbeat.md for back-compat during
// migration.
export function resolveHeartbeatFile(contactSlug, personality, opts = {}) {
  const dir = opts.heartbeatsDir ?? HEARTBEATS_OPERATOR_DIR;
  const legacy = opts.legacyPath ?? LEGACY_HEARTBEAT_PATH;
  const candidates = [];
  if (contactSlug) candidates.push(join(dir, `${sanitizeSlug(contactSlug)}.md`));
  if (personality) candidates.push(join(dir, `${sanitizeSlug(personality)}.md`));
  candidates.push(join(dir, 'default.md'));
  candidates.push(legacy);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export async function readHeartbeat(contactSlug, personality, opts = {}) {
  const p = resolveHeartbeatFile(contactSlug, personality, opts);
  if (!p) return null;
  try { return await readFile(p, 'utf8'); }
  catch { return null; }
}

// ── YAML serialization ─────────────────────────────────────────────────────

export function serialize(state) {
  return YAML.stringify(state, { lineWidth: 100 });
}

export function parse(text) {
  if (!text || !text.trim()) return emptyState();
  const doc = YAML.parse(text);
  if (!doc || typeof doc !== 'object') return emptyState();
  if (!doc.contacts || typeof doc.contacts !== 'object') doc.contacts = {};
  return doc;
}

// ── Disk I/O helpers ───────────────────────────────────────────────────────

export async function readState(yamlPath) {
  try {
    const text = await readFile(yamlPath, 'utf8');
    return parse(text);
  } catch (_) { return emptyState(); }
}

export async function writeState(yamlPath, state) {
  await mkdir(dirname(yamlPath), { recursive: true });
  await writeFile(yamlPath, serialize(state), 'utf8');
}

// ── Migration: conversations.json → conversations.yaml ────────────────────

// Reads the old JID-keyed JSON shape and rebuilds it as the new slug-keyed
// YAML shape. JSON entries with the same customName merge into one
// new contact (their JIDs accumulate). Old entries without a customName
// get a slug derived from pushedName, or 'contact_<short>'.
//
// Returns { migrated: <#contacts>, jids: <#total jids merged> } or null
// when no migration needed.
export function migrateJsonToYaml(jsonMap) {
  if (!jsonMap || typeof jsonMap !== 'object') return null;
  const state = emptyState();
  let totalJids = 0;
  for (const [jid, row] of Object.entries(jsonMap)) {
    if (!row || typeof row !== 'object') continue;
    totalJids++;
    const slug = (
      sanitizeSlug(row.customName)
      || sanitizeSlug(row.pushedName)
      || `contact_${sanitizeSlug(jid).slice(0, 12)}`
    );
    if (!state.contacts[slug]) {
      state.contacts[slug] = {
        personality: 'default',
        threadId: null,
        threadCreatedAt: null,
        identityInjectedAt: null,
        pushedName: row.pushedName ?? '',
        jids: [],
        heartbeatEnabled: false,
        heartbeatIntervalMin: null,
        heartbeatLastFiredAt: null,
      };
    }
    state.contacts[slug].jids.push(jid);
    if (row.pushedName && !state.contacts[slug].pushedName) {
      state.contacts[slug].pushedName = row.pushedName;
    }
    // Preserve customNameSource flag if operator set one.
    if (row.customNameSource) state.contacts[slug].customNameSource = row.customNameSource;
  }
  return { state, migrated: Object.keys(state.contacts).length, jids: totalJids };
}

// ── Layout migration (flat conversations/e/<slug>.md → per-slug dirs) ─────

// Detect-and-migrate. Idempotent: if the new layout already exists,
// returns { skipped: 'reason' } without touching disk. Otherwise
// reads the old registry, creates per-slug dirs, moves transcript
// files in, and writes the registry at its new location.
import { readdirSync } from 'node:fs';
export async function migrateLayoutIfNeeded() {
  const newRegistry    = CONV_YAML_PATH;
  const oldDirRoot     = join(homedir(), '.egpt', 'conversations', 'e');
  const oldYaml        = join(oldDirRoot, 'conversations.yaml');
  const oldJson        = join(oldDirRoot, 'conversations.json');
  if (existsSync(newRegistry)) return { skipped: 'new layout already in place' };

  // Source the state from whichever legacy file exists.
  let state = null;
  if (existsSync(oldYaml)) {
    try { state = parse(await readFile(oldYaml, 'utf8')); } catch {}
  }
  if (!state && existsSync(oldJson)) {
    try {
      const json = JSON.parse(await readFile(oldJson, 'utf8'));
      const r = migrateJsonToYaml(json);
      if (r) state = r.state;
    } catch {}
  }
  if (!state) return { skipped: 'no old registry found' };

  // For each slug: create new dir, find + move transcript file in.
  // Old filename shapes we've used (worst case all five):
  //   <slug>.md
  //   <jid-sanitized>.md            (early days, jid-only)
  //   <jid-sanitized>__<slug>.md    (most common)
  //   <slug>__...md
  //   <jid-sanitized>__<pushedName-sanitized>.md   (pushedName variant)
  // Match case-insensitively + try each contact JID.
  let moved = 0;
  const entries = existsSync(oldDirRoot) ? readdirSync(oldDirRoot) : [];
  const lcEntries = entries.map(fn => ({ fn, lc: fn.toLowerCase() }));
  for (const [slug, entry] of Object.entries(state.contacts ?? {})) {
    const newDir = slugDir(slug);
    try { await mkdir(newDir, { recursive: true }); } catch {}
    const safeSlug = sanitizeSlug(slug).toLowerCase();
    const jids = entry.jids ?? [];
    const jidSluglets = jids.map(j => sanitizeSlug(j).toLowerCase());
    const candidates = lcEntries
      .filter(({ fn, lc }) => fn.endsWith('.md') && lc !== 'conversations.yaml')
      .filter(({ lc }) =>
        lc === `${safeSlug}.md` ||
        lc.endsWith(`__${safeSlug}.md`) ||
        lc.startsWith(`${safeSlug}__`) ||
        jidSluglets.some(j => lc === `${j}.md` || lc.startsWith(`${j}__`))
      )
      .map(({ fn }) => fn);
    if (!candidates.length) continue;
    // Pick the longest filename (most descriptive); if multiple, move
    // the first into transcript.md and append the rest below the header
    // so no history is lost.
    candidates.sort((a, b) => b.length - a.length);
    const target = join(newDir, 'transcript.md');
    try {
      if (!existsSync(target)) {
        await rename(join(oldDirRoot, candidates[0]), target);
        moved++;
      }
      // Any leftover candidates: append their content + bak-rename
      for (const fn of candidates.slice(1)) {
        try {
          const extra = await readFile(join(oldDirRoot, fn), 'utf8');
          const sep = `\n\n<!-- merged from legacy file: ${fn} -->\n\n`;
          await (await import('node:fs/promises')).appendFile(target, sep + extra);
          await rename(join(oldDirRoot, fn), join(oldDirRoot, fn + '.merged.bak'));
        } catch (_) {}
      }
    } catch (_) {}
  }
  await writeFile(newRegistry, serialize(state), 'utf8');
  if (existsSync(oldYaml)) { try { await rename(oldYaml, oldYaml + '.bak'); } catch {} }
  if (existsSync(oldJson)) { try { await rename(oldJson, oldJson + '.bak'); } catch {} }
  return { migrated: Object.keys(state.contacts ?? {}).length, moved };
}

// ── ISO time helper ────────────────────────────────────────────────────────

export function nowIsoString(d = new Date()) {
  return d.toISOString();
}

// Convert legacy numeric `at` (ms since epoch) → ISO. Used by persona-state
// when reading old config.json that still has numeric timestamps.
export function isoFromMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}
