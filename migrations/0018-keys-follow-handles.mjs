// 0018 — a being's KEY follows its handle.
//
// Operator, 2026-09-20: nodes are independent — *"it's like a third party had installed egpt and it
// became a peer node: the key is decided by the user, most likely based on agent's handle."* kg is
// already key=handle throughout. do is not: it was built by COPYING kg's keys and renaming only the
// handles, so on do the being the operator calls `don` is still keyed `egpt`, `den` is keyed `ken`
// and `dren` is keyed `wren`. This is the one migration that closes that drift.
//
//   the being that answers to `don`   takes the key `don`
//   the being that answers to `den`   takes the key `den`
//   the being that answers to `dren`  takes the key `dren`
//
// `pi` (handle `pd`) and `djh` are DELIBERATELY LEFT ALONE — the operator excluded them, and this
// migration touches exactly the three handles in the map below.
//
// THE BEING IS FOUND BY ITS HANDLE, never by the map key, and that is the whole trap. "Does this
// being answer to `don`" is asked of src/spine/router.mjs's wakeTokens — THE definition of an
// agent's wake vocabulary, the same one 0011 and 0016 ask — and never re-implemented here. The
// handle→key MAP IS EXPLICIT AND CLOSED, never "rename every key to its first handle": kg has a
// being whose handle is `"+"`, and that rule would key it `+`. kg has no being answering to
// don/den/dren, so kg reads SATISFIED with a note.
//
// THE KEY IS THE BEING-ID (router.mjs's own header: it keys warm sessions and every per-conversation
// `entry[<being>]` thread block), so renaming it is only safe if every block keyed by it MOVES with
// it. A being that loses its block loses its THREAD, which is why every change line below names the
// threadId travelling with it, and why a rename here is a byte splice that MOVES the existing block
// rather than anything that writes a new one.
//
// WHAT MOVES, per rename, under $EGPT_HOME/config/:
//   1. config.yaml    `agents.<old>` → `agents.<new>`.
//   2. config.yaml    every `agents.*.scope: agent/<old>` → `agent/<new>` (on do: wren's own, line
//                     67, whose trailing comment NAMES the old being — a comment that lies is worse
//                     than none (0012), so spliceYamlScalar rewrites it in the same one-line edit).
//   3. conversations.yaml  every conversation row's own `agents:` container, per-being block.
//   4. conversations.yaml  the agent-scope bookkeeping row `contacts.agent.<old>` and its
//                     `conversation_path: .egpt/agents/<old>`.
//   5. rooms.yaml     the same per-room `agents:` blocks.
//   6. agents.yaml    BOTH the row key `agent/<old>` AND the per-being key inside that row's own
//                     `agents:` container.
//   7. $EGPT_HOME/agents/<old>/ → <new>/, the room folder that being wakes in.
//
// FOUR UNRELATED THINGS ARE SPELLED `agents` (src/rooms-file.mjs:38). (1) the agents.yaml registry
// file, (2) config.yaml's node-level agent registry, (3) the config/agents/*.yaml type files, and
// (4) a row's own container of per-being blocks — and (1) and (4) legitimately nest, which is why
// agents.yaml reads `agents: → agent/wren: → agents: → wren:`. So: conversations.yaml and rooms.yaml
// are WALKED for `agents:` containers (inside those two files an `agents:` map is always (4) —
// 0010's reading), while agents.yaml is walked PER ROW and never from its root, whose `agents:` is
// the registry itself.
//
// SATISFIED, NOT REFUSED — a refusal STOPS EVERY LATER MIGRATION on the node (setup/migrate.mjs, the
// 0003/0007/0011/0012 lesson): no `agents:` mapping; no being answering to any of the three handles
// (kg); and every one of them already keyed by its own handle (do, after this has run).
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: a config.yaml that is missing,
// not valid UTF-8 or does not parse; a registry file that does not parse (whether it holds a block
// to move cannot be read); MORE THAN ONE being answering to one handle, or ONE being answering to
// two of them (which key it takes is a human decision, not a guess); the target key already held by
// a DIFFERENT being, in config.yaml or in any block a rename would have to splice into; an agent-row
// field other than conversation_path still naming the old key (a half-rename is worse than a stop);
// and a destination room folder that already exists.
//
// THE EDITS ARE BYTE SPLICES (src/tools/config-io.mjs): spliceYamlKey for every key, spliceYamlScalar
// (with 0012's `comment`) for the two values that name a being. CRLF, alignment, every comment and
// every other byte are kept, and each splice re-parses to prove the edit is that one change and
// nothing else. Every file is checked for a change-since-planned, then backed up, then written — and
// the folder is RENAMED last, not copied, so nothing in it can be half-written.
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlKey, spliceYamlScalar } from '../src/tools/config-io.mjs';
import { wakeTokens } from '../src/spine/router.mjs';

