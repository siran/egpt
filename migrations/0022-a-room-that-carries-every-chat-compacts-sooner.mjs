// 0022 — a room that carries every chat compacts sooner.
//
// Operator, 2026-09-14 (commit 44d4c0f): *"the cooling timer is re-armed on every turn, so a
// conversation that stays busy never goes quiet and never compacts… Overshooting is not compacted
// late, it is lost: the overflow backstop resets the thread."* That day E answered three people
// from a blank thread. The critical ratio went in as the emergency brake; this is the other half —
// the conversations that should never get near it in the first place.
//
// THE SHAPE, measured on kg 2026-09-22. `room/acim` is a room with a WhatsApp group invited into
// it as a `wa-group` member. src/spine/identity-scope.mjs resolves EVERY being addressed in that
// group to the room (boot.mjs's createMemberResolver does the reverse lookup over config/
// rooms.yaml), so the group's turns and the room's own turns land on ONE thread, ONE warm session,
// ONE queue — which is the entire point of that module. Its thread is 2.8 MB / 1828 turns and
// still growing, on the node default `compaction.ratio: 0.80` / `cooling_ms: 600000`: ten minutes
// of quiet a busy room never has, and then 80% of the window before anything is trimmed.
//
// A BEING ALREADY CARRIES THIS FIX, and its reasoning is written beside it in kg's config.yaml —
// `wren`, `conversation_defaults.compaction.ratio: 0.50`, because *"this being is ONE THREAD
// carrying every chat it is addressed in, so it fills a window far faster than any single chat
// does"*. A room that several groups tunnel into is the same defect wearing the other hat: wren is
// one BEING everywhere, a room is one CONVERSATION for many chats. This migration writes the
// room's half of that pin.
//
// WHERE THE READER ACTUALLY LOOKS, traced before anything was written, because the `compaction:`
// spelling appears at four unrelated depths in this tree and only one of them is read for a room:
//
//   src/spine/compaction.mjs        afterTurn({ compaction }) — the per-conversation override,
//                                   resolved OVER the node-global block (ratioFor/coolingFor/…).
//   src/spine/brainpool.mjs:803     resolveConv: `b?.compaction
//                                   ?? getConfig().agents.<being>.conversation_defaults.compaction`
//                                   where `b = getBeing(state, scope.surface, scope.chatId, being)`
//                                   and `scope` is THE ROOM for a chat invited into it.
//   src/conversations-state.mjs     getBeing reads ONE place: `entry.agents.<being>.compaction`.
//   src/rooms-file.mjs              mergeRoomBeings hydrates a surface-`room` entry's `agents:`
//                                   block from config/rooms.yaml's `rooms: → room/<slug>: →
//                                   agents: → <being>:`, and persistBeings writes it back there.
//
// So the room rung is `rooms.room/<slug>.agents.<being>.compaction`, and that is where this
// writes. NOT a `compaction:` on the room ROW: the row's own keys are the config-resolver's ROOM
// rung (src/spine/config-resolver.mjs), and its resolved doc reaches exactly one reader in
// brainpool — `readWarmTtl`'s `warm:` block. A ratio written there would be read by nothing, look
// correct in the file forever, and the thread it was meant to protect would still be reset.
//
// IT IS PER BEING BECAUSE THE RUNG IS, not because a room's residents differ: every being resident
// in that room answers the same tunnelled chats on its own one thread, so every one of them has
// the defect. A being with no block in the room has never taken a turn there — it has no thread to
// protect and inventing a block for it would be a guess, so it is named in the plan and left.
//
// QUALIFIED BY THE PROPERTY, NEVER BY THE SLUG. `acim` appears nowhere below. A room qualifies
// when its row is keyed `room/<slug>` (the only key mergeRoomBeings hydrates a room's block from)
// AND its `members:` list holds at least one `{ kind: wa-group }` entry (src/room-core.mjs's
// ROOM_MEMBER_KINDS, the same match boot.mjs's reverse lookup makes) AND the being's block does
// not already state a `compaction.ratio`. A node with no such room reads SATISFIED with a note.
//
// MORE THAN ONE QUALIFYING ROOM IS NOT A REFUSAL — unlike 0021's two-pinned-engineers case there
// is nothing to choose between. Every such room has the identical defect, each one gets the
// override, and each one is named in `changes`.
//
// SATISFIED, NOT REFUSED — a refusal STOPS EVERY LATER MIGRATION on that node (setup/migrate.mjs,
// the 0003/0007/0011/0012 lesson, which 0021 nearly repeated an hour ago): no config/rooms.yaml at
// all (a node with no rooms owes nothing here); no row carrying a `wa-group` member; a qualifying
// room with no `agents:` container, or none this can honestly write into; and every qualifying
// being already carrying a ratio.
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: a rooms.yaml that is not
// valid UTF-8 (a splice would re-encode bytes it never meant to touch) or does not parse (whether
// it holds a room to fix cannot be read), and a `compaction:` that EXISTS but is not a mapping —
// a scalar there is a hand edit whose meaning this migration will not guess, and overwriting it
// would silently discard whatever the operator meant by it.
//
// THE EDIT IS THE EXISTING SPLICE LAYER (src/tools/config-io.mjs spliceYamlInsertKey, added by
// 0011 and used by 0015/0016 for exactly this: a nested block written as the text it will READ).
// Nothing is re-serialized — a no-op `parseDocument().toString()` already rewrites these files —
// so CRLF, alignment, every other room and every comment survive, and each splice re-parses to
// prove the edit is that one key and nothing else.
//
// THE REASON IS WRITTEN INTO THE YAML, the way wren's block carries its own. A future reader finds
// the overflow backstop named beside the number, so the one question this answers — why does THIS
// conversation compact sooner than the node — never has to be reconstructed from a commit log.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlInsertKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'a room that carries every chat invited into it compacts at half the window, not the node ratio — so its one thread is trimmed before the overflow backstop resets it';

