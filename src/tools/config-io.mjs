// tools/config-io.mjs — read/write the operator's daemon config.
//
// Canonical file: ~/.egpt/config.yaml (operator-editable, YAML).
// Legacy file:    ~/.egpt/config.json (auto-migrated to YAML on first read).
//
// Operator (2026-05-20): wants config in YAML. The reader prefers YAML,
// falls back to JSON; the synchronous reader does the JSON → YAML
// migration in place if it finds legacy and no YAML exists. Writes
// always go to YAML. JSON is renamed to .bak after migration.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';

// Canonical config now lives under ~/.egpt/config/ (operator 2026-06-23). Read
// resolves the new location first, then the pre-move root path (~/.egpt/config.yaml)
// so the migration can't brick boot; writes always go to the new config/ location.
export const CONFIG_YAML_PATH = join(homedir(), '.egpt', 'config', 'config.yaml');
const LEGACY_CONFIG_YAML = join(homedir(), '.egpt', 'config.yaml');
export const CONFIG_JSON_LEGACY = join(homedir(), '.egpt', 'config.json');

// The config.yaml to READ from — new config/ location, else the legacy root.
function _readConfigYamlPath() {
  if (existsSync(CONFIG_YAML_PATH)) return CONFIG_YAML_PATH;
  if (existsSync(LEGACY_CONFIG_YAML)) return LEGACY_CONFIG_YAML;
  return null;
}

// Sync reader — egpt.mjs loads EGPT_CONFIG at module import time before
// any async machinery is available. Try YAML first; on miss but JSON
// present, migrate in place + return parsed object.
export function readConfigSync() {
  const yamlPath = _readConfigYamlPath();
  if (yamlPath) {
    try { return YAML.parse(readFileSync(yamlPath, 'utf8')) ?? {}; }
    catch (e) { console.error(`!! readConfigSync(YAML): ${e?.stack ?? e?.message ?? e}`); return {}; }
  }
  if (existsSync(CONFIG_JSON_LEGACY)) {
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(CONFIG_JSON_LEGACY, 'utf8')) ?? {}; }
    catch (e) { console.error(`!! readConfigSync(JSON legacy): ${e?.stack ?? e?.message ?? e}`); return {}; }
    // One-time sync migration. If anything fails, leave the JSON in
    // place so subsequent runs can retry — caller still gets the parsed
    // config either way.
    try {
      mkdirSync(dirname(CONFIG_YAML_PATH), { recursive: true });
      writeFileSync(CONFIG_YAML_PATH, YAML.stringify(cfg, { lineWidth: 100 }), 'utf8');
      renameSync(CONFIG_JSON_LEGACY, CONFIG_JSON_LEGACY + '.bak');
    } catch (e) { console.error(`!! readConfigSync(migrate): ${e?.stack ?? e?.message ?? e}`); }
    return cfg;
  }
  return {};
}

export async function readConfig() {
  const yamlPath = _readConfigYamlPath();
  if (yamlPath) {
    try { return YAML.parse(await readFile(yamlPath, 'utf8')) ?? {}; }
    catch (e) { console.error(`!! readConfig(YAML): ${e?.stack ?? e?.message ?? e}`); return {}; }
  }
  if (existsSync(CONFIG_JSON_LEGACY)) {
    try { return JSON.parse(await readFile(CONFIG_JSON_LEGACY, 'utf8')) ?? {}; }
    catch (e) { console.error(`!! readConfig(JSON legacy): ${e?.stack ?? e?.message ?? e}`); return {}; }
  }
  return {};
}

export async function writeConfig(cfg) {
  await mkdir(dirname(CONFIG_YAML_PATH), { recursive: true });
  await writeFile(CONFIG_YAML_PATH, YAML.stringify(cfg, { lineWidth: 100 }), 'utf8');
}

// Siblings live in per-sibling files: ~/.egpt/agent/<name>.yaml (one file each,
// extracted from config.yaml 2026-06-23). Loaded at boot + merged into
// EGPT_CONFIG.siblings — every reader uses EGPT_CONFIG.siblings unchanged.
export const AGENT_DIR = join(homedir(), '.egpt', 'agent');

// Files only — skips subdirs like agent/l/ (the @l resident memory). Returns
// { name: cfg }. Sync because EGPT_CONFIG is built at module-import time.
export function loadSiblingFilesSync(dir = AGENT_DIR) {
  const out = {};
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.yaml')) continue;
    const name = ent.name.slice(0, -5);
    try {
      const doc = YAML.parse(readFileSync(join(dir, ent.name), 'utf8'));
      if (doc && typeof doc === 'object') out[name] = doc;
    } catch (e) { console.error(`!! loadSiblingFiles(${ent.name}): ${e?.stack ?? e?.message ?? e}`); }
  }
  return out;
}

// Persist a sibling's session_id to its OWN agent/<name>.yaml, comment-preserving
// (parseDocument keeps the per-sibling _note + comments — unlike a whole-config
// YAML.stringify rewrite, which dropped them).
export async function writeSiblingSessionId(name, sessionId, dir = AGENT_DIR) {
  const fp = join(dir, `${name}.yaml`);
  await mkdir(dir, { recursive: true });
  let doc;
  try { doc = YAML.parseDocument(await readFile(fp, 'utf8')); }
  catch { doc = new YAML.Document({}); }
  doc.setIn(['session_id'], sessionId ?? null);
  await writeFile(fp, doc.toString());
}