export const elevated = false;
export const summary = 'a being\'s key follows its handle: the beings answering to `don`, `den` and `dren` take those keys, and every block, row and folder keyed by the old one moves with its thread';

// THE MAP: handle → the key that being takes. Explicit and closed, never derived from a being's
// handle list - see the header.
const KEY_BY_HANDLE = { don: 'don', den: 'den', dren: 'dren' };
// The two registry files whose `agents:` maps are always per-being containers (0010's reading).
const WALKED = ['conversations.yaml', 'rooms.yaml'];
// The agent-scope rung: `agents.<being>.scope: <surface>/<chatId>` (src/spine/identity-scope.mjs).
const SURFACE = 'agent';
const scopeComment = (to) => `one ${to} node-wide: every chat resolves to the same thread (0018 - the scope names the being, so it follows its key)`;

const refuse = (why) => { throw new Error(`0018 refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const splice = (what, fn) => { try { return fn(); } catch (e) { refuse(`${what}: ${e?.message ?? e}`); } };

function readUtf8(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  return { bytes, text };
}

// A registry file, or null when this node has never written one. A file that does not parse is
// refused: whether it holds a block that must move cannot be read, and leaving one behind is how a
// being loses its thread.
function registry(egptHome, name) {
  const file = join(egptHome, 'config', name);
  if (!existsSync(file)) return null;
  const { bytes, text } = readUtf8(file);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse (${doc.errors[0].message}), so whether it holds a being block cannot be read`);
  return { file, bytes, text, data: doc.toJS() };
}

// Every per-being container (`agents:` → <being>: …) under `node`, with the path to it. A walk, not
// fixed depths, so no shape a registry nests its rows in can slip past. `path` is the prefix the
// walk starts at - agents.yaml passes its ROW's path, so the registry's own root `agents:` is never
// mistaken for a container (src/rooms-file.mjs:38).
function beingContainers(node, path = []) {
  const out = [];
  if (!isMap(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    const here = [...path, k];
    if (k === 'agents' && isMap(v)) out.push({ path: here, beings: v });
    out.push(...beingContainers(v, here));
  }
  return out;
}

// A key rename and a scalar rewrite are each ONE line. The changed line is read off the two texts
// rather than guessed, and anything else is refused rather than described wrongly.
function oneLineDiff(before, after, what) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length !== b.length) refuse(`${what} would change the line count of the file, not one line`);
  const at = a.flatMap((l, i) => (l === b[i] ? [] : [i]));
  if (at.length !== 1) refuse(`${what} would change ${at.length} lines, not one`);
  return { line: at[0] + 1, from: a[at[0]].replace(/\r$/, ''), to: b[at[0]].replace(/\r$/, '') };
}

// Does the scalar at `path` carry an end-of-line comment to rewrite? Read off the TEXT the splice is
// about to edit: a comment is not part of the parse, and spliceYamlScalar rewrites a comment, it
// never invents one (0012/0014/0016 read it the same way).
function documentedAt(text, path) {
  const doc = YAML.parseDocument(text);
  const end = doc.getIn(path, true).range[1];
  const nl = text.indexOf('\n', end);
  return /^[ \t]*#/.test(text.slice(end, nl === -1 ? text.length : nl));
}

const thread = (record) => (isMap(record) && record.threadId != null
  ? `threadId ${record.threadId} moves with the block`
  : 'no threadId in this block');

