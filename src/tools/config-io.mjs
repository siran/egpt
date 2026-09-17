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
import { isDeepStrictEqual } from 'node:util';
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

// ─── THE SPLICE: edit config TEXT by replacing only the bytes of ONE node ─────────────────
//
// For migrations (migrations/NNNN-*.mjs), which rewrite an operator's config on a live node.
// Those configs are roughly half comments, and the comments are the operator's recorded
// rulings. MEASURED 2026-09-16 on the kg config with yaml 2.9.0: a no-op
// `parseDocument(src).toString()` already rewrites the file (255 lines came back as 274):
// end-of-line comments move onto their own line and long flow lists explode, and tuning
// toString's options made it worse (261 differing lines). So nothing here ever serializes a
// document. It parses only to find a node's source range, then replaces exactly those
// characters; CRLF, alignment, comments and every other byte are untouched because they are
// never re-emitted.
//
// Every edit is ASSERTED on both sides: before, the node must be what the caller says it is
// (otherwise refuse, naming the path); after, the edited text must re-parse to exactly the old
// data with that one change and nothing else (otherwise refuse - e.g. a new plain value that
// YAML would read as a number). A refusal throws YamlSpliceRefusal and returns no text, so a
// caller can never write a half-checked edit.
//
// What a splice CANNOT do is insert structure (a new key, a new block): that is new text with
// an indentation and a place to live, not a range to replace. There is deliberately no
// toString() fallback for it.
export class YamlSpliceRefusal extends Error {
  constructor(message) { super(message); this.name = 'YamlSpliceRefusal'; }
}

const pathLabel = (path) => (path.length ? path.map(String).join('.') : '(root)');

function parseForSplice(src, label) {
  const doc = YAML.parseDocument(src, { keepSourceTokens: true });
  if (doc.errors.length) throw new YamlSpliceRefusal(`refusing to edit ${label}: the YAML does not parse (${doc.errors[0].message})`);
  return doc;
}

// The new value written in the SAME scalar style as the text it replaces, so a plain value
// stays plain and a quoted one stays quoted. Block scalars (| and >) span lines and are refused.
function renderLike(node, value, label) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new YamlSpliceRefusal(`refusing to edit ${label}: only a string, number or boolean can be spliced, got ${typeof value}`);
  }
  const s = String(value);
  if (node.type === 'PLAIN') return s;
  if (node.type === 'QUOTE_DOUBLE') return JSON.stringify(s);
  if (node.type === 'QUOTE_SINGLE') return `'${s.replace(/'/g, "''")}'`;
  throw new YamlSpliceRefusal(`refusing to edit ${label}: it is a ${node.type} scalar; only plain and quoted scalars are spliced`);
}

function verifySplice(next, expectedData, label) {
  const doc = YAML.parseDocument(next);
  if (doc.errors.length) throw new YamlSpliceRefusal(`refusing to edit ${label}: the edited text no longer parses (${doc.errors[0].message})`);
  if (!isDeepStrictEqual(doc.toJS(), expectedData)) {
    throw new YamlSpliceRefusal(`refusing to edit ${label}: the edited text does not re-parse to the intended change alone`);
  }
  return next;
}

// Replace the scalar VALUE at `path` (map keys and sequence indexes, e.g.
// ['transcription_service', 'reve', 'fallback_order', 0]). `expect` is what it must hold now;
// anything else is refused by name. expect === to returns `src` unchanged, byte for byte.
//
// `comment`, when given, rewrites the END-OF-LINE COMMENT on that same line to `# <comment>`.
// A value that NAMES something - `configuration: haiku-low # config/agents/haiku-low.yaml` - is
// documented by its own trailing comment, so repointing the value alone leaves a comment naming
// the OLD thing, and a comment that lies is worse than none (migrations/0012). It stays the same
// ONE-LINE edit: the whitespace before the `#` is kept, everything outside that line is untouched,
// and because a comment is not part of the parse the re-parse check below still proves the DATA
// change is the one scalar and nothing else. A line carrying no trailing comment is refused - this
// rewrites a comment, it does not invent one.
export function spliceYamlScalar(src, path, { expect, to, comment }) {
  const label = pathLabel(path);
  const doc = parseForSplice(src, label);
  const node = doc.getIn(path, true);
  if (node === undefined) throw new YamlSpliceRefusal(`refusing to edit ${label}: there is no such node`);
  if (!YAML.isScalar(node)) throw new YamlSpliceRefusal(`refusing to edit ${label}: it is a ${node?.constructor?.name ?? typeof node}, not a scalar`);
  if (node.value !== expect) {
    throw new YamlSpliceRefusal(`refusing to edit ${label}: expected ${JSON.stringify(expect)}, found ${JSON.stringify(node.value)}`);
  }
  if (to === expect && comment === undefined) return src;
  const text = renderLike(node, to, label);
  const [start, end] = node.range;
  // Where the bytes this edit does not touch resume, and what takes their place before that: the
  // value's own line up to its newline when a comment is being rewritten, nothing otherwise.
  let tail = end;
  let tailText = '';
  if (comment !== undefined) {
    if (typeof comment !== 'string' || /[\r\n]/.test(comment)) {
      throw new YamlSpliceRefusal(`refusing to edit ${label}: a trailing comment is one line of text, got ${JSON.stringify(comment)}`);
    }
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : (src[nl - 1] === '\r' ? nl - 1 : nl);
    const gap = /^([ \t]*)#/.exec(src.slice(end, lineEnd));
    if (!gap) throw new YamlSpliceRefusal(`refusing to edit ${label}: its line carries no trailing comment to rewrite`);
    tail = lineEnd;
    tailText = `${gap[1]}# ${comment}`;
  }
  const expected = doc.toJS();
  let parent = expected;
  for (const k of path.slice(0, -1)) parent = parent[k];
  parent[path[path.length - 1]] = to;
  return verifySplice(src.slice(0, start) + text + tailText + src.slice(tail), expected, label);
}