const ID = '0022';
const FILE = 'rooms.yaml';
// The wrapped root readRoomsFile tolerates (`rooms:`), and the room surface's key prefix. Only a
// `room/<slug>` row backs a ROOM's per-being block — src/rooms-file.mjs nsOf/mergeBeings.
const ROOT = 'rooms';
const PREFIX = 'room/';
// The member kind that makes a room a tunnel — one of src/room-core.mjs's ROOM_MEMBER_KINDS, and
// written here as the LITERAL the reader matches on (src/spine/boot.mjs:825, `m.kind ===
// 'wa-group'`), so this migration qualifies a room by exactly the comparison the node makes.
const KIND = 'wa-group';
const BLOCK = 'compaction';
const KEY = 'ratio';
// Half the window — wren's number, for wren's reason. Written `0.50` because that is how it reads
// in kg's config.yaml beside the ruling; YAML loads it as 0.5 either way.
const RATIO = '0.50';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// JSON.stringify prints undefined as nothing and NaN/Infinity as `null`, which would name the
// wrong thing in a refusal.
const show = (v) => (v === undefined ? 'undefined' : (typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v)));

// THE COMMENT THAT TRAVELS WITH THE NUMBER. Two renderings of one reason: the whole block for a
// being that states no `compaction:` at all, and the `ratio:` line alone for one that states a
// block without it. Both name the backstop, because "why sooner than the node" is the only
// question a reader of this line will ever have.
//
// NEITHER COUNTS ANYTHING, and that is deliberate (0021's lesson about a comment that enumerates):
// a line saying "3 groups are joined here" becomes a lie the day a fourth is, and `/members add
// group` will never come back to fix it. The COUNT belongs in the plan the operator approves, and
// the room's name belongs to the row this block already sits inside.
const blockLines = (pad) => [
  `${pad}# THIS ROOM CARRIES EVERY CHAT INVITED INTO IT (${ID}, operator 2026-09-14: "overshooting`,
  `${pad}# is not compacted late, it is lost: the overflow backstop resets the thread"). A chat`,
  `${pad}# joined here as a \`${KIND}\` member resolves to THIS conversation - one being, one thread,`,
  `${pad}# one warm session (src/spine/identity-scope.mjs) - so this thread fills a window far`,
  `${pad}# faster than any single chat does. That is the case the per-conversation override in`,
  `${pad}# src/spine/compaction.mjs exists for: compact at HALF the window instead of the node's`,
  `${pad}# ratio, so the thread is trimmed well before brainpool's overflow backstop can RESET it.`,
  `${pad}${BLOCK}:`,
  `${pad}  ${KEY}: ${RATIO}`,
];
const ratioLines = (pad) => [
  `${pad}# HALF THE WINDOW, NOT THE NODE'S RATIO (${ID}, operator 2026-09-14). A chat joined this`,
  `${pad}# room as a \`${KIND}\` member resolves to THIS conversation's one thread`,
  `${pad}# (src/spine/identity-scope.mjs), so it is trimmed well before brainpool's overflow`,
  `${pad}# backstop can RESET it to a fresh session - overshooting is not compacted late, it is lost.`,
  `${pad}${KEY}: ${RATIO}`,
];

