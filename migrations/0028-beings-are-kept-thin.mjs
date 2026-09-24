// 0028 — beings are kept thin; the meta engineers and acim's being keep more.
//
// Operator, 2026-09-24: *"beings thin 0.2 / metaeng 0.8 / acim has an acim-E, we can keep it at
// .8"*. And why thin is right: *"the model is usually very good after an initial inspection. so
// frequent compacts is OK since the whole thing is in the transcript. it has been working."*
//
// WHAT THE RATIOS MEANT BEFORE, read the same day. src/spine/compaction.mjs compacts at `ratio` x
// the being's OWN model window: brainpool's afterTurn hands it def.model, and compact-being's
// MODEL_WINDOWS gives opus and sonnet 1M, haiku 200k. So kg's node 0.80 meant 800k tokens for an
// opus being and do's 0.65 meant 650k - barely before Claude Code's native autocompact (measured on
// kg: 934k-1,000k). The overrides written as "LOWER than the node, half the window" (wren and dren
// 2026-09-14, the rooms by 0022/0023) read 0.50 = 500k. Nothing was thin: the largest boxed session
// was 478k and none was due. (/status showed 160k because it assumed a 200k window for every
// conversation - a view bug, not the spine's number.)
//
// A. THE NODE: `compaction.ratio` -> 0.2, i.e. 200k on opus/sonnet, 40k on haiku, with a comment
//    saying so. Asked as a property: whatever it states now, unless it already states 0.2.
// B. THE META ENGINEERS: a being answering to `wren` or `dren` (router.mjs wakeTokens, never a map
//    key) gets `conversation_defaults.compaction.ratio: 0.8`. Their old block goes WITH the comment
//    above it (spliceYamlRemoveKey takes the comment lines at the key's column), because that
//    comment says "lower than the node" and beside a 0.2 node it would lie; the new block comes in
//    with its own.
// C. ACIM'S BEING: rooms.yaml `room/acim`, every being there that states a `compaction:`, -> 0.8,
//    by the same remove + insert. Named by the room's key, the operator's own word; `room/acim-do`
//    on do is a different room.
// D. EVERY OTHER ROOM OVERRIDE GOES: a being in any other rooms.yaml row that states `compaction:`
//    loses it, comment and all, and follows the node's thin ratio. On do that is `room/acim-do`
//    (don) and `room/dj-son` (pi). The operator named acim only; adding one back is one block.
//
// EACH PART IS INDEPENDENTLY SATISFIABLE, and "nothing to do" is SATISFIED, never refused (a refusal
// stops every later migration on the node). IT REFUSES only on a file that is not UTF-8 or does not
// parse, and a `compaction:` that is not a mapping where this has to edit one.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey, spliceYamlRemoveKey } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';

export const elevated = false;
export const summary = 'beings are kept thin: the node compacts at 0.2 of a being\'s window, the meta engineers and acim\'s room at 0.8, and every other room override goes';