// Rename the KEY `from` to `to` inside the mapping at `mapPath` ([] is the document root). A
// key is a node with its own range, so this is the same splice: the value, its comments and
// the key's position in the map are untouched. Refused when `from` is absent or `to` exists.
export function spliceYamlKey(src, mapPath, { from, to }) {
  const label = `${pathLabel([...mapPath, from])} -> ${to}`;
  const doc = parseForSplice(src, label);
  const map = mapPath.length ? doc.getIn(mapPath, true) : doc.contents;
  if (!YAML.isMap(map)) throw new YamlSpliceRefusal(`refusing to rename ${label}: ${pathLabel(mapPath)} is not a mapping`);
  const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : undefined);
  const pair = map.items.find((p) => keyOf(p) === from);
  if (!pair) throw new YamlSpliceRefusal(`refusing to rename ${label}: ${pathLabel(mapPath)} has no key ${JSON.stringify(from)}`);
  if (map.items.some((p) => keyOf(p) === to)) {
    throw new YamlSpliceRefusal(`refusing to rename ${label}: ${pathLabel(mapPath)} already has a key ${JSON.stringify(to)}`);
  }
  const text = renderLike(pair.key, to, label);
  const [start, end] = pair.key.range;
  const expected = doc.toJS();
  const parent = mapPath.reduce((o, k) => o[k], expected);
  parent[to] = parent[from];
  delete parent[from];
  return verifySplice(src.slice(0, start) + text + src.slice(end), expected, label);
}

