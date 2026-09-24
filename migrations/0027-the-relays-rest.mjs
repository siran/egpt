// 0027 — the relays rest: `carol` and `cara` take no turns, and stay on file for the mesh's return.
//
// Operator, 2026-09-24: *"you can disable them... leave them on file since we'll return to the mesh
// in the future."* Both are RELAYS on kg - no brain here; each forwards into a relay_channel for a
// being on do (`carol` -> don.do on two paths, `cara` -> ed.do).
//
// `mode: off` IS WHAT SILENCES A RELAY, read in the code rather than assumed: the router returns a
// relay as a mesh target (`being: null`, `mesh.being` = the relay's own name), and spine.mjs gates
// it AS THAT AGENT (gateAs) before anything is forwarded. `off` makes gating.decide answer "not
// received" (src/auto-mode.mjs), so the message is neither recorded nor forwarded. It is the same
// line 0006 wrote for `djh` and 0025 for `codex`/`llama`.
//
// NOTHING ELSE IS TOUCHED: `paths:`, `relay_channel:`, `to:`, `handles:` and the level stay exactly
// as written, so turning a relay back on is this one line. The relay CHANNELS stay known to the node
// (src/spine/node-names.mjs reads them off these blocks), so an envelope arriving on one is still
// read as transit, not as a conversation.
//
// QUALIFIED BY HANDLE, through router.mjs's wakeTokens, never by map key - 0025's rule. A node
// without these relays (do) is satisfied and told so. A conversation that re-enables one is NOTED,
// never refused (a refusal stops every later migration on the node).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey, spliceYamlScalar } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';

export const elevated = false;
export const summary = 'the relays rest: carol and cara are switched off (mode: off) and kept on file, paths and all, for when the mesh returns';

const ID = '0027';
const AGENTS = 'agents';
const MODE = 'mode';
const OFF = 'off';
const RELAY_HANDLES = ['carol', 'cara'];

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

function open(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  return { file, bytes, text, doc, data: doc.toJS() };
}
const nodeAt = (f, path) => f.doc.getIn(path, true);
// The column a mapping's own keys sit at, read off the file (0025): spliceYamlInsertKey refuses
// text indented for a different map.
const columnOf = (f, path) => {
  const keyAt = nodeAt(f, path).items[0].key.range[0];
  return ' '.repeat(keyAt - (f.text.lastIndexOf('\n', keyAt - 1) + 1));
};
const writable = (f, path) => {
  const node = nodeAt(f, path);
  return YAML.isMap(node) && !node.flow && node.items.length > 0;
};
function rendered(file, before, after, label) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const strip = (l) => l.replace(/\r$/, '');
  const gone = a.slice(s, a.length - e).map(strip);
  const came = b.slice(s, b.length - e).map(strip);
  return [`${file}:${s + 1}-${s + Math.max(gone.length, came.length)}  ${label}`, ...gone.map((l) => `  - ${l}`), ...came.map((l) => `  + ${l}`)];
}
const modeLines = (pad) => [
  `${pad}# RESTING (${ID}, operator 2026-09-24: "you can disable them... leave them on file since we'll`,
  `${pad}# return to the mesh in the future"). \`${OFF}\` is the mode the gate already has: a relay is gated`,
  `${pad}# as its own agent before it forwards anything, so nothing reaches its relay_channel. Its`,
  `${pad}# paths and routes are untouched - turning it back on is this one line.`,
  `${pad}${MODE}: ${OFF}`,
];

// Every conversation that sets one of these relays' mode to something other than `off` - the
// per-conversation tier is resolved first (src/spine/gating.mjs), so it would keep forwarding there.
function modeOverrides(file, names) {
  if (!names.length || !existsSync(file)) return [];
  let data;
  try { data = YAML.parse(readFileSync(file, 'utf8')); }
  catch (e) { return [`${file} could not be read (${e?.message ?? e}), so whether a conversation re-enables one of these relays is unknown here`]; }
  const found = [];
  const walk = (node, path) => {
    if (!isMap(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (names.includes(k) && isMap(v) && Object.hasOwn(v, MODE) && v[MODE] !== OFF) {
        found.push(`${file} overrides it at ${[...path, k].join('.')}.${MODE} = ${show(v[MODE])}, so it still forwards there until that line goes`);
      }
      walk(v, [...path, k]);
    }
  };
  walk(data, []);
  return found;
}

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const f = open(file);
  const agents = isMap(f.data) ? f.data[AGENTS] : undefined;
  if (!isMap(agents)) return { satisfied: true, notes: [`${file} has no \`${AGENTS}:\` mapping - no relay here to rest`] };

  let text = f.text;
  const changes = [];
  const notes = [];
  const resting = [];
  for (const [name, a] of Object.entries(agents)) {
    if (String(name).startsWith('_') || !isMap(a)) continue;
    if (!wakeTokens(name, a).some((h) => RELAY_HANDLES.includes(h))) continue;
    const at = `${AGENTS}.${name}`;
    const mode = a[MODE];
    if (mode === OFF) { notes.push(`${at}.${MODE} is already \`${OFF}\``); resting.push(name); continue; }
    if (Object.hasOwn(a, MODE) && typeof mode !== 'string') {
      notes.push(`${at}.${MODE} in ${file} is ${show(mode)}, not a mode name - left alone rather than overwritten`);
      continue;
    }
    const stated = Object.hasOwn(a, MODE);
    let next;
    try {
      if (stated) next = spliceYamlScalar(text, [AGENTS, name, MODE], { expect: mode, to: OFF });
      else if (!writable(f, [AGENTS, name])) throw new Error('it is an empty or flow mapping - there is no column to match and no sibling to follow');
      else next = spliceYamlInsertKey(text, [AGENTS, name], { key: MODE, text: modeLines(columnOf(f, [AGENTS, name])).join('\n') });
    } catch (err) {
      notes.push(`\`${MODE}: ${OFF}\` cannot be written at ${at} in ${file} (${err?.message ?? err}) - not switched off here`);
      continue;
    }
    changes.push(...rendered(file, text, next, stated
      ? `\`${at}.${MODE}\`: ${mode} -> ${OFF} - the relay rests, kept on file`
      : `insert \`${MODE}: ${OFF}\` at ${at} - the relay rests, kept on file`));
    text = next;
    resting.push(name);
  }
  if (!resting.length) notes.push(`no being on this node answers to [ ${RELAY_HANDLES.join(', ')} ] - no relay here to rest`);
  notes.push(...modeOverrides(join(ctx.egptHome, 'config', 'conversations.yaml'), resting));
  if (!changes.length) return { satisfied: true, notes };
  changes.push(...notes, `backup first, beside it: config.yaml.bak-${ID}-<timestamp>`);
  return {
    satisfied: false,
    changes,
    apply: async () => {
      if (!readFileSync(file).equals(f.bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, text, 'utf8');
    },
  };
}
