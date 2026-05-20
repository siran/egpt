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

// ── State shape ─────────────────────────────────────────────────────────────

// emptyState() returns the empty registry.
export function emptyState() {
  return { contacts: {} };
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
  //    this JID into it (multi-JID auto-merge by slug).
  const candidateSlug = (
    sanitizeSlug(ctx.slugHint)
    || sanitizeSlug(ctx.pushedName)
    || `contact_${sanitizeSlug(jid).slice(0, 12)}`
  );
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

  // 3. Brand-new contact.
  const entry = {
    personality: 'default',
    threadId: null,
    threadCreatedAt: null,
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

  // For each slug: create new dir, move transcript file in.
  let moved = 0;
  const entries = existsSync(oldDirRoot) ? readdirSync(oldDirRoot) : [];
  for (const slug of Object.keys(state.contacts ?? {})) {
    const newDir = slugDir(slug);
    try { await mkdir(newDir, { recursive: true }); } catch {}
    // Old filename shapes we've used: `<slug>.md`, `<jid>__<slug>.md`,
    // sanitized pushedName forms. Match any that contain the slug.
    const safeSlug = sanitizeSlug(slug);
    const candidates = entries.filter(fn =>
      fn.endsWith('.md') && (
        fn === `${safeSlug}.md` ||
        fn.endsWith(`__${safeSlug}.md`) ||
        fn.startsWith(`${safeSlug}__`)
      )
    );
    for (const fn of candidates) {
      try {
        const target = join(newDir, 'transcript.md');
        if (!existsSync(target)) {
          await rename(join(oldDirRoot, fn), target);
          moved++;
          break;
        }
      } catch (_) {}
    }
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
