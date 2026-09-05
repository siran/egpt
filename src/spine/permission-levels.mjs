// permission-levels.mjs — parses config/permissions/<level>.md, the file
// `access_level: <one of ACCESS_LEVELS>` (all of them set by /agents <handle>|all
// access_level <level>, see spine/commands.mjs agentsAccessLevel; was /e access)
// points a being at. Sibling module to brains.mjs (the agent-
// TYPE resolver) but a deliberately different shape: brains.mjs resolves a def
// ONCE per conversation and it gets frozen into `readonly` (see its own header);
// this module is read FRESH, on every call, no caching, ever. That is
// intentional and is the ONE place this feature breaks the frozen-agent-type
// convention every other resolver in this repo follows on purpose — editing a
// permissions file must change behavior immediately for every conversation
// pointing at that level, with no command re-run (see brainpool.mjs's turn(),
// which calls loadPermissionLevel every turn, freeze or no freeze).
//
// File format: the first non-blank line MUST be exactly `dangerously_skip_permissions: true` or
// `dangerously_skip_permissions: false`; every `- ToolName` bullet anywhere after that (optionally
// followed by a `#`-prefixed comment) is a tool grant. Everything else — prose,
// headers, blank lines — is ignored, so the file can carry real commentary and
// still parse cleanly.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const PERMISSIONS_DIR = fileURLToPath(new URL('../../config/permissions/', import.meta.url));

// THE set of level names, and the ONE place they are written down (2026-09-05). Adding
// 'sandbox' had left the same three literals copied into four guards — this module's own,
// brainpool.mjs's override condition, and TWO validators in commands.mjs which still said
// all|regular, so `/agents access_level sandbox` was refused and the tier was reachable only
// by hand-editing conversations.yaml. Every one of those now asks isAccessLevel instead.
//
// ORDER IS USER-FACING: commands.mjs builds its usage/refusal text with ACCESS_LEVELS.join('|'),
// so this reads the way a human should meet the tiers — 'regular' confined, 'all' unconfined,
// 'sandbox' unconfined-but-boxed. A FOURTH tier is a file in config/permissions/ plus a name
// here; there is no string left to hunt for.
export const ACCESS_LEVELS = Object.freeze(['regular', 'all', 'sandbox']);

// The shared guard. Same shape as auto-mode.mjs's AUTO_MODES/isAutoMode pair, deliberately:
// a closed set of names owned by the module that resolves them, and one predicate everyone
// else calls. Total — a null/undefined/miscased level is simply not one.
export function isAccessLevel(level) { return ACCESS_LEVELS.includes(level); }

// Pure parse: text -> { dangerouslySkipPermissions, allowedTools } or null when the file
// doesn't open with the required `dangerously_skip_permissions:` line.
export function parsePermissionsDoc(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let dangerouslySkipPermissions = null;
  const allowedTools = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (dangerouslySkipPermissions === null) {
      const m = /^dangerously_skip_permissions:\s*(true|false)\s*$/i.exec(line);
      if (!m) return null;   // the first non-blank line must be the dangerously_skip_permissions flag
      dangerouslySkipPermissions = m[1].toLowerCase() === 'true';
      continue;
    }
    const bullet = /^-\s*(\S+)/.exec(line);
    if (bullet) allowedTools.push(bullet[1]);
  }
  if (dangerouslySkipPermissions === null) return null;
  return { dangerouslySkipPermissions, allowedTools };
}

// Resolve + read + parse config/permissions/<level>.md. NO caching (see header)
// — every call re-reads the file from disk. Returns null for an unknown level
// or a missing/unparseable file; callers decide how to treat that (eAccess
// refuses to write state, brainpool.mjs's turn() simply skips the override).
export function loadPermissionLevel(level, { dir = PERMISSIONS_DIR, exists = existsSync, readFile = readFileSync } = {}) {
  // 'sandbox' (operator 2026-09-05) is the THIRD name this resolves — config/permissions/
  // sandbox.md, which is all.md's grant verbatim. What makes that tier different is NOT
  // anything this parser can see: brainpool.mjs forces `sandboxed: true` for it, so the OS
  // box replaces the CLI-level confinement this file's flag drops. The guard is still a guard
  // and still refuses anything unnamed — it is just no longer a hand-copied list of literals:
  // ACCESS_LEVELS above is the only one, here and in every other caller.
  if (!isAccessLevel(level)) return null;
  const p = join(dir, `${level}.md`);
  if (!exists(p)) return null;
  let text;
  try { text = readFile(p, 'utf8'); } catch { return null; }
  return parsePermissionsDoc(text);
}
