// brains.mjs — the brain-definition registry (operator 2026-06-30). A brain is a
// YAML file (<name>.yaml) describing an ENGINE config: { type, model, effort,
// allowed_tools }. A conversation is INSTANCED from one on its first turn (frozen
// into conversations.yaml `readonly`); the `/e` wizard re-points it later.
//
// Resolution merges layers, most-specific LAST (so it wins), so an override file
// can set just the fields it cares about:
//   src/brains/            shipped built-ins
//   ~/.egpt2/config/brains/ profile-wide overrides / new brains
//   <slug>/brains/          one conversation only
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';

export const BUILTIN_BRAINS_DIR = fileURLToPath(new URL('../brains/', import.meta.url));
export const PROFILE_BRAINS_DIR = join(EGPT_HOME, 'config', 'brains');

export function createBrains({
  builtinDir = BUILTIN_BRAINS_DIR,
  profileDir = PROFILE_BRAINS_DIR,
  exists = existsSync,
  readFile = readFileSync,
  parse = YAML.parse,
  onLog = () => {},
} = {}) {
  function loadFrom(dir, name) {
    const p = join(dir, `${name}.yaml`);
    try { if (!exists(p)) return null; const def = parse(readFile(p, 'utf8')); return (def && typeof def === 'object') ? def : null; }
    catch (e) { onLog(`brain ${name} @ ${dir}: ${e?.message ?? e}`); return null; }
  }
  return {
    // Resolve a brain def by name across the layers (built-in ← profile ← conv).
    // convDir is the chat's slug folder; its brains/ wins. Returns { name, ...def }
    // or null when no layer defines <name>.
    resolve(name, { convDir = null } = {}) {
      const dirs = [builtinDir, profileDir, convDir && join(convDir, 'brains')].filter(Boolean);
      let def = null;
      for (const d of dirs) { const layer = loadFrom(d, name); if (layer) def = { ...(def ?? {}), ...layer }; }
      return def ? { name, ...def } : null;
    },
  };
}
