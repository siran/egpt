// conv-grants.mjs — per-conversation-e custom directory grants (operator
// 2026-05-27). Parallel to rooms/config.yaml: a conversations/config.yaml that
// lives at the conversations/ ROOT, a sibling of the per-surface slug-dirs —
// so it sits OUTSIDE conversation-e's sandbox (which is confined to
// conversations/<surface>/<slug>/). conversation-e therefore cannot read or
// widen its own grants; only the operator can, via `/e path add|rm`.
//
// Shape (each path is a map carrying its access level):
//   grants:
//     <slug>:
//       paths:
//         - path: C:\some\dir
//           access: full      # full = read+write, read = read-only
//         - path: C:\refs
//           access: read
//
// A legacy bare string entry is read as { path: <string>, access: 'full' }.
// Each granted dir is merged into that contact turn's confined addDirs;
// read-only dirs are additionally enforced by a PreToolUse hook that denies
// write-class tools under them (see config/brains/claude-sdk.mjs).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';

export const CONV_GRANTS_PATH = join(homedir(), '.egpt', 'conversations', 'config.yaml');

export const GRANT_ACCESS = ['full', 'read'];

// Normalize an operator-typed access token to 'full' | 'read'. Unknown → full.
export function normalizeAccess(tok) {
  const t = String(tok ?? '').trim().toLowerCase();
  if (/^(ro|read|readonly|read-only)$/.test(t)) return 'read';
  return 'full';
}

export function emptyGrants() { return { grants: {} }; }

export async function loadGrants(path = CONV_GRANTS_PATH) {
  try {
    if (!existsSync(path)) return emptyGrants();
    const doc = YAML.parse(await readFile(path, 'utf8'));
    if (!doc || typeof doc !== 'object' || typeof doc.grants !== 'object') return emptyGrants();
    return { grants: doc.grants ?? {} };
  } catch (e) {
    console.error(`!! loadGrants(${path}): ${e?.message ?? e}`);
    return emptyGrants();
  }
}

export async function saveGrants(state, path = CONV_GRANTS_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, YAML.stringify({ grants: state?.grants ?? {} }), 'utf8');
}

// Normalized grant entries for a slug: { path, access }[]. Accepts both the
// map shape and a legacy bare string (= full). Deduped by path (first wins),
// order preserved. Pure.
export function grantedEntries(state, slug) {
  if (!slug) return [];
  const raw = state?.grants?.[slug]?.paths;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const path = typeof item === 'string' ? item : item?.path;
    if (typeof path !== 'string' || !path.trim() || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, access: typeof item === 'string' ? 'full' : normalizeAccess(item?.access) });
  }
  return out;
}

// Just the dir paths (full + read), for additionalDirectories.
export function grantedPaths(state, slug) {
  return grantedEntries(state, slug).map(e => e.path);
}

export function addGrant(state, slug, path, access = 'full') {
  if (!slug) throw new Error('addGrant: slug required');
  if (!path || !String(path).trim()) throw new Error('addGrant: path required');
  const acc = normalizeAccess(access);
  const next = { grants: { ...(state?.grants ?? {}) } };
  // Re-adding an existing path updates its access level.
  const entries = grantedEntries(state, slug).filter(e => e.path !== path);
  entries.push({ path, access: acc });
  next.grants[slug] = { ...(next.grants[slug] ?? {}), paths: entries };
  return next;
}

export function removeGrant(state, slug, path) {
  if (!slug) throw new Error('removeGrant: slug required');
  const next = { grants: { ...(state?.grants ?? {}) } };
  const kept = grantedEntries(state, slug).filter(e => e.path !== path);
  if (!kept.length) delete next.grants[slug];
  else next.grants[slug] = { ...(next.grants[slug] ?? {}), paths: kept };
  return next;
}

// Convenience for the dispatch resolver: load + read entries in one call.
export async function entriesForSlug(slug, path = CONV_GRANTS_PATH) {
  return grantedEntries(await loadGrants(path), slug);
}