const ID = '0028';
const THIN = 0.2;
const ROOMY = 0.8;
const META_HANDLES = ['wren', 'dren'];
const ACIM = 'room/acim';

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
// The column a mapping's own keys sit at, read off the ORIGINAL document (0025): a removal
// elsewhere moves offsets but never a surviving line's indent.
const columnOf = (f, path) => {
  const keyAt = f.doc.getIn(path, true).items[0].key.range[0];
  return ' '.repeat(keyAt - (f.text.lastIndexOf('\n', keyAt - 1) + 1));
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

// ── the text, AS IT WILL READ in the operator's file ─────────────────────────────────────────
const nodeLines = (pad) => [
  `${pad}# THIN (${ID}, operator 2026-09-24: "beings thin 0.2"; "the model is usually very good after`,
  `${pad}# an initial inspection. so frequent compacts is OK since the whole thing is in the transcript").`,
  `${pad}# A share of the being's OWN model window: 200k tokens on opus and sonnet (1M), 40k on haiku.`,
  `${pad}# The meta engineers (config.yaml) and acim's room (rooms.yaml) state their own, higher one.`,
  `${pad}ratio: ${THIN}`,
];
const metaLines = (pad) => [
  `${pad}# HIGHER THAN THE NODE (${ID}, operator 2026-09-24: "metaeng 0.8"). Beings are kept thin at`,
  `${pad}# the node's ${THIN}; a meta engineer's one node-wide thread keeps more of itself before it`,
  `${pad}# compacts: ${ROOMY} of its model's window, 800k tokens on a 1M one.`,
  `${pad}compaction:`,
  `${pad}  ratio: ${ROOMY}`,
];
const acimLines = (pad) => [
  `${pad}# HIGHER THAN THE NODE (${ID}, operator 2026-09-24: "acim has an acim-E, we can keep it at .8").`,
  `${pad}# Beings are kept thin at the node's ${THIN}; this room's being keeps more of its thread before`,
  `${pad}# it compacts: ${ROOMY} of its model's window, 800k tokens on a 1M one.`,
  `${pad}compaction:`,
  `${pad}  ratio: ${ROOMY}`,
];

// Plan the edits for ONE file onto its running text. Each unit is all-or-nothing; a unit that
// cannot be made is a note, and the file is left as it was for that unit.
function editor(f) {
  let text = f.text;
  const changes = [];
  const notes = [];
  const write = (edits, onFail) => {
    let t = text;
    const staged = [];
    for (const e of edits) {
      let next;
      try { next = e.fn(t); } catch (err) { notes.push(onFail(err?.message ?? String(err))); return false; }
      staged.push({ before: t, after: next, label: e.label });
      t = next;
    }
    text = t;
    for (const s of staged) changes.push(...rendered(f.file, s.before, s.after, s.label));
    return true;
  };
  return { write, changes, notes, text: () => text };
}

// Set `compaction.ratio` under `path` to `ratio`, replacing whatever block and comment is there.
function setBlock(f, ed, path, at, ratio, lines) {
  const block = f.doc.getIn(path, true);
  if (!YAML.isMap(block) || block.flow || !block.items.length) {
    ed.notes.push(`${at} in ${f.file} is not a block mapping this can write into - left as it is`);
    return;
  }
  const own = f.data && path.reduce((o, k) => (isMap(o) ? o[k] : undefined), f.data);
  const cur = own?.compaction;
  if (cur !== undefined && !isMap(cur)) refuse(`${at}.compaction in ${f.file} is ${show(cur)}, not a mapping - what a hand edit there meant will not be guessed`);
  if (cur?.ratio === ratio) { ed.notes.push(`${at}.compaction.ratio in ${f.file} is already ${ratio}`); return; }
  const pad = columnOf(f, path);
  const edits = [];
  if (cur !== undefined) edits.push({ label: `remove ${at}.compaction (ratio ${show(cur.ratio)}) with the comment above it`, fn: (t) => spliceYamlRemoveKey(t, path, { key: 'compaction' }) });
  edits.push({ label: `${at}.compaction.ratio: ${ratio}`, fn: (t) => spliceYamlInsertKey(t, path, { key: 'compaction', text: lines(pad).join('\n') }) });
  ed.write(edits, (why) => `${at}.compaction in ${f.file} cannot be rewritten as it is written (${why}) - left as it is`);
}

export async function plan(ctx) {
  const cfgFile = join(ctx.egptHome, 'config', 'config.yaml');
  const roomsFile = join(ctx.egptHome, 'config', 'rooms.yaml');
  if (!existsSync(cfgFile)) refuse(`there is no ${cfgFile}`);
  const files = [open(cfgFile), ...(existsSync(roomsFile) ? [open(roomsFile)] : [])];
  const [cfg, rooms] = files;
  const eds = new Map(files.map((f) => [f, editor(f)]));
  const notes = [];

  // ── A. the node ─────────────────────────────────────────────────────────────────────────────
  const ec = eds.get(cfg);
  const node = isMap(cfg.data) ? cfg.data.compaction : undefined;
  if (node === undefined) notes.push(`${cfgFile} states no \`compaction:\` block - the spine's built-in ratio applies and nothing is written here`);
  else if (!isMap(node)) refuse(`\`compaction:\` in ${cfgFile} is ${show(node)}, not a mapping`);
  else if (node.ratio === THIN) notes.push(`compaction.ratio in ${cfgFile} is already ${THIN}`);
  else {
    const pad = columnOf(cfg, ['compaction']);
    const after = Object.hasOwn(node, 'enabled') ? 'enabled' : null;
    const edits = [];
    if (Object.hasOwn(node, 'ratio')) edits.push({ label: `remove compaction.ratio ${show(node.ratio)}`, fn: (t) => spliceYamlRemoveKey(t, ['compaction'], { key: 'ratio' }) });
    edits.push({ label: `compaction.ratio: ${THIN} - beings are kept thin`, fn: (t) => spliceYamlInsertKey(t, ['compaction'], { key: 'ratio', text: nodeLines(pad).join('\n'), after }) });
    ec.write(edits, (why) => `compaction.ratio in ${cfgFile} cannot be rewritten as it is written (${why}) - left as it is`);
  }

  // ── B. the meta engineers ───────────────────────────────────────────────────────────────────
  const agents = isMap(cfg.data) && isMap(cfg.data.agents) ? cfg.data.agents : {};
  let metas = 0;
  for (const [name, a] of Object.entries(agents)) {
    if (String(name).startsWith('_') || !isMap(a)) continue;
    if (!wakeTokens(name, a).some((h) => META_HANDLES.includes(h))) continue;
    metas++;
    if (!isMap(a.conversation_defaults)) { notes.push(`agents.${name} in ${cfgFile} has no conversation_defaults mapping to state a ratio in - left as it is`); continue; }
    setBlock(cfg, ec, ['agents', name, 'conversation_defaults'], `agents.${name}.conversation_defaults`, ROOMY, metaLines);
  }
  if (!metas) notes.push(`no being on this node answers to [ ${META_HANDLES.join(', ')} ] - no meta engineer here to give a higher ratio`);

  // ── C and D. the rooms ──────────────────────────────────────────────────────────────────────
  if (rooms) {
    const er = eds.get(rooms);
    const rows = isMap(rooms.data) && isMap(rooms.data.rooms) ? rooms.data.rooms : {};
    for (const [row, entry] of Object.entries(rows)) {
      const beings = isMap(entry) && isMap(entry.agents) ? entry.agents : {};
      for (const [being, b] of Object.entries(beings)) {
        if (!isMap(b) || !Object.hasOwn(b, 'compaction')) continue;
        const path = ['rooms', row, 'agents', being];
        const at = `rooms.${row}.agents.${being}`;
        if (row === ACIM) { setBlock(rooms, er, path, at, ROOMY, acimLines); continue; }
        er.write([{ label: `remove ${at}.compaction (ratio ${show(b.compaction?.ratio)}) with the comment above it - this room follows the node's thin ratio`, fn: (t) => spliceYamlRemoveKey(t, path, { key: 'compaction' }) }],
          (why) => `${at}.compaction in ${roomsFile} cannot be taken out as it is written (${why}) - left as it is`);
      }
    }
  }

  const changed = files.filter((f) => eds.get(f).text() !== f.text);
  for (const f of files) notes.push(...eds.get(f).notes);
  if (!changed.length) return { satisfied: true, notes };
  const changes = files.flatMap((f) => eds.get(f).changes);
  changes.push(...notes, ...changed.map((f) => `backup first, beside it: ${f.file.split(/[\\/]/).pop()}.bak-${ID}-<timestamp>`));
  return {
    satisfied: false,
    changes,
    apply: async () => {
      for (const f of changed) if (!readFileSync(f.file).equals(f.bytes)) refuse(`${f.file} changed since it was planned - re-run`);
      for (const f of changed) {
        ctx.log(`backup: ${ctx.backup(f.file)}`);
        writeFileSync(f.file, eds.get(f).text(), 'utf8');
      }
    },
  };
}