// ── WHOLE-LINE geometry, shared by the two splices below that work in LINES rather than in node
// ranges (remove and insert). One definition each, so "where does this entry's block end" has the
// same answer whichever direction the edit goes.
//
// lineEndAt: just past the newline that ends the line containing `i`.
// commentColAt: the column of a comment that is the ONLY thing on the line src[from..to), else -1.
// contentEnd: just past a node's last CONTENT character — a node's own range runs on through the
//   trailing comments up to the next key, so the end is the last content node's value end.
const lineEndAt = (src, i) => { const n = src.indexOf('\n', i); return n === -1 ? src.length : n + 1; };
const commentColAt = (src, from, to) => { const m = /^( *)#/.exec(src.slice(from, to)); return m ? m[1].length : -1; };
const contentEnd = (node) => {
  if (YAML.isPair(node)) return contentEnd(node.value ?? node.key);
  if ((YAML.isMap(node) || YAML.isSeq(node)) && !node.flow && node.items.length) return contentEnd(node.items[node.items.length - 1]);
  return node.range[1];
};
// Where `pair`'s own LINES end: the line its last content sits on (so an end-of-line comment goes
// with it), plus the comment lines indented INSIDE the block (deeper than `col`, the column its key
// sits at). A blank line, and a comment at the key's own column, describe what comes NEXT.
const blockLinesEnd = (src, pair, col) => {
  let end = lineEndAt(src, contentEnd(pair) - 1);
  while (end < src.length) {
    const next = lineEndAt(src, end);
    if (!(commentColAt(src, end, next) > col)) break;
    end = next;
  }
  return end;
};

// Remove the KEY `key` from the block mapping at `mapPath` ([] is the document root), as the entry
// reads in the file: the comment lines directly above the key at its own column (what describes
// it - YAML hands those same lines to the key as its commentBefore), the key's line, every line of
// its value, and comment lines indented inside the block after its last value. The cut is whole
// lines, so an end-of-line comment goes with its line. Kept: blank lines, a comment separated from
// the key by one, and everything after the block at or left of the key's column - the next key and
// the comment that describes IT.
//
// Where the value ENDS is read off the parse, not the text: a node's own range runs on through the
// trailing comments up to the next key, so the end is the last CONTENT node's value end. A flow map
// is refused (its entries share a line), and so is a result that does not re-parse to the document
// minus that key - removing a map's only key leaves `null`, not `{}`.
export function spliceYamlRemoveKey(src, mapPath, { key }) {
  const label = pathLabel([...mapPath, key]);
  const doc = parseForSplice(src, label);
  const map = mapPath.length ? doc.getIn(mapPath, true) : doc.contents;
  if (!YAML.isMap(map)) throw new YamlSpliceRefusal(`refusing to remove ${label}: ${pathLabel(mapPath)} is not a mapping`);
  if (map.flow) throw new YamlSpliceRefusal(`refusing to remove ${label}: ${pathLabel(mapPath)} is a flow mapping`);
  const pair = map.items.find((p) => YAML.isScalar(p.key) && p.key.value === key);
  if (!pair) throw new YamlSpliceRefusal(`refusing to remove ${label}: ${pathLabel(mapPath)} has no key ${JSON.stringify(key)}`);

  const lineStart = (i) => src.lastIndexOf('\n', i - 1) + 1;

  let start = lineStart(pair.key.range[0]);
  const col = pair.key.range[0] - start;
  while (start > 0) {
    const prev = lineStart(start - 1);
    if (commentColAt(src, prev, start) !== col) break;
    start = prev;
  }
  const end = blockLinesEnd(src, pair, col);

  const expected = doc.toJS();
  delete mapPath.reduce((o, k) => o[k], expected)[key];
  return verifySplice(src.slice(0, start) + src.slice(end), expected, label);
}

// ─── THE INSERTION: add ONE key to a block mapping, as the TEXT the caller wrote ─────────────
//
// The three splices above REPLACE a range; this one adds a key that is not there yet. That is new
// text with an indentation and a place to live, not a range to replace - so the CALLER writes the
// lines: its comment block, its alignment, its quoting, exactly as they are to read in the
// operator's file. Nothing here is serialized from data, for the reason the splice header gives.
//
// It exists because without it a config ADDITION is hand-applied on every node, one node at a time
// and forgotten on the other - the drift setup/migrate.mjs was written to end (operator
// 2026-09-16: "nothing should be hand-applied, everything structural").
//
// `text` is the block AS IT WILL READ - comment lines, the key line, its value lines - ALREADY
// indented for this map. It must parse ON ITS OWN to exactly the one key `key`, and every line of
// it must sit at this map's column or deeper. A block indented for a different map is how an
// insertion silently nests a being inside its neighbour, so that is refused, not fixed up.
//
// `after` names the sibling it goes behind; null (the default) means last. The point is the end of
// that sibling's own LINES - its last content line, plus the comment lines indented inside it: the
// SAME reading spliceYamlRemoveKey uses, so where one takes a block out is where the other puts one
// back. A blank line, and a comment at the siblings' own column, describe what comes NEXT and stay
// after the inserted block.
//
// Line endings are the file's own (CRLF on kg), nothing outside the inserted lines moves, and the
// result must re-parse to the whole document plus exactly this one key.
export function spliceYamlInsertKey(src, mapPath, { key, text, after = null }) {
  const label = pathLabel([...mapPath, key]);
  const doc = parseForSplice(src, label);
  const map = mapPath.length ? doc.getIn(mapPath, true) : doc.contents;
  if (!YAML.isMap(map)) throw new YamlSpliceRefusal(`refusing to insert ${label}: ${pathLabel(mapPath)} is not a mapping`);
  if (map.flow) throw new YamlSpliceRefusal(`refusing to insert ${label}: ${pathLabel(mapPath)} is a flow mapping`);
  const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : undefined);
  if (map.items.some((p) => keyOf(p) === key)) {
    throw new YamlSpliceRefusal(`refusing to insert ${label}: ${pathLabel(mapPath)} already has a key ${JSON.stringify(key)}`);
  }
  const sibling = after == null ? map.items[map.items.length - 1] : map.items.find((p) => keyOf(p) === after);
  if (!sibling) throw new YamlSpliceRefusal(`refusing to insert ${label}: ${pathLabel(mapPath)} has no key ${JSON.stringify(after)} to insert after`);

  const indent = blockIndent(map, src);
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const blockText = `${lines.join('\n')}\n`;
  const blockDoc = YAML.parseDocument(blockText);
  if (blockDoc.errors.length) throw new YamlSpliceRefusal(`refusing to insert ${label}: the text does not parse (${blockDoc.errors[0].message})`);
  if (!YAML.isMap(blockDoc.contents) || blockDoc.contents.items.length !== 1 || keyOf(blockDoc.contents.items[0]) !== key) {
    throw new YamlSpliceRefusal(`refusing to insert ${label}: the text must be exactly the one key ${JSON.stringify(key)}`);
  }
  const keyAt = blockDoc.contents.items[0].key.range[0];
  const keyCol = keyAt - (blockText.lastIndexOf('\n', keyAt - 1) + 1);
  if (keyCol !== indent || lines.some((l) => l.trim() && /^ */.exec(l)[0].length < indent)) {
    throw new YamlSpliceRefusal(`refusing to insert ${label}: the text must be indented ${indent} spaces for ${pathLabel(mapPath)}, not ${keyCol}`);
  }

  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const at = blockLinesEnd(src, sibling, indent);
  const lead = at > 0 && src[at - 1] !== '\n' ? nl : '';
  const expected = doc.toJS();
  const parent = mapPath.reduce((o, k) => o[k], expected);
  parent[key] = blockDoc.toJS()[key];
  return verifySplice(src.slice(0, at) + lead + lines.join(nl) + nl + src.slice(at), expected, label);
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
