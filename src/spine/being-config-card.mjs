// being-config-card.mjs — a room's `./directives/config.readonly.yaml` (operator 2026-09-24): how
// the beings in this room are configured, so a being can READ its own setup.
//
// WHY A RENDERED FILE AND NOT A GRANT ON config/: that folder holds the node's secrets — the
// Beeper tokens (which can send as the operator in every chat), shell/worker/voice tokens, the
// radio relay password, the sandbox OAuth token — plus dozens of .bak copies of them and logs of
// every chat. A being needs none of that to know how IT runs.
//
// WHAT IT HOLDS: one block per being that takes turns here, keyed by the being's key, stating
// what the turn actually runs with and, in a trailing comment, where each value came from. It is
// built FIELD BY FIELD from values brainpool already resolved; nothing here spreads a config
// object, so a node-level key can never reach the file (tests/being-config-card.test.mjs holds
// that). Resolution stays where it lives — resolveConv, resolveSandboxedRung, resolveMode,
// resolveBeingDef, resolveOutboxTarget — this module only LABELS and writes.
//
// WHEN: brainpool's turn() renders its own being's block at the START of every turn (so a fresh
// thread's first turn already sees it), and the file is written ONLY when the text changes: a new
// thread changes the thread line, a config edit changes a value. Another being's block is carried
// over untouched. Best-effort: an error is logged and the turn goes on.
import { readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename, mkdir as fsMkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { wakeTokens } from './router.mjs';
import { compactionRatio } from './compaction.mjs';

export const CONFIG_CARD_FILE = 'config.readonly.yaml';
const HEADER = [
  '# How the beings in this room are configured. Written by the spine when something changes;',
  '# editing this file changes nothing. To change something, ask the operator.',
];

// The tier names brainpool's resolvers report, as the card says them.
const FROM = {
  conversation: 'this conversation',
  agent: 'agent default (config.yaml)',
  node: 'node default (config.yaml)',
  default: 'built-in default',
  level: 'access_level sandbox forces it',
  platform: 'platform default',
};

// One YAML value on one line: a scalar as YAML would write it, a list or map in flow style.
const flow = (v) => YAML.stringify(v, { collectionStyle: 'flow', lineWidth: 0 }).trimEnd();
const COMMENT_AT = 36;
const line = (indent, key, value, from) => {
  const text = `${' '.repeat(indent)}${flow(key)}:${value === undefined ? '' : ` ${flow(value)}`}`;
  return from ? `${text.padEnd(COMMENT_AT - 1)} # ${from}` : text;
};

// `allowed_paths` as the card shows it: each root with its tools, or "all tools" when the entry
// names none (brainpool's allowedPathsFor then grants full access to it).
function pathsOf(allowedPaths) {
  const map = (allowedPaths && typeof allowedPaths === 'object' && !Array.isArray(allowedPaths)) ? allowedPaths : {};
  return Object.entries(map).map(([root, v]) => {
    const tools = Array.isArray(v?.allowed_tools) ? v.allowed_tools : null;
    return [root, tools && tools.length ? tools : 'all tools'];
  });
}

/**
 * The being's own block, as text. Every argument is a value brainpool already resolved.
 * @returns {string}
 */
export function renderConfigBlock({
  being, config = {}, scoped = false, configuration = null, def = {}, engine, model, effort,
  accessLevel, sandboxed, sandboxedRung, mode, verboseThinking, verboseSource, allowedUsers,
  compaction, sources = {}, outboxTarget = null, threadId = null,
}) {
  const agent = config.agents?.[being] ?? {};
  const typeName = configuration ?? (typeof agent.configuration === 'string' ? agent.configuration : null);
  const typeFrom = configuration != null ? FROM.conversation : (typeName ? FROM.agent : FROM.default);
  const inType = (v) => (v != null && typeName ? `type file config/agents/${typeName}.yaml` : FROM.default);
  const out = [`${flow(being)}:`];
  out.push(line(2, 'handles', wakeTokens(being, agent)));
  if (config.node_name) out.push(line(2, 'node', String(config.node_name)));
  out.push(line(2, 'configuration', typeName ?? 'none', typeFrom));
  out.push(line(2, 'engine', engine ?? null, inType(def.type)));
  out.push(line(2, 'model', model ?? null, inType(def.model)));
  out.push(line(2, 'effort', effort ?? null, inType(def.effort)));
  out.push(line(2, 'access_level', accessLevel ?? null, FROM[sources.accessLevel]));
  out.push(line(2, 'sandboxed', sandboxed === true, FROM[sandboxedRung]));
  out.push(scoped
    ? line(2, 'mode', 'per chat', 'each chat invited into this room sets its own')
    : line(2, 'mode', mode?.mode ?? null, FROM[mode?.source]));
  out.push(line(2, 'verbose_thinking', verboseThinking === true, verboseSource === 'type' ? inType(true) : FROM[verboseSource]));
  const paths = pathsOf(def.allowed_paths);
  if (paths.length) {
    out.push(line(2, 'allowed_paths', undefined, 'its type file, plus any node-wide grant'));
    for (const [root, tools] of paths) out.push(line(4, root, tools));
  }
  if (Array.isArray(allowedUsers)) out.push(line(2, 'allowed_users', allowedUsers, FROM[sources.allowedUsers]));
  const own = (compaction && typeof compaction === 'object' && !Array.isArray(compaction)) ? compaction : null;
  out.push(own
    ? line(2, 'compaction', own, FROM[sources.compaction])
    : line(2, 'compaction', { ratio: compactionRatio(config) }, FROM.node));
  if (outboxTarget?.key) {
    out.push(line(2, 'outbox_to', outboxTarget.key, outboxTarget.to ? FROM[sources.outboxTo] : 'not an approved target - nothing is delivered'));
  }
  out.push(line(2, 'thread', threadId ?? 'new', threadId ? null : 'its id is assigned on this turn'));
  return out.join('\n');
}

/**
 * The whole file with `being`'s block replaced (or added), every other block kept verbatim.
 * An existing file that does not parse, or whose text does not split into one block per
 * top-level key, is started afresh — the next turn of each other being writes its block back.
 * @returns {string}
 */
export function mergeConfigCard(existing, being, block) {
  const blocks = new Map();
  const text = typeof existing === 'string' ? existing.replace(/\r\n/g, '\n') : '';
  if (text.trim()) {
    let keys = null;
    try {
      const data = YAML.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) keys = Object.keys(data);
    } catch { keys = null; }
    const chunks = [];
    for (const l of text.split('\n')) {
      if (/^[^\s#]/.test(l)) chunks.push([l]);
      else if (chunks.length && l.trim()) chunks[chunks.length - 1].push(l);
    }
    if (keys && keys.length === chunks.length) keys.forEach((k, i) => blocks.set(k, chunks[i].join('\n')));
  }
  blocks.set(being, block);
  return `${HEADER.join('\n')}\n\n${[...blocks.values()].join('\n\n')}\n`;
}

/**
 * Write `being`'s block into `<room>/directives/config.readonly.yaml` when it changed. Temp file
 * + rename (a direct write when the injected io has no rename, as the test fakes do). Never throws.
 * @returns {Promise<boolean>} whether the file was written
 */
export async function writeConfigCard(room, being, block, { io = {}, onLog = () => {} } = {}) {
  const readFile = io.readFile ?? fsReadFile;
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;
  const rename = io.rename ?? (io.writeFile ? null : fsRename);
  const file = join(room.directivesDir, CONFIG_CARD_FILE);
  try {
    let existing = '';
    try { existing = (await readFile(file, 'utf8')) ?? ''; } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    const next = mergeConfigCard(existing, being, block);
    if (next === existing) return false;
    await mkdir(room.directivesDir, { recursive: true });
    if (!rename) { await writeFile(file, next, 'utf8'); return true; }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, file);
    return true;
  } catch (e) {
    onLog(`config card: ${being} in ${file}: ${e?.message ?? e}`);
    return false;
  }
}
