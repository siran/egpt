// 0024 — the room that translates hands its work out, to a folder the operator already approved.
//
// f74cfee shipped the mechanism: a being drops finished files in its room's `outbox/` and the
// SPINE — which runs as the operator and can therefore see drives a sandboxed pool account cannot
// — moves them to one approved destination (src/room-outbox.mjs). It shipped switched OFF, because
// nothing in any profile names a destination yet. This migration is the configuration half: it
// writes the two keys that turn it on for the one room and the one node that measured the need.
//
// THE MEASUREMENT THAT CAUSED IT (2026-09-22). A sandboxed being finished six translation files
// and could not deliver them to `G:\My Drive\jose-lorenzo\…`. The volume reports FAT32 — there are
// no ACLs on it to grant — and GoogleDriveFS.exe runs as the logged-in operator, so the drive
// letter lives in THAT session and the pool account has no `G:` at all. There was no permission to
// grant: the path is simply absent from the being's world. So the copy moved to the side that
// already has one.
//
// ── TWO HALVES, EACH INDEPENDENTLY SATISFIABLE ───────────────────────────────────────────────
// A node that already carries one keeps it and only the missing half is written. They are written
// together here because either alone does nothing: a map nothing selects from, or a name that
// resolves to nothing.
//
//   1. config.yaml, root `outbox_targets:` — THE ONLY PLACE A PATH IS EVER WRITTEN. Registered in
//      config/config-schema.mjs by f74cfee (this migration does not re-register it), and a sibling
//      of `allowed_paths:` for the stated reason: one place the node grants a folder, and
//      therefore one place to revoke it.
//   2. config/rooms.yaml, `rooms: → room/acim: → agents: → <being>: → outbox_to:` — the NAME of an
//      entry in that map. Never a path.
//
// WHY A KEY AND NOT THE PATH, which is the whole point of the indirection: with a raw path,
// ANYTHING that can write a conversation record could name any directory on the operator's disk.
// With a key it can only SELECT among destinations the operator already approved, so the invariant
// survives even if a conversation record is one day writable by something that should not be able
// to write it. src/room-outbox.mjs's resolveOutboxTarget is a `map.get(key)` and nothing more — a
// key the map does not have resolves to NOTHING and is reported by name, which is why there is no
// sanitiser there to get wrong and no traversal here to defend against.
//
// WHERE THE READER ACTUALLY LOOKS, and it is not the room ROW. src/conversations-state.mjs
// getBeing reads ONE place — `entry.agents.<being>.outbox_to` — and src/rooms-file.mjs
// mergeRoomBeings is what hydrates a surface-`room` entry's `agents:` block from `rooms: →
// room/<slug>: → agents:`. That is the rung `compaction` lives on, traced by 0022 and re-used
// here for the same reason: a key on the ROW instead is the config-resolver's room rung, whose
// resolved doc reaches exactly one reader in brainpool (readWarmTtl's `warm:` block). It would
// look correct in the file forever and be read by NOTHING.
//
// IT IS PER BEING BECAUSE THE RUNG IS, not because the residents of a room differ. Every being
// resident in `room/acim` answers from that room, and a room has ONE outbox/ (src/room-core.mjs,
// part of the Room tree), so every one of them hands work out of the same folder. A room's blocks
// are therefore all written, each named. That also makes the drain harmless to run twice: the
// second finds an emptied outbox and says nothing.
//
// ── QUALIFIED BY WHAT THIS NODE IS, never by its name, and BOTH halves are required ──────────
// The destination is specific to the node that actually HAS the folder, so both properties are
// asked of the node itself:
//
//   1. a `room/acim` ROW in config/rooms.yaml carrying a per-being `agents:` block. The being's
//      KEY is whatever is written there — on kg it is `egpt`, and that is 0018's doing and not a
//      thing this may assume, so the row is READ rather than a name spelled here.
//   2. `G:/My Drive/jose-lorenzo/ACIM-ES.v2` EXISTS ON THIS NODE AND IS A DIRECTORY. Asked behind
//      a ctx seam (the pattern 0007 set with ctx.localAddresses and 0023 with ctx.findChrome), so
//      the suite never depends on the machine it runs on. A node whose Drive folder is not there
//      is not the node this destination belongs to, and writing the path anyway would approve a
//      folder that does not exist — 0015's reading: a path that is not there is a line that only
//      lies.
//
// A NODE MISSING EITHER READS SATISFIED, WITH A NOTE NAMING WHICH ONE — and a node missing both is
// told both. do is that node: it has `room/acim-do` and no `room/acim`, and no such drive.
//
// SATISFIED, NOT REFUSED — A REFUSAL STOPS EVERY LATER MIGRATION on that node (setup/migrate.mjs;
// the 0003/0007/0011/0012 lesson, which 0021 nearly repeated this week). "Nothing to do here" is a
// note: no config/rooms.yaml at all (a fresh profile has none until its first room is made, and
// stopping the chain over that would be a lie); no `room/acim` row, or one that is not a room row;
// a row with no per-being `agents:` block, or none this can honestly write into; the destination
// absent; either half already in place; a map with no column to match and no sibling to follow (an
// empty or flow `outbox_targets:` or being block), where the line would have to be placed by
// guess.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: no config.yaml at all; a
// config.yaml or rooms.yaml that is not valid UTF-8 (a splice would re-encode bytes it never meant
// to touch) or does not parse (whether the node already holds these keys cannot be read); an
// `outbox_targets:` that EXISTS but is not a mapping; an `outbox_targets.acim-drive` already
// naming a DIFFERENT path; and an `outbox_to:` on a being already naming a DIFFERENT key. The last
// two are the same judgement: which folder this node approved, and which approved folder this
// conversation delivers to, are human decisions — so both are named, both sides of them, and
// neither is overwritten.
//
// NOTHING IS SAID TO A BEING BY THIS CHANGE (operator 2026-09-22: "don't mention in pointers
// yet"). config/skeletons/room/30-pointers.md is not touched: the drain is a property of the room
// the spine enforces, not a capability a being is told about, and the being that has been dropping
// files in its outbox/ needs no card to keep doing it.
//
// THE EDIT IS THE EXISTING SPLICE LAYER (src/tools/config-io.mjs spliceYamlInsertKey, the
// whole-nested-block insertion 0015/0016/0022/0023 use). Nothing is re-serialized — a no-op
// `parseDocument().toString()` already rewrites these files — so CRLF, alignment, every other room
// and EVERY COMMENT survive, and each splice re-parses to prove the edit is that one key and
// nothing else.
//
// THE REASON TRAVELS WITH THE YAML, and NOTHING WRITTEN HERE COUNTS ANYTHING (0021's lesson): a
// comment that enumerates becomes a lie the day the number changes, and nobody comes back to fix
// it. What the comments say instead is what the two keys ARE FOR and the one rule that governs
// them — the key is the only thing a conversation ever names, and this map is the only place a
// path is written.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'the room that translates hands its finished files out: this node approves ONE folder by name in `outbox_targets:`, and the room\'s per-being block names only that key';

