// permission-levels.mjs — parses config/permissions/<level>.md, the file
// `access_level: 'all'|'regular'` (set by /e access, see spine/commands.mjs
// eAccess) points a conversation at. Sibling module to brains.mjs (the agent-
// TYPE resolver) but a deliberately different shape: brains.mjs resolves a def
// ONCE per conversation and it gets frozen into `readonly` (see its own header);
// this module is read FRESH, on every call, no caching, ever. That is
// intentional and is the ONE place this feature breaks the frozen-agent-type
// convention every other resolver in this repo follows on purpose — editing a
// permissions file must change behavior immediately for every conversation
// pointing at that level, with no command re-run (see brainpool.mjs's turn(),
// which calls loadPermissionLevel every turn, freeze or no freeze).
//
// File format: the first non-blank line MUST be exactly `dangerous: true` or
// `dangerous: false`; every `- ToolName` bullet anywhere after that (optionally
// followed by a `#`-prefixed comment) is a tool grant. Everything else — prose,
// headers, blank lines — is ignored, so the file can carry real commentary and
// still parse cleanly.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const PERMISSIONS_DIR = fileURLToPath(new URL('../../config/permissions/', import.meta.url));

// Pure parse: text -> { dangerous, allowedTools } or null when the file doesn't
// open with the required `dangerous:` line.
export function parsePermissionsDoc(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let dangerous = null;
  const allowedTools = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (dangerous === null) {
      const m = /^dangerous:\s*(true|false)\s*$/i.exec(line);
      if (!m) return null;   // the first non-blank line must be the dangerous flag
      dangerous = m[1].toLowerCase() === 'true';
      continue;
    }
    const bullet = /^-\s*(\S+)/.exec(line);
    if (bullet) allowedTools.push(bullet[1]);
  }
  if (dangerous === null) return null;
  return { dangerous, allowedTools };
}

// Resolve + read + parse config/permissions/<level>.md. NO caching (see header)
// — every call re-reads the file from disk. Returns null for an unknown level
// or a missing/unparseable file; callers decide how to treat that (eAccess
// refuses to write state, brainpool.mjs's turn() simply skips the override).
export function loadPermissionLevel(level, { dir = PERMISSIONS_DIR, exists = existsSync, readFile = readFileSync } = {}) {
  if (level !== 'all' && level !== 'regular') return null;
  const p = join(dir, `${level}.md`);
  if (!exists(p)) return null;
  let text;
  try { text = readFile(p, 'utf8'); } catch { return null; }
  return parsePermissionsDoc(text);
}
