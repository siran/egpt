// 0030 — the pointers card names ./heartbeats/, the being's own schedule.
//
// THE MEASUREMENT (operator, 2026-09-25, eGPT Admin): being E was asked "call Julio tomorrow, remind
// me every 2h from 9am" and could not — it had no place a heartbeat could live. The room tree now has
// one (src/room-core.mjs Room.heartbeatsDir: one <name>.yaml per beat, read by the config resolver's
// walk, TURNS ONLY — src/spine/heartbeat-loader.mjs refuses a command from it). A being learns its
// room from ONE card, config/skeletons/room/30-pointers.md, and a folder it is never told about is a
// folder it does not have.
//
// WHY A MIGRATION: exactly 0017's reason. boot's seedSkeletons is COPY-IF-MISSING, so a node that
// already carries the card never receives the repo's new line; the profile copy is the one the
// operator edits and the one this migration owns.
//
// IT ADDS THE ONE LINE, and nothing else, in the CARD'S OWN style (its pointer indent, its
// description column, its line endings), right after ./desktop/ — the being's other own folder,
// the repo card's order — or, with no ./desktop/ line, after the block's last pointer line.
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN — setup/migrate.mjs, the 0003/0007/0011/0012
// lesson): the card already names ./heartbeats/, or there is no card on this node (boot's seeder
// plants the repo's).
//
// IT REFUSES, NAMING THE PLACE, only on what it cannot honestly edit: a card that is not valid UTF-8,
// and a card with NO pointer lines at all (no block to join, no style to match).
//
// THE EDIT is a plain line insertion with a backup and a changed-since-planned check. The repo's own
// card is READ-ONLY to this migration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the room's pointers card names ./heartbeats/, where a being keeps its own beats (turns only)";

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
const WANTED = { path: './heartbeats/', text: 'my schedule — one <name>.yaml per beat, turns only (agent: + prompt:)' };
const ANCHOR = './desktop/';
// A pointer line: indented, a ./path, then its description (0017's pattern, read off the card).
const POINTER = /^(\s+)(\.\/\S+)(\s+)(\S.*)$/;

const refuse = (why) => { throw new Error(`0030 refuses: ${why}`); };

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
  if (pointers.some(({ m }) => m[2] === WANTED.path)) {
    return { satisfied: true, notes: [`${file} already names ${WANTED.path}`] };
  }

  // The card's own style, read off its FIRST pointer line: the indent and the description column.
  const [, indent, firstPath, gap] = pointers[0].m;
  const column = indent.length + firstPath.length + gap.length;
  const line = `${indent}${WANTED.path}${' '.repeat(Math.max(1, column - indent.length - WANTED.path.length))}${WANTED.text}`;

  const anchor = pointers.find(({ m }) => m[2] === ANCHOR) ?? pointers[pointers.length - 1];
  const at = anchor.i + 1;
  const next = [...lines.slice(0, at), line, ...lines.slice(at)].join(nl);

  return {
    satisfied: false,
    changes: [
      `${file}:${at + 1}  name ${WANTED.path} after ${anchor.m[2]} (1 line):`,
      `  + ${line}`,
      'the room really has this folder (src/room-core.mjs ensureTree) - a being that is not told cannot use it',
      'backup first, beside it: <file>.bak-0030-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