const ID = '0024';
// The room this ships to, as src/rooms-file.mjs keys a ROOM's row - the only key mergeRoomBeings
// hydrates a room's per-being block from.
const SURFACE = 'room';
const SLUG = 'acim';
const NS = `${SURFACE}/${SLUG}`;
// The wrapped root readRoomsFile tolerates, and the per-being rung inside a row.
const ROOT = 'rooms';
const AGENTS = 'agents';
// config.yaml's node-level map of approved destinations, and the one entry this writes.
const TARGETS = 'outbox_targets';
const KEY = 'acim-drive';
// THE ONE PATH THIS MIGRATION SPELLS, and the only place it is spelled at all. Forward slashes,
// as every other path in these files is written.
const DEST = 'G:/My Drive/jose-lorenzo/ACIM-ES.v2';
// The room's half: the NAME of an entry above, on the being's block. src/conversations-state.mjs
// getBeing reads this spelling and reports it as `outboxTo`.
const OUTBOX_TO = 'outbox_to';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// JSON.stringify prints undefined as nothing and NaN/Infinity as `null`, which would name the
// wrong thing in a refusal.
const show = (v) => (v === undefined ? 'undefined' : (typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v)));
// ONE scalar as the library itself would write it: plain when YAML's own rules allow it, quoted the
// moment it would otherwise be misread. Both values below happen to come out plain (a `G:/…` drive
// path is a valid plain scalar - a `:` is only an indicator when a space follows it), and neither
// is trusted to stay that way.
const scalar = (v) => YAML.stringify(v, { lineWidth: 0 }).trim();

