// tools/config-io.mjs — read/write the operator's daemon config.
//
// Canonical file: ~/.egpt/config/config.yaml (operator-editable, YAML). New-config-only
// (operator 2026-07-02: "no legacy, no baggage") — the reader requires this exact path.
// A missing file reads as empty {}; a malformed one logs + reads empty. Writes go here.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EGPT_HOME } from "../egpt-home.mjs";
import { homedir } from 'node:os';
import * as YAML from 'yaml';

// Canonical config lives under ~/.egpt/config/ (operator 2026-06-23).
export const CONFIG_YAML_PATH = join(EGPT_HOME, 'config', 'config.yaml');

// Sync reader — egpt-spine.mjs loads EGPT_CONFIG at module import time before any async
// machinery is available. Missing file → empty {}; parse error → logged + empty.
export function readConfigSync() {
  try { return YAML.parse(readFileSync(CONFIG_YAML_PATH, 'utf8')) ?? {}; }
  catch (e) {
    if (e?.code === 'ENOENT') return {};
    console.error(`!! readConfigSync(YAML): ${e?.stack ?? e?.message ?? e}`); return {};
  }
}

export async function readConfig() {
  try { return YAML.parse(await readFile(CONFIG_YAML_PATH, 'utf8')) ?? {}; }
  catch (e) {
    if (e?.code === 'ENOENT') return {};
    console.error(`!! readConfig(YAML): ${e?.stack ?? e?.message ?? e}`); return {};
  }
}

export async function writeConfig(cfg) {
  await mkdir(dirname(CONFIG_YAML_PATH), { recursive: true });
  await writeFile(CONFIG_YAML_PATH, YAML.stringify(cfg, { lineWidth: 100 }), 'utf8');
}

// Per-sibling files live under ~/.egpt/config/agents/<name>.yaml (operator 2026-06-23).
// Loaded at boot + merged into EGPT_CONFIG.siblings — every reader uses that unchanged.
export const AGENT_DIR = join(EGPT_HOME, 'config', 'agents');

// Files only — skips subdirs like agents/l/ (the @l resident memory). Returns
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