export async function plan(ctx) {
  const handles = Object.keys(KEY_BY_HANDLE);
  const configFile = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(configFile)) refuse(`there is no ${configFile}`);
  const cfg = readUtf8(configFile);
  const cfgDoc = YAML.parseDocument(cfg.text);
  if (cfgDoc.errors.length) refuse(`${configFile} does not parse: ${cfgDoc.errors[0].message}`);
  const agents = cfgDoc.toJS()?.agents;
  if (!isMap(agents)) {
    return { satisfied: true, notes: [`${configFile} has no \`agents:\` mapping, so no being here answers to \`${handles.join('`, `')}\``] };
  }

  // ── WHO, asked by HANDLE ──────────────────────────────────────────────────────────────────
  const entries = Object.entries(agents).filter(([n, a]) => isMap(a) && !n.startsWith('_'));
  const renames = [];
  const notes = [];
  for (const [handle, to] of Object.entries(KEY_BY_HANDLE)) {
    const answering = entries.filter(([name, a]) => wakeTokens(name, a).includes(handle)).map(([name]) => name);
    if (!answering.length) { notes.push(`no being in ${configFile} answers to \`${handle}\``); continue; }
    if (answering.length > 1) {
      refuse(`${answering.length} beings in ${configFile} answer to \`${handle}\` (${answering.join(', ')}) - which one takes the key \`${to}\` is a human decision, not a guess`);
    }
    const from = answering[0];
    const already = renames.find((r) => r.from === from);
    if (already) {
      refuse(`agents.${from} answers to both \`${already.handle}\` and \`${handle}\` in ${configFile} - which key it takes is a human decision, not a guess`);
    }
    if (from === to) { notes.push(`agents.${to} answers to \`${handle}\` and is already keyed by it`); continue; }
    if (Object.hasOwn(agents, to)) {
      refuse(`agents.${from} answers to \`${handle}\`, but ${configFile} already has a DIFFERENT being keyed \`${to}\` (handles [ ${wakeTokens(to, agents[to]).join(', ')} ]) - which of the two owns that key, and what becomes of its threads, is a human decision`);
    }
    renames.push({ handle, from, to });
  }
  if (!renames.length) return { satisfied: true, notes };

  const changes = [];
  const write = new Map();     // file -> { bytes, next }
  const moves = [];            // [from, to] room folders

  // ── 1+2. config.yaml: the being's own key, then every scope that names a room it is moving ──
  let cfgNext = cfg.text;
  for (const { handle, from, to } of renames) {
    const before = cfgNext;
    cfgNext = splice(`renaming agents.${from} to \`${to}\` in ${configFile}`, () => spliceYamlKey(before, ['agents'], { from, to }));
    const d = oneLineDiff(before, cfgNext, `renaming agents.${from} in ${configFile}`);
    changes.push(`${configFile}:${d.line}  agents.${from} -> agents.${to}  (the being that answers to \`${handle}\`)`, `  - ${d.from}`, `  + ${d.to}`);
  }
  // The key each being sits under NOW - a being whose own key just moved is addressed by the new one.
  const keyNow = (name) => renames.find((r) => r.from === name)?.to ?? name;
  for (const { from, to } of renames) {
    for (const [name, a] of entries) {
      if (a.scope !== `${SURFACE}/${from}`) continue;
      const at = ['agents', keyNow(name), 'scope'];
      const before = cfgNext;
      const documented = documentedAt(before, at);
      cfgNext = splice(`repointing agents.${keyNow(name)}.scope in ${configFile}`, () => spliceYamlScalar(before, at, {
        expect: `${SURFACE}/${from}`, to: `${SURFACE}/${to}`, ...(documented ? { comment: scopeComment(to) } : {}),
      }));
      const d = oneLineDiff(before, cfgNext, `repointing agents.${keyNow(name)}.scope in ${configFile}`);
      changes.push(`${configFile}:${d.line}  agents.${keyNow(name)}.scope names the conversation that is moving`, `  - ${d.from}`, `  + ${d.to}`);
    }
  }
  write.set(configFile, { bytes: cfg.bytes, next: cfgNext });

  // ── 3+5. conversations.yaml and rooms.yaml: every per-being block, and the agent-scope row ──
  for (const name of WALKED) {
    const reg = registry(ctx.egptHome, name);
    if (!reg) continue;
    let next = reg.text;

    for (const { path, beings } of beingContainers(reg.data)) {
      for (const { from, to } of renames) {
        if (!Object.hasOwn(beings, from)) continue;
        const at = [...path, from].join('.');
        const before = next;
        next = splice(`moving ${at} to \`${to}\` in ${reg.file}`, () => spliceYamlKey(before, path, { from, to }));
        const d = oneLineDiff(before, next, `moving ${at} in ${reg.file}`);
        changes.push(`${reg.file}:${d.line}  ${at} -> ${to}  (${thread(beings[from])})`);
      }
    }

    // The agent-scope bookkeeping row itself: `contacts.agent.<being>`. Its conversation_path names
    // the folder being renamed below, so it is rewritten FIRST, while the row still has the old key.
    const rows = name === 'conversations.yaml' ? reg.data?.contacts?.[SURFACE] : null;
    if (isMap(rows)) {
      for (const { from, to } of renames) {
        const row = rows[from];
        if (!isMap(row)) continue;
        const at = ['contacts', SURFACE, from];
        const here = at.join('.');
        for (const [k, v] of Object.entries(row)) {
          if (k === 'conversation_path' || typeof v !== 'string') continue;
          if (v === from || v.split(/[\\/]/).includes(from)) {
            refuse(`${here}.${k} is ${JSON.stringify(v)} in ${reg.file} - it names the being by its old key, and what it should say instead is a human decision, not a guess`);
          }
        }
        const folder = row.conversation_path;
        if (typeof folder === 'string') {
          if (!folder.endsWith(`/${from}`)) {
            refuse(`${here}.conversation_path is ${JSON.stringify(folder)} in ${reg.file}, which does not end in \`/${from}\` - where the room moves to is a human decision, not a guess`);
          }
          const before = next;
          const moved = `${folder.slice(0, -from.length)}${to}`;
          const documented = documentedAt(before, [...at, 'conversation_path']);
          next = splice(`repointing ${here}.conversation_path in ${reg.file}`, () => spliceYamlScalar(before, [...at, 'conversation_path'], {
            expect: folder, to: moved, ...(documented ? { comment: 'the room this being wakes in, renamed with its key (0018)' } : {}),
          }));
          const d = oneLineDiff(before, next, `repointing ${here}.conversation_path in ${reg.file}`);
          changes.push(`${reg.file}:${d.line}  ${here}.conversation_path follows the folder`, `  - ${d.from}`, `  + ${d.to}`);
        }
        const before = next;
        next = splice(`moving ${here} to \`${to}\` in ${reg.file}`, () => spliceYamlKey(before, ['contacts', SURFACE], { from, to }));
        const d = oneLineDiff(before, next, `moving ${here} in ${reg.file}`);
        changes.push(`${reg.file}:${d.line}  ${here} -> ${to}  (the agent-scope row: ${Object.keys(row).join(', ')})`);
      }
    }

    if (next !== reg.text) write.set(reg.file, { bytes: reg.bytes, next });
  }

  // ── 6. agents.yaml: the row key AND the per-being key inside the row's own container ──────────
  const rung = registry(ctx.egptHome, 'agents.yaml');
  if (rung && isMap(rung.data?.agents)) {
    const rows = rung.data.agents;
    let next = rung.text;
    // Inside each ROW first - never from the root, whose `agents:` is the registry itself - so the
    // paths the walk read are still the ones in the file when the row key moves below.
    for (const [rowKey, row] of Object.entries(rows)) {
      for (const { path, beings } of beingContainers(row, ['agents', rowKey])) {
        for (const { from, to } of renames) {
          if (!Object.hasOwn(beings, from)) continue;
          const at = [...path, from].join('.');
          const before = next;
          next = splice(`moving ${at} to \`${to}\` in ${rung.file}`, () => spliceYamlKey(before, path, { from, to }));
          const d = oneLineDiff(before, next, `moving ${at} in ${rung.file}`);
          changes.push(`${rung.file}:${d.line}  ${at} -> ${to}  (${thread(beings[from])})`);
        }
      }
    }
    for (const { from, to } of renames) {
      const rowKey = `${SURFACE}/${from}`;
      if (!Object.hasOwn(rows, rowKey)) continue;
      const before = next;
      next = splice(`moving agents.${rowKey} to \`${SURFACE}/${to}\` in ${rung.file}`, () => spliceYamlKey(before, ['agents'], { from: rowKey, to: `${SURFACE}/${to}` }));
      const d = oneLineDiff(before, next, `moving agents.${rowKey} in ${rung.file}`);
      changes.push(`${rung.file}:${d.line}  agents.${rowKey} -> ${SURFACE}/${to}  (the agent-scope row of the registry)`);
    }
    if (next !== rung.text) write.set(rung.file, { bytes: rung.bytes, next });
  }

  // ── 7. the room folder the being wakes in ────────────────────────────────────────────────────
  for (const { from, to } of renames) {
    const dir = join(ctx.egptHome, 'agents', from);
    if (!existsSync(dir)) continue;
    const dest = join(ctx.egptHome, 'agents', to);
    if (existsSync(dest)) {
      refuse(`${dest} already exists, so ${dir} cannot move onto it - which of the two is this being's room is a human decision`);
    }
    moves.push([dir, dest]);
    changes.push(`move ${dir} -> ${dest}  (the room it wakes in, holding: ${readdirSync(dir).sort().join(', ')})`);
  }

  for (const { handle, from, to } of renames) {
    changes.push(`agents.${from} answers to \`${handle}\`, so its key becomes \`${to}\` - every block above MOVES, none is recreated, and no thread is dropped`);
  }
  changes.push('backup first, beside each: <file>.bak-0018-<timestamp>  (the folder is renamed, not copied)');

  return {
    satisfied: false,
    changes,
    apply: async () => {
      // Every file and both ends of every move are checked BEFORE anything is written: a rename that
      // lands in config.yaml but not in conversations.yaml is a being without its threads.
      for (const [file, { bytes }] of write) {
        if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      }
      for (const [dir, dest] of moves) {
        if (!existsSync(dir)) refuse(`${dir} is gone since it was planned - re-run`);
        if (existsSync(dest)) refuse(`${dest} appeared since it was planned - re-run`);
      }
      for (const [file, { next }] of write) {
        ctx.log(`backup: ${ctx.backup(file)}`);
        writeFileSync(file, next, 'utf8');
      }
      for (const [dir, dest] of moves) {
        renameSync(dir, dest);
        ctx.log(`moved ${dir} -> ${dest}`);
      }
    },
  };
}