// IS THE DESTINATION REALLY HERE. statSync, not existsSync: the destination must be a DIRECTORY,
// and a file of that name is not one - src/room-outbox.mjs refuses the whole drain over exactly
// that. Any error is "no": a missing drive letter, a Drive folder that is not mounted in this
// session, a permission failure - none of them is a node this destination belongs to, and none of
// them is something plan() may throw over (plan is read-only and a throw is a refusal).
const dirExists = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// A config file, read the ONE way every migration reads one: bytes first (so a splice can never
// re-encode what it did not touch), then a parse that must succeed.
function open(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  return { file, bytes, text, doc, data: doc.toJS(), next: text };
}

const nodeAt = (f, path) => (path.length ? f.doc.getIn(path, true) : f.doc.contents);
// The column a mapping's own keys sit at, read off the file: spliceYamlInsertKey refuses text that
// is indented for a different map, which is how an insertion silently nests one block inside its
// neighbour. Read from the ORIGINAL document for every target up front - an insertion elsewhere
// moves offsets but never a surviving line's indent.
const columnOf = (f, path) => {
  const node = nodeAt(f, path);
  const keyAt = node.items[0].key.range[0];
  return ' '.repeat(keyAt - (f.text.lastIndexOf('\n', keyAt - 1) + 1));
};
// A map this layer can insert into at all: block style (a flow `{}` puts its entries on one line)
// and carrying at least one key (there is no column to match and no sibling to follow otherwise).
const writable = (f, path) => {
  const node = nodeAt(f, path);
  return YAML.isMap(node) && !node.flow && node.items.length > 0;
};

// The lines ONE splice added, read off the two texts rather than guessed - the same rendering
// 0015/0016/0022/0023 use, so a `changes` list reads identically across migrations.
function addedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = b.length - a.length;
  let s = 0;
  while (s < a.length && a[s] === b[s]) s++;
  return { first: s + 1, last: s + n, lines: b.slice(s, s + n).map((l) => l.replace(/\r$/, '')) };
}

// ── the text, AS IT WILL READ in the operator's files ────────────────────────────────────────
// Every block below is written by hand rather than serialized from data, for the reason the splice
// layer's own header gives: the caller owns the comment lines, the alignment and the quoting.

// The ENTRY alone, for a node that already states an `outbox_targets:` map of its own.
const entryLines = (pad) => [
  `${pad}# WHERE room/${SLUG} HANDS ITS FINISHED FILES OUT (${ID}, operator 2026-09-22). This drive`,
  `${pad}# letter lives in the operator's OWN session, so the sandboxed account a being runs as has`,
  `${pad}# no such path at all - which is why the spine does the move (src/room-outbox.mjs) instead`,
  `${pad}# of the being. \`${KEY}\` is the only thing a conversation ever names; this line is the`,
  `${pad}# only place the path behind that name is written.`,
  `${pad}${KEY}: ${scalar(DEST)}`,
];
// The WHOLE map, for a node that states none. The rule belongs on the map; what the one entry is
// for belongs on the entry.
const mapLines = (pad) => [
  `${pad}# THE APPROVED DESTINATIONS A ROOM'S outbox/ MAY BE DRAINED TO (${ID}, operator 2026-09-22).`,
  `${pad}# THE ONLY PLACE A PATH IS EVER WRITTEN, and that is the whole point of it. A conversation`,
  `${pad}# selects an entry BY KEY - \`${OUTBOX_TO}: <key>\` on its per-being block in`,
  `${pad}# config/rooms.yaml - and that key is used as a LOOKUP and nothing else: it never`,
  `${pad}# contributes a fragment, a suffix or a \`..\` to the answer, so a name this map does not`,
  `${pad}# have resolves to NOTHING rather than to a folder nobody approved. Sibling of`,
  `${pad}# \`allowed_paths:\` for that reason: one place the node grants a folder, one place to`,
  `${pad}# revoke it. Unset anywhere means the feature is simply off.`,
  `${pad}${TARGETS}:`,
  ...entryLines(`${pad}  `),
];
// The room's half: a NAME, on the rung getBeing reads.
const outboxLines = (pad) => [
  `${pad}# THIS ROOM HANDS ITS WORK OUT (${ID}, operator 2026-09-22). The being writes finished`,
  `${pad}# files into this room's own outbox/ and the SPINE moves them: it runs as the operator and`,
  `${pad}# can see a drive the sandboxed account the being runs as has no letter for at all. What is`,
  `${pad}# named here is the TARGET'S KEY and never a path - the path is written once, in`,
  `${pad}# config.yaml's \`${TARGETS}:\` map, and a conversation only ever SELECTS among the entries`,
  `${pad}# there. Unset would mean this room hands nothing out.`,
  `${pad}${OUTBOX_TO}: ${scalar(KEY)}`,
];