// The column a mapping's own keys sit at, read off the file: spliceYamlInsertKey refuses text that
// is indented for a different map, which is how an insertion silently nests one block inside its
// neighbour. Read from the ORIGINAL document for every target up front — an insertion elsewhere
// moves offsets but never a surviving line's indent.
const columnOf = (doc, text, path) => {
  const node = doc.getIn(path, true);
  const keyAt = node.items[0].key.range[0];
  return ' '.repeat(keyAt - (text.lastIndexOf('\n', keyAt - 1) + 1));
};
// A map this layer can insert into at all: block style (a flow `{}` puts its entries on one line)
// and carrying at least one key (there is no column to match and no sibling to follow otherwise).
const writable = (doc, path) => {
  const node = doc.getIn(path, true);
  return YAML.isMap(node) && !node.flow && node.items.length > 0;
};

// The lines ONE splice added, read off the two texts rather than guessed — the same rendering
// 0015/0016 use, so a `changes` list reads identically across migrations. Splices are applied in
// document order, so every number here is the line in the file as this migration leaves it.
function addedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = b.length - a.length;
  let s = 0;
  while (s < a.length && a[s] === b[s]) s++;
  return { first: s + 1, last: s + n, lines: b.slice(s, s + n).map((l) => l.replace(/\r$/, '')) };
}

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', FILE);
  // A node with no rooms owes nothing here. NEVER a refusal: a fresh profile has no registry file
  // at all until its first room is made, and stopping the chain over that would be a lie.
  if (!existsSync(file)) return { satisfied: true, notes: [`there is no ${file}, so this node has no rooms and none of them carries every chat`] };

  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);

  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);

  // BOTH SHAPES src/rooms-file.mjs readRoomsFile tolerates, read its way and not a second way: the
  // wrapped `rooms:` map when there is one, else a bare top-level map of rows.
  const data = doc.toJS();
  const wrapped = isMap(data) && isMap(data[ROOT]);
  const rows = wrapped ? data[ROOT] : (isMap(data) ? data : null);
  const base = wrapped ? [ROOT] : [];
  if (!rows || !Object.keys(rows).length) {
    return { satisfied: true, notes: [`${file} holds no room rows, so there is no room here that carries every chat`] };
  }

  const notes = [];
  // A row's roster: `members:` as src/room-core.mjs writes it and boot.mjs's reverse lookup reads
  // it. A `members:` that is not a list is named rather than guessed at — it is not a roster this
  // can count, and it is not this migration's business to repair one.
  const groupsOf = (ns, row) => {
    if (!Object.hasOwn(row, 'members')) return [];
    if (!Array.isArray(row.members)) {
      notes.push(`${ns} in ${file} has a \`members:\` that is ${show(row.members)}, not a list - it cannot be read as a roster, so this room is left alone`);
      return [];
    }
    return row.members.filter((m) => isMap(m) && m.kind === KIND);
  };

  const carrying = Object.entries(rows)
    .filter(([, row]) => isMap(row))
    .map(([ns, row]) => [ns, row, groupsOf(ns, row)])
    .filter(([, , groups]) => groups.length > 0);

  // OFF-SURFACE ROWS ARE NAMED, NEVER EDITED. rooms.yaml also carries `shell/…` and `whatsapp/…`
  // rows (src/rooms-file.mjs), and mergeRoomBeings hydrates a ROOM's per-being block only from a
  // `room/<slug>` key — so a wa-group member on any other row is a roster this rung does not back.
  for (const [ns, , groups] of carrying.filter(([ns]) => !String(ns).startsWith(PREFIX))) {
    notes.push(`${ns} in ${file} carries ${groups.length} \`${KIND}\` member${groups.length === 1 ? '' : 's'} but is not keyed \`${PREFIX}<slug>\`, so no room's per-being block is backed by it - left alone`);
  }

  const rooms = carrying.filter(([ns]) => String(ns).startsWith(PREFIX));
  if (!rooms.length) {
    return {
      satisfied: true,
      notes: [`no room in ${file} carries a \`${KIND}\` member, so no conversation here answers every chat from one thread`, ...notes],
    };
  }

  // ── which being blocks get the override, and which are only named ──────────────────────────
  const edits = [];
  for (const [ns, row, groups] of rooms) {
    const where = `rooms.${ns}`;
    const many = `${groups.length} \`${KIND}\` member${groups.length === 1 ? '' : 's'}`;
    if (!Object.hasOwn(row, 'agents') || !isMap(row.agents) || !Object.keys(row.agents).length) {
      notes.push(`${where} carries ${many} but has no per-being \`agents:\` block in ${file} - no being has taken a turn there yet, so there is no thread here to protect and inventing a block for one would be a guess`);
      continue;
    }
    if (!writable(doc, [...base, ns, 'agents'])) {
      notes.push(`${where}.agents in ${file} is a flow mapping - this splice writes block style only, so ${where} is left alone`);
      continue;
    }
    for (const [being, block] of Object.entries(row.agents)) {
      const at = `${where}.agents.${being}`;
      if (!isMap(block)) {
        notes.push(`${at} in ${file} is ${show(block)}, not a per-being block - there is nothing here holding a thread, so it is left alone`);
        continue;
      }
      if (Object.hasOwn(block, BLOCK)) {
        const over = block[BLOCK];
        // THE ONE ROOM-SHAPED REFUSAL. A scalar (or a list, or a bare `compaction:` whose value is
        // null) where the service expects a mapping is a hand edit, and overwriting it would throw
        // away whatever it meant.
        if (!isMap(over)) refuse(`\`${BLOCK}:\` at ${at} in ${file} is ${show(over)}, not a mapping - src/spine/compaction.mjs reads a block of \`enabled\`/\`ratio\`/\`cooling_ms\`/\`context_window\` there, and this migration will not guess what a hand edit meant`);
        if (Object.hasOwn(over, KEY)) {
          notes.push(`${at}.${BLOCK}.${KEY} in ${file} already reads ${show(over[KEY])} - this conversation already states its own threshold and is left alone`);
          continue;
        }
        if (!writable(doc, [...base, ns, 'agents', being, BLOCK])) {
          notes.push(`${at}.${BLOCK} in ${file} states no \`${KEY}\` but is an empty or flow mapping - there is no column to match and no sibling to follow, so where the line belongs would be a guess`);
          continue;
        }
        const pad = columnOf(doc, text, [...base, ns, 'agents', being, BLOCK]);
        edits.push({ ns, being, at, key: KEY, path: [...base, ns, 'agents', being, BLOCK], block: ratioLines(pad).join('\n') });
        continue;
      }
      if (!writable(doc, [...base, ns, 'agents', being])) {
        notes.push(`${at} in ${file} is an empty or flow mapping - there is no column to match and no sibling to follow, so where a \`${BLOCK}:\` block belongs would be a guess`);
        continue;
      }
      const pad = columnOf(doc, text, [...base, ns, 'agents', being]);
      edits.push({ ns, being, at, key: BLOCK, path: [...base, ns, 'agents', being], block: blockLines(pad).join('\n') });
    }
  }

  if (!edits.length) {
    return {
      satisfied: true,
      notes: [
        `${rooms.length} room${rooms.length === 1 ? '' : 's'} in ${file} carr${rooms.length === 1 ? 'ies' : 'y'} a \`${KIND}\` member (${rooms.map(([ns]) => ns).join(', ')}), and no being block there is left to give a \`${BLOCK}.${KEY}\``,
        ...notes,
      ],
    };
  }

  // Applied in document order, each onto the last, and the file is written ONCE — after a backup
  // and a changed-since-planned guard.
  const changes = [];
  let next = text;
  for (const e of edits) {
    const before = next;
    try { next = spliceYamlInsertKey(before, e.path, { key: e.key, text: e.block }); }
    catch (err) { refuse(`\`${e.key}:\` cannot be written at ${e.at} in ${file} (${err?.message ?? err})`); }
    const { first, last, lines } = addedLines(before, next);
    changes.push(
      `${file}:${first}-${last}  insert ${e.at}.${e.key === BLOCK ? BLOCK : `${BLOCK}.${KEY}`} (${lines.length} lines):`,
      ...lines.map((l) => `  + ${l}`),
    );
  }
  for (const [ns, , groups] of rooms) {
    const mine = edits.filter((e) => e.ns === ns);
    if (!mine.length) continue;
    changes.push(
      `${ns} carries every chat of ${groups.length} \`${KIND}\` member${groups.length === 1 ? '' : 's'} on one thread - ${mine.map((e) => `\`${e.being}\``).join(', ')} compact${mine.length === 1 ? 's' : ''} at ${RATIO} of the window here instead of this node's ratio, so the thread is trimmed before the overflow backstop resets it`,
    );
  }
  changes.push(...notes, `backup first, beside it: <file>.bak-${ID}-<timestamp>`);

  return {
    satisfied: false,
    changes,
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
