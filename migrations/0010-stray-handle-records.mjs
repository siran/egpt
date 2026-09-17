// 0010 — the stray handle-named being records.
//
// `/agents <verb> <handle>` used the operator's WORD as the being KEY it wrote (src/spine/
// commands.mjs, agentsCmd's `handles = [handleArg]`, fixed 2026-09-17). On kg, where E is KEYED
// `egpt` and declares `handles: [e, egpt, ekg, egptkg]`, `/agents rethread e` therefore made a
// record named `e` — patchBeing invents one when it is absent — cleared threadId on THAT, rolled
// the chat's transcript.md into transcripts/ and answered ✅, while E kept its thread.
//
// What it left behind is the only trace: a being record named after a HANDLE, holding nothing but
// `threadId: null`. Measured by the operator on kg, 2026-09-17: config/rooms.yaml has exactly one,
// `      e:` with the single child `        threadId: null`, under `room/lobby:` → `agents:`,
// directly after the real `egpt:` block (threadId / threadCreatedAt / identityInjectedAt). The
// file is CRLF. Nothing else on kg, and do has none, so do reads satisfied.
//
// WHAT IT REMOVES, and the three conditions are all of it: a record in a conversation/room entry's
// `agents:` block whose key is NOT an agent key in config.yaml, IS a declared `handles:` token of
// one of those agents (so this bug is what created it — nothing else writes a handle-named record),
// and holds ONLY `threadId: null` (no thread, so there is nothing to lose). A being record that is
// neither an agent key nor anybody's handle — `wren` seeded by a turn on a node that does not
// configure it — is a REAL record and is left alone; it is not what this bug produced.
//
// IT REFUSES, NAMING THE RECORD, for anything else that matches the first two conditions: a
// handle-named record carrying a real threadId, or any other field. That is a record with state in
// it, and whether it is merged into the being it names or simply dropped is a human decision.
//
// SATISFIED FIRST: no such record in either file. A node with none is never refused over anything
// else it happens to contain.
//
// The edit is a byte splice (src/tools/config-io.mjs spliceYamlRemoveKey): the record's lines and
// the comment lines directly above it at its column go, every other byte — CRLF, the sibling
// `egpt:` block, every other room — is kept, and the result is verified to re-parse to the document
// minus that key.
//
// SCOPE is the two REGISTRY files the operator measured, config/rooms.yaml and
// config/conversations.yaml — the two that hold per-conversation being blocks for the surfaces
// /agents reaches. config/agents.yaml (the `agent/<name>` rung) is not scanned: no stray record was
// measured there, and a migration should not go looking in a place the evidence does not name.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlRemoveKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'remove the stray handle-named being records left by /agents writing the typed handle as the being key (a block holding only threadId: null)';

const refuse = (why) => { throw new Error(`0010 refuses: ${why}`); };

// The two registry files that carry per-conversation `agents:` blocks (src/rooms-file.mjs:
// `rooms: → room/<slug>: → agents: → <being>:`; conversations.yaml: `contacts: → <surface>: →
// <jid>: → agents: → <being>:`). Missing is fine — a node that has never written one has none.
const REGISTRIES = ['rooms.yaml', 'conversations.yaml'];

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Every `agents:` block in a parsed registry, with the PATH to it — a walk, not fixed depths, so
// no nesting a registry uses can slip past. (The `agents` spelling collides four ways in this tree
// — see src/rooms-file.mjs — but neither of these two files carries the node-level agent REGISTRY,
// so inside them an `agents:` map is always a container of per-being blocks.)
function agentBlocks(data) {
  const out = [];
  const walk = (node, path) => {
    if (!isMap(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const here = [...path, k];
      if (k === 'agents' && isMap(v)) out.push({ path: here, beings: v });
      walk(v, here);
    }
  };
  walk(data, []);
  return out;
}

// A record this bug produced holds NOTHING but `threadId: null` — that is what makes it safe to
// drop rather than a decision: no thread, no mode, no access_level, nothing an operator set.
const isEmptyThreadRecord = (v) => isMap(v)
  && Object.keys(v).length === 1
  && Object.hasOwn(v, 'threadId')
  && v.threadId == null;

// The lines one splice took out, read off the two texts rather than guessed — same rendering 0009
// uses, so a `changes` list reads identically across migrations.
function removedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length - b.length;
  let s = 0;
  while (s < b.length && a[s] === b[s]) s++;
  return { first: s + 1, last: s + n, lines: a.slice(s, s + n).map((l) => l.replace(/\r$/, '')) };
}

