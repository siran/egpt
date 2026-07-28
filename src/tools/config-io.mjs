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

// Render ONE scalar (or, best-effort, a flat array/object) as inline YAML text: bare when the
// library's own plain-scalar rules allow it, quoted the moment it would otherwise be misread as
// a number/bool/null (YAML.stringify already makes exactly that call — see the quoting matrix
// in the writeConfigKey comment below). lineWidth:0 turns off the ~80-col wrap that used to
// split long scalars across two lines; flow:true keeps an array/object on the one line it was
// given rather than YAML's block-list default.
function serializeScalarYaml(value) {
  const opts = { lineWidth: 0 };
  if (value !== null && typeof value === 'object') opts.flow = true;
  return YAML.stringify(value, opts).replace(/\n+$/, '');
}

// The indent (column count) of a YAMLMap's existing entries, read off the first item's key
// range — null when the map has zero items (nothing to match against).
function blockIndent(mapNode, text) {
  if (!mapNode.items.length) return null;
  const keyStart = mapNode.items[0].key.range[0];
  const lineStart = text.lastIndexOf('\n', keyStart - 1) + 1;
  return keyStart - lineStart;
}

// Where a new sibling line belongs inside mapNode: right after the LAST existing item's full
// range (range[2] — value text + any trailing comment/newline), which for a nested-map value
// already lands past that whole nested block, not just its own first line. Falls back to EOF
// for a genuinely empty map (a rare `foo: {}`).
function blockInsertionPoint(mapNode, text) {
  if (!mapNode.items.length) return text.length;
  return mapNode.items[mapNode.items.length - 1].value.range[2];
}

const isMap = (node) => node?.constructor?.name === 'YAMLMap';

// Persist ONE dotted key into a config.yaml WITHOUT re-serializing the file (2026-07-28: the
// prior parseDocument -> setIn -> toString() round-trip preserved comment TEXT but still
// reprinted every line, which reflows trailing-comment alignment, multi-line comment blocks
// under a key, and long scalars wrapped at ~80 cols — on the operator's Apache-style
// one/two-line aligned comments, a single `/config set` could turn a 6-line diff into 180
// lines of noise. This version parses ONLY to find character ranges, then edits the raw source
// string directly, so every byte outside the changed value (or the one inserted line) survives
// untouched.
//
// KEY EXISTS: replace exactly the value node's [start,end) range with the new scalar text — its
// own leading indent, trailing comment, and the whitespace before that comment all live outside
// that range and are never touched.
// KEY MISSING, its parent block exists: insert one line at the end of that block, indented to
// match the block's own entries.
// PARENT BLOCK MISSING (partially or fully): build the minimal nested block for the unresolved
// tail of the dotted path and append it inside the deepest map that DOES exist (or at EOF if
// none of the path exists yet), each level indented 2 further than its parent.
//
// Used by /config set (src/spine/commands.mjs) instead of writeConfig, which stays uncalled —
// see that function's own comment for why.
export async function writeConfigKey(path, dottedKey, value) {
  await mkdir(dirname(path), { recursive: true });
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; text = ''; }

  const segments = dottedKey.split('.');
  const doc = YAML.parseDocument(text);
  const scalarText = serializeScalarYaml(value);

  // Walk down through existing YAMLMaps as far as the dotted path already goes.
  let node = doc.contents;
  let depth = 0;
  while (depth < segments.length - 1 && isMap(node)) {
    const pair = node.items.find((p) => String(p.key.value) === segments[depth]);
    if (!pair || !isMap(pair.value)) break;
    node = pair.value;
    depth++;
  }
  const remaining = segments.slice(depth);

  if (remaining.length === 1 && isMap(node)) {
    const leafPair = node.items.find((p) => String(p.key.value) === remaining[0]);
    if (leafPair) {
      const [start, end] = leafPair.value.range;
      await writeFile(path, text.slice(0, start) + scalarText + text.slice(end), 'utf8');
      return;
    }
    const indent = blockIndent(node, text) ?? depth * 2;
    const at = blockInsertionPoint(node, text);
    const nl = at > 0 && text[at - 1] !== '\n' ? '\n' : '';
    const line = `${nl}${' '.repeat(indent)}${remaining[0]}: ${scalarText}\n`;
    await writeFile(path, text.slice(0, at) + line + text.slice(at), 'utf8');
    return;
  }

  // One or more ancestor blocks don't exist yet — build them fresh, nested under whichever
  // ancestor DID resolve (or at document root/EOF if none did).
  const baseIndent = isMap(node) ? (blockIndent(node, text) ?? depth * 2) : 0;
  const lines = remaining.map((seg, i) => {
    const pad = ' '.repeat(baseIndent + i * 2);
    return i === remaining.length - 1 ? `${pad}${seg}: ${scalarText}` : `${pad}${seg}:`;
  });
  const at = isMap(node) ? blockInsertionPoint(node, text) : text.length;
  const nl = at > 0 && text[at - 1] !== '\n' ? '\n' : '';
  const block = `${nl}${lines.join('\n')}\n`;
  await writeFile(path, text.slice(0, at) + block + text.slice(at), 'utf8');
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
