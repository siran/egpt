// 0017 — the pointers card names what the room actually has.
//
// A being learns its room from ONE card: config/skeletons/room/30-pointers.md, fed at kickoff and
// copied into each conversation's directives/ for later consult. Two folders the room really has
// are missing from the PROFILE's copy of it:
//
//   ./desktop/   the being's own working surface, added to the room tree today
//                (src/room-core.mjs Room.desktopDir, 2026-09-20). The REPO's card already names
//                it; the profile's does not.
//   ./files/     the operator's shelf — Room.filesDir, what `/inject` writes into. The card has
//                NEVER mentioned it, in either copy, so no being knows it exists.
//
// WHY A MIGRATION AND NOT A REPO EDIT. src/spine/boot.mjs's seedSkeletons is COPY-IF-MISSING: a
// node that already has ~/.egpt/config/skeletons/room/30-pointers.md never receives a new one, so
// editing the repo's card alone cannot reach it. (The READER, src/conversations-state.mjs's
// resolveRoomLayerFile, picks the NEWER of the two copies per file — so a `git pull` can carry a
// repo edit through, but only until the operator touches their own copy, and never for a line the
// repo's card does not have. The profile copy is the one an operator edits and the one this
// migration owns.)
//
// IT ADDS WHICHEVER OF THE TWO IS MISSING, and nothing else. A card already naming both reads
// SATISFIED, so a re-run adds no second copy. The lines are written in the CARD'S OWN style, read
// off the card itself: its pointer-block indent, its description column, its line endings. Placed
// beside `./media/` — the other shelf of files — in the repo card's own order (media, files,
// desktop), so the two cards read the same way; a card with no `./media/` line puts them after its
// last pointer line.
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN — setup/migrate.mjs, the 0003/0007/0011
// lesson): the card already names both, and there is no card at all on this node (a fresh profile
// has none yet, and boot's seeder will plant the repo's).
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: a card that is not valid
// UTF-8, and a card with NO pointer lines at all — there is no block to join and no style to
// match, so where the line belongs would be a guess.
//
// THE EDIT is a plain line insertion with a backup and a changed-since-planned check. The repo's
// own config/skeletons/room/30-pointers.md is READ-ONLY to this migration; nothing here touches it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the room's pointers card names ./files/ and ./desktop/, the two folders a being could not know it had";

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
// In the order they are to READ, which is the repo card's order: the chat's files, the operator's
// shelf, then the being's own surface.
const WANTED = [
  { path: './files/', text: "the operator's shelf — what /inject leaves here for me" },
  { path: './desktop/', text: "mine — what I'm working on right now" },
];
const ANCHOR = './media/';
// A pointer line: indented, a ./path, then its description. The description column is what keeps
// the block a table, so it is read off the card rather than assumed.
const POINTER = /^(\s+)(\.\/\S+)(\s+)(\S.*)$/;

const refuse = (why) => { throw new Error(`0017 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, ...CARD);
  if (!existsSync(file)) {
    return { satisfied: true, notes: [`there is no ${file} on this node - boot's seeder plants the repo's card, which is not this migration's to pre-empt`] };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const pointers = lines.map((l, i) => ({ i, m: POINTER.exec(l) })).filter(({ m }) => m);
  if (!pointers.length) refuse(`${file} has no pointer lines (an indented \`./path  description\`), so there is no block to join and no style to match`);

  const missing = WANTED.filter(({ path }) => !pointers.some(({ m }) => m[2] === path));
  if (!missing.length) {
    return { satisfied: true, notes: [`${file} already names ${WANTED.map((w) => w.path).join(' and ')}`] };
  }

  // The card's own style: the indent every pointer line shares, and the column its descriptions
  // start at - read off the FIRST pointer line, which is the one that set the table.
  const first = pointers[0].m;
  const indent = first[1];
  const column = indent.length + first[2].length + first[3].length;
  const render = ({ path, text: desc }) => `${indent}${path}${' '.repeat(Math.max(1, column - indent.length - path.length))}${desc}`;

  // Beside ./media/, the other shelf of files; else after the block's last pointer line.
  const anchor = pointers.find(({ m }) => m[2] === ANCHOR) ?? pointers[pointers.length - 1];
  const at = anchor.i + 1;
  const added = missing.map(render);
  const next = [...lines.slice(0, at), ...added, ...lines.slice(at)].join(nl);

  return {
    satisfied: false,
    changes: [
      `${file}:${at + 1}-${at + added.length}  name ${missing.map((w) => w.path).join(' and ')} after ${anchor.m[2]} (${added.length} line${added.length > 1 ? 's' : ''}):`,
      ...added.map((l) => `  + ${l}`),
      'the room really has these folders (src/room-core.mjs ensureTree) - a being that is not told cannot use them',
      'backup first, beside it: <file>.bak-0017-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