function readUtf8(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  return { bytes, text };
}

export async function plan(ctx) {
  const configFile = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(configFile)) refuse(`there is no ${configFile}, so an agent KEY cannot be told from a HANDLE`);
  const cfgDoc = YAML.parseDocument(readUtf8(configFile).text);
  if (cfgDoc.errors.length) refuse(`${configFile} does not parse: ${cfgDoc.errors[0].message}`);
  const agents = cfgDoc.toJS()?.agents;
  const configured = isMap(agents) ? Object.entries(agents).filter(([n, a]) => isMap(a) && !n.startsWith('_')) : [];
  // THE TWO SETS this migration turns on. `keys` is what a being record is legitimately named
  // after (the being-id). `handles` is DECLARED handles only — when `handles:` is absent the key
  // serves as the handle (router.mjs wakeTokens) and is therefore already in `keys`, so a record
  // named after it is a real record, not this bug's leavings.
  const keys = new Set(configured.map(([n]) => n.toLowerCase()));
  const handles = new Set(configured.flatMap(([, a]) => (Array.isArray(a.handles) ? a.handles : [])).map((h) => String(h).trim().toLowerCase()));

  const files = REGISTRIES.map((f) => join(ctx.egptHome, 'config', f)).filter((f) => existsSync(f));
  const strays = [];       // removable: holds only threadId: null
  const held = [];         // handle-named but carrying state — a human decision
  const source = new Map();
  for (const file of files) {
    const { bytes, text } = readUtf8(file);
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) refuse(`${file} does not parse (${doc.errors[0].message}), so whether it holds a stray record cannot be read`);
    source.set(file, { bytes, text });
    for (const { path, beings } of agentBlocks(doc.toJS())) {
      for (const [being, record] of Object.entries(beings)) {
        const lower = being.toLowerCase();
        if (keys.has(lower) || !handles.has(lower)) continue;             // a real being-id, or nobody's handle
        const label = `${file}: ${[...path, being].join('.')}`;
        if (isEmptyThreadRecord(record)) strays.push({ file, path, being, label });
        else held.push(`${label} = ${JSON.stringify(record)}`);
      }
    }
  }

  if (!strays.length && !held.length) {
    return { satisfied: true, notes: [`no handle-named being record in ${REGISTRIES.map((f) => `config/${f}`).join(' or ')} — nothing to remove`] };
  }
  if (held.length) {
    refuse(`these records are named after a handle but hold more than an empty thread, so dropping one could lose a live thread — a human decision: ${held.join('; ')}`);
  }

  // One splice per record, each applied to the previous result, so a file with two of them is
  // planned and written exactly once.
  const changes = [];
  const next = new Map();
  for (const { file, path, being, label } of strays) {
    const before = next.get(file) ?? source.get(file).text;
    let after;
    try { after = spliceYamlRemoveKey(before, path, { key: being }); }
    catch (e) { refuse(`${label} cannot be spliced out (${e?.message ?? e})`); }
    next.set(file, after);
    const { first, last, lines } = removedLines(before, after);
    const described = lines[0]?.trimStart().startsWith('#') ? ' and the comment above it' : '';
    changes.push(`${file}:${first}-${last}  remove ${[...path, being].join('.')}${described} (${lines.length} lines):`, ...lines.map((l) => `  - ${l}`));
  }
  changes.push('backup first, beside each: <file>.bak-0010-<timestamp>');

  return {
    satisfied: false,
    changes,
    apply: async () => {
      for (const file of next.keys()) {
        if (!readFileSync(file).equals(source.get(file).bytes)) refuse(`${file} changed since it was planned - re-run`);
      }
      for (const [file, text] of next) {
        ctx.log(`backup: ${ctx.backup(file)}`);
        writeFileSync(file, text, 'utf8');
      }
    },
  };
}
