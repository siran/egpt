// brains.mjs — the brain-definition registry (operator 2026-06-30). A brain is a
// YAML file (<name>.yaml) describing an ENGINE config: { type, model, effort,
// allowed_tools }. A conversation resolves its def FRESH from this registry on
// EVERY turn (spine/brainpool.mjs's resolveDefaultBrainDef, operator 2026-08-14,
// phase 1: no more per-conversation freeze) — repoint an agent's `configuration`
// in config.yaml and every conversation follows on its next turn.
//
// VOCABULARY SHIFT (operator 2026-07-02): a "brain def" IS an agent TYPE. The
// `agents:` config block points each agent at a TYPE by name (agents.<name>.type),
// and that type names a file resolved here — the canonical home for type files is
// the profile's config/agents/ folder.
//
// Resolution merges layers, most-specific LAST (so it wins), so an override file
// can set just the fields it cares about:
//   src/brains/             shipped built-ins
//   ~/.egpt2/config/agents/ the canonical profile home for TYPE files
//   <slug>/brains/          one conversation only
// config/agents overrides the built-in — UNLESS the built-in is NEWER, since the profile
// file is a seeded copy of it and every seeded file resolves by prefer-newer (see resolve
// below). A conversation's own brains/ wins over both regardless.
// (operator 2026-07-02: the legacy config/brains layer is dropped — no baggage.)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { preferNewer } from '../prefer-newer.mjs';

export const BUILTIN_BRAINS_DIR = fileURLToPath(new URL('../brains/', import.meta.url));
export const PROFILE_AGENTS_DIR = join(EGPT_HOME, 'config', 'agents');

export function createBrains({
  builtinDir = BUILTIN_BRAINS_DIR,
  agentsDir = PROFILE_AGENTS_DIR,
  exists = existsSync,
  readFile = readFileSync,
  parse = YAML.parse,
  onLog = () => {},
} = {}) {
  function loadFrom(p, name) {
    try { if (!exists(p)) return null; const def = parse(readFile(p, 'utf8')); return (def && typeof def === 'object') ? def : null; }
    catch (e) { onLog(`brain ${name} @ ${p}: ${e?.message ?? e}`); return null; }
  }
  return {
    // Resolve a brain def / agent type by name across the layers (built-in ←
    // profile agents ← conv). convDir is the chat's slug folder; its brains/ wins.
    // Returns { name, ...def } or null when no layer defines <name>. No legacy 'default'
    // alias (operator 2026-07-02: "no legacy, no baggage") — the type is named 'egpt';
    // stored records were ported, not aliased. So resolve('default') is null unless the
    // operator keeps a real default.yaml layer.
    //
    // The profile type file is a SEEDED copy of the shipped one, so which of the two wins
    // is the house prefer-newer rule (prefer-newer.mjs), not a fixed side: the NEWER file
    // merges LAST (operator 2026-07-26 — config/agents winning unconditionally meant an
    // upgraded src/brains def could never reach a profile seeded copy-if-missing long ago).
    // Only the ORDER of those two changes: a partial override still merges field-by-field,
    // and a conversation's own brains/ still wins over both. With no readable mtimes
    // (an injected fs seam) preferNewer returns the profile path, i.e. the historical order.
    resolve(name, { convDir = null } = {}) {
      const builtinPath = join(builtinDir, `${name}.yaml`);
      const profilePath = join(agentsDir, `${name}.yaml`);
      const seeded = preferNewer(profilePath, builtinPath, { exists });
      const basePaths = seeded === builtinPath ? [profilePath, builtinPath] : [builtinPath, profilePath];
      let def = null;
      for (const p of basePaths) { const layer = loadFrom(p, name); if (layer) def = { ...(def ?? {}), ...layer }; }
      // dangerously_skip_permissions: true is a BASE-LAYERS-ONLY property (operator 2026-08:
      // the escalation-hole fix) — read from the built-in/profile merge BEFORE the conv-local
      // layer ever touches it, so a conversation's own brains/<name>.yaml can neither GRANT it
      // nor REVOKE a base-level grant. It stays fully immune to the conv-local layer in both
      // directions.
      const baseDangerouslySkipPermissions = def?.dangerously_skip_permissions === true;
      const convPath = convDir && join(convDir, 'brains', `${name}.yaml`);
      if (convPath) { const layer = loadFrom(convPath, name); if (layer) def = { ...(def ?? {}), ...layer }; }
      if (!def) return null;
      if (baseDangerouslySkipPermissions) def.dangerously_skip_permissions = true; else delete def.dangerously_skip_permissions;
      return { name, ...def };
    },
  };
}