export async function plan(ctx) {
  const configFile = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(configFile)) refuse(`there is no ${configFile}`);
  const config = open(configFile);

  const roomsFile = join(ctx.egptHome, 'config', 'rooms.yaml');
  // A node with no rooms registry has no `room/acim`. NEVER a refusal: a fresh profile has no such
  // file until its first room is made, and stopping the chain over that would be a lie. It is read
  // when it is there, because a file that exists and cannot be parsed IS a refusal.
  const rooms = existsSync(roomsFile) ? open(roomsFile) : null;

  // BOTH SHAPES src/rooms-file.mjs readRoomsFile tolerates, read its way and not a second way: the
  // wrapped `rooms:` map when there is one, else a bare top-level map of rows.
  const wrapped = !!rooms && isMap(rooms.data) && isMap(rooms.data[ROOT]);
  const rows = rooms ? (wrapped ? rooms.data[ROOT] : (isMap(rooms.data) ? rooms.data : null)) : null;
  const base = wrapped ? [ROOT] : [];
  const row = rows ? rows[NS] : undefined;
  // The row's per-being blocks, in document order. A block that is not a mapping is not a being
  // that takes a turn here; it is named further down and never written into.
  const blocks = isMap(row) && isMap(row[AGENTS]) ? Object.entries(row[AGENTS]) : [];
  const beings = blocks.filter(([, b]) => isMap(b)).map(([name]) => name);

  // ── the two properties, asked independently so a node missing both is told both ─────────────
  const missing = [];
  if (!rooms) missing.push(`there is no ${roomsFile}, so this node has no \`${NS}\` and no room here hands anything out`);
  else if (row === undefined) missing.push(`${roomsFile} has no \`${NS}\` row, so this node is not the one whose room delivers to \`${KEY}\``);
  else if (!isMap(row)) missing.push(`\`${NS}\` in ${roomsFile} is ${show(row)}, not a room row - there is no per-being block here to name a target on`);
  else if (!beings.length) missing.push(`\`${NS}\` in ${roomsFile} carries no per-being \`${AGENTS}:\` block, so no being has taken a turn in that room and there is nothing here to hand work out`);

  // The ctx seam (the pattern 0007 set with ctx.localAddresses, 0023 with ctx.findChrome):
  // production asks this node's own filesystem, and the suite never depends on the machine it runs
  // on. Asked even when the room is already missing, so a node missing both properties is told so.
  const isDirectory = ctx.isDirectory ?? dirExists;
  if (!isDirectory(DEST)) missing.push(`${DEST} is not a directory on this node, so this is not the node that holds the folder \`${KEY}\` names - nothing is approved here that is not there`);

  if (missing.length) return { satisfied: true, notes: missing };

  const notes = [];
  const edits = [];   // { f, path, key, text, label }

  // ── 1. the node's map of approved destinations ──────────────────────────────────────────────
  const targets = isMap(config.data) ? config.data[TARGETS] : undefined;
  if (targets !== undefined && !isMap(targets)) {
    refuse(`\`${TARGETS}:\` in ${configFile} is ${show(targets)}, not a mapping - src/room-outbox.mjs reads a map of name -> path there, and this migration will not guess what a hand edit meant`);
  }
  if (targets === undefined) {
    if (!writable(config, [])) {
      notes.push(`${configFile} has no top-level keys to follow, so where an \`${TARGETS}:\` map belongs would be a guess - not added here`);
    } else {
      edits.push({ f: config, path: [], key: TARGETS, text: mapLines(columnOf(config, [])).join('\n'), label: `the node's \`${TARGETS}:\` map, with \`${KEY}\`` });
    }
  } else if (Object.hasOwn(targets, KEY)) {
    // WHICH FOLDER THIS NODE APPROVED IS A HUMAN DECISION. Repointing one would silently redirect
    // every delivery this room has ever made, so both paths are named and neither is overwritten.
    if (targets[KEY] !== DEST) {
      refuse(`\`${TARGETS}.${KEY}\` in ${configFile} already names ${show(targets[KEY])} rather than ${show(DEST)} - which folder this node approved is a human decision, not a path to overwrite`);
    }
    notes.push(`\`${TARGETS}.${KEY}\` in ${configFile} already names ${DEST} - the destination this node approves is already written`);
  } else if (!writable(config, [TARGETS])) {
    notes.push(`\`${TARGETS}:\` in ${configFile} is an empty or flow mapping - there is no column to match and no sibling to follow, so where an \`${KEY}:\` entry belongs would be a guess`);
  } else {
    edits.push({ f: config, path: [TARGETS], key: KEY, text: entryLines(columnOf(config, [TARGETS])).join('\n'), label: `\`${TARGETS}.${KEY}\`` });
  }

  // ── 2. the room's half: the NAME, on the rung getBeing reads ────────────────────────────────
  for (const [being, block] of blocks) {
    const at = `${ROOT}.${NS}.${AGENTS}.${being}`;
    if (!isMap(block)) {
      notes.push(`${at} in ${roomsFile} is ${show(block)}, not a per-being block - there is nothing here taking a turn in that room, so it is left alone`);
      continue;
    }
    if (Object.hasOwn(block, OUTBOX_TO)) {
      const named = block[OUTBOX_TO];
      // WHICH APPROVED TARGET THIS CONVERSATION DELIVERS TO is the operator's, exactly as the map
      // entry above is. A name this migration does not recognise is not a typo to correct.
      if (named !== KEY) {
        refuse(`\`${OUTBOX_TO}:\` at ${at} in ${roomsFile} already names ${show(named)} rather than ${show(KEY)} - which approved target this conversation hands its work to is a human decision, and this migration will not repoint one`);
      }
      notes.push(`${at}.${OUTBOX_TO} in ${roomsFile} already names \`${KEY}\` - this conversation already hands its work out and is left alone`);
      continue;
    }
    if (!writable(rooms, [...base, NS, AGENTS, being])) {
      notes.push(`${at} in ${roomsFile} is an empty or flow mapping - there is no column to match and no sibling to follow, so where an \`${OUTBOX_TO}:\` line belongs would be a guess`);
      continue;
    }
    edits.push({
      f: rooms,
      path: [...base, NS, AGENTS, being],
      key: OUTBOX_TO,
      text: outboxLines(columnOf(rooms, [...base, NS, AGENTS, being])).join('\n'),
      label: `\`${OUTBOX_TO}: ${KEY}\` at ${at}`,
    });
  }

  if (!edits.length) {
    return {
      satisfied: true,
      notes: [`this node has \`${NS}\` (${beings.map((b) => `\`${b}\``).join(', ')}) and the folder \`${KEY}\` names, and both halves are already in place`, ...notes],
    };
  }

  // Applied in document order, each onto the last, and each file is written ONCE - after a backup
  // and a changed-since-planned guard.
  const changes = [];
  for (const e of edits) {
    const before = e.f.next;
    try { e.f.next = spliceYamlInsertKey(before, e.path, { key: e.key, text: e.text }); }
    catch (err) { refuse(`${e.label} cannot be written into ${e.f.file} (${err?.message ?? err})`); }
    const { first, last, lines } = addedLines(before, e.f.next);
    changes.push(`${e.f.file}:${first}-${last}  insert ${e.label} (${lines.length} lines):`, ...lines.map((l) => `  + ${l}`));
  }
  changes.push(
    `\`${NS}\` on this node hands what ${beings.map((b) => `\`${b}\``).join(', ')} finish${beings.length === 1 ? 'es' : ''} there out to \`${KEY}\`, which is ${DEST} - the spine moves the files because it runs as the operator and the sandboxed account a being runs as has no such path at all`,
    ...notes,
    `backup first, beside each: <file>.bak-${ID}-<timestamp>`,
  );

  const touched = [...new Set(edits.map((e) => e.f))];
  return {
    satisfied: false,
    changes,
    apply: async () => {
      for (const f of touched) if (!readFileSync(f.file).equals(f.bytes)) refuse(`${f.file} changed since it was planned - re-run`);
      for (const f of touched) {
        ctx.log(`backup: ${ctx.backup(f.file)}`);
        writeFileSync(f.file, f.next, 'utf8');
      }
    },
  };
}
