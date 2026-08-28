// config-shape.mjs — the SHAPE of a config file: which keys exist, not what
// they hold.
//
// Node configs legitimately DIFFER in values — dolly runs a 3B and reve a 26B,
// dj-son's heartbeat lives only on dolly — so comparing values would be noise.
// What must not drift is the shape: a key one node has and the other does not
// is either a half-finished change or a config the other node silently ignores.
//
// Values never leave the node. config.yaml holds beeper_token and
// relay_password; emitting key paths only means a drift report can be pasted
// anywhere without leaking them.
import * as YAML from 'yaml';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Dotted key paths, sorted. Arrays collapse to `[]` — a roster with three
 * members and one with five are the same SHAPE, and their length is a value.
 */
export function shapeOf(text, { maxDepth = 12 } = {}) {
  let doc;
  try { doc = YAML.parse(String(text ?? '')); } catch { return []; }
  const out = new Set();
  const walk = (node, prefix, depth) => {
    if (depth > maxDepth) return;
    if (Array.isArray(node)) {
      out.add(`${prefix}[]`);
      for (const item of node) if (isObj(item)) walk(item, `${prefix}[]`, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      walk(v, path, depth + 1);
    }
  };
  walk(doc, '', 0);
  return [...out].sort();
}

/** Keys present on exactly one side. */
export function diffShapes(a, b) {
  const A = new Set(a), B = new Set(b);
  return {
    onlyA: [...A].filter((k) => !B.has(k)).sort(),
    onlyB: [...B].filter((k) => !A.has(k)).sort(),
  };
}

/**
 * Some keys are per-conversation/per-room identity and are EXPECTED to differ —
 * a chat id exists on one node and not the other because the nodes are in
 * different chats. Those are dropped before diffing so the report shows real
 * drift instead of the roster.
 */
export const PER_NODE_PREFIXES = [
  'contacts.',          // conversations.yaml: one entry per chat
  'rooms.',             // rooms.yaml: one row per room
  'whatsapp.chat_id',
  'whatsapp.egpt_chats',
  'node_name',
];
export function dropPerNode(keys, prefixes = PER_NODE_PREFIXES) {
  return keys.filter((k) => !prefixes.some((p) => k === p || k.startsWith(p)));
}
