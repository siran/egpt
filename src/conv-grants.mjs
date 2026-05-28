// conv-grants.mjs — per-conversation-e custom directory grants (operator
// 2026-05-27). Parallel to rooms/config.yaml: a conversations/config.yaml that
// lives at the conversations/ ROOT, a sibling of the per-surface slug-dirs —
// so it sits OUTSIDE conversation-e's sandbox (which is confined to
// conversations/<surface>/<slug>/). conversation-e therefore cannot read or
// widen its own grants; only the operator can, via `/e path add|rm`.
//
// Shape:
//   grants:
//     <slug>:
//       paths:
//         - C:\some\dir
//
// Each granted dir is merged into that contact turn's confined addDirs (FULL
// access), alongside its own slug-dir and any room folders it belongs to.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';

export const CONV_GRANTS_PATH = join(homedir(), '.egpt', 'conversations', 'config.yaml');

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

// Granted custom paths for a slug (deduped, order preserved). Pure.
export function grantedPaths(state, slug) {
  if (!slug) return [];
  const paths = state?.grants?.[slug]?.paths;
  return Array.isArray(paths) ? [...new Set(paths.filter(p => typeof p === 'string' && p.trim()))] : [];
}

export function addGrant(state, slug, path) {
  if (!slug) throw new Error('addGrant: slug required');
  if (!path || !String(path).trim()) throw new Error('addGrant: path required');
  const next = { grants: { ...(state?.grants ?? {}) } };
  const cur = grantedPaths(state, slug);
  if (cur.includes(path)) return next;          // idempotent
  next.grants[slug] = { ...(next.grants[slug] ?? {}), paths: [...cur, path] };
  return next;
}

export function removeGrant(state, slug, path) {
  if (!slug) throw new Error('removeGrant: slug required');
  const next = { grants: { ...(state?.grants ?? {}) } };
  const cur = grantedPaths(state, slug);
  const kept = cur.filter(p => p !== path);
  if (!kept.length) delete next.grants[slug];
  else next.grants[slug] = { ...(next.grants[slug] ?? {}), paths: kept };
  return next;
}

// Convenience for the dispatch resolver: load + read in one call.
export async function pathsForSlug(slug, path = CONV_GRANTS_PATH) {
  return grantedPaths(await loadGrants(path), slug);
}
