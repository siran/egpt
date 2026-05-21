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
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';

export const CONFIG_YAML_PATH = join(homedir(), '.egpt', 'config.yaml');
export const CONFIG_JSON_LEGACY = join(homedir(), '.egpt', 'config.json');

// Sync reader — egpt.mjs loads EGPT_CONFIG at module import time before
// any async machinery is available. Try YAML first; on miss but JSON
// present, migrate in place + return parsed object.
export function readConfigSync() {
  if (existsSync(CONFIG_YAML_PATH)) {
    try { return YAML.parse(readFileSync(CONFIG_YAML_PATH, 'utf8')) ?? {}; }
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
      writeFileSync(CONFIG_YAML_PATH, YAML.stringify(cfg, { lineWidth: 100 }), 'utf8');
      renameSync(CONFIG_JSON_LEGACY, CONFIG_JSON_LEGACY + '.bak');
    } catch (e) { console.error(`!! readConfigSync(migrate): ${e?.stack ?? e?.message ?? e}`); }
    return cfg;
  }
  return {};
}

export async function readConfig() {
  if (existsSync(CONFIG_YAML_PATH)) {
    try { return YAML.parse(await readFile(CONFIG_YAML_PATH, 'utf8')) ?? {}; }
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
