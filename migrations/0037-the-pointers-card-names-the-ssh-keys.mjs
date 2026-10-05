// 0037 — the pointers card names ./.ssh/, where a being keeps its ssh keys so they survive a lease.
//
// THE RULING (operator, 2026-10-04): a sandboxed being's own pool home (~/.ssh) is WIPED each lease, so
// an ssh key must live in a PERSISTENT, fenced, backup-excluded place — its own conversation folder's
// .ssh/, which survives lease rotation and is re-ACL'd to each lessee (the FFS Drive backup now excludes
// *\.ssh\). A being learns its room from ONE card, config/skeletons/room/30-pointers.md, and a location
// it is never told about is one it does not use — it would keep keys in the pool home, where they vanish.
//
// WHY A MIGRATION: 0017's, 0030's, 0033's and 0035's reason. boot's seedSkeletons is COPY-IF-MISSING, so
// a node that already carries the card never receives the repo's new block; the profile copy is the one
// the operator edits and the one this migration owns.
//
// IT ADDS THE ONE BLOCK, and nothing else, in the CARD'S OWN style (its pointer indent, its description
// column, its line endings), right after ./desktop/ — the being's own working folder, so the folders
// that are mine sit together, byte-for-byte the block the repo card carries.
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN — setup/migrate.mjs, the 0003/0007/0011/0012
// lesson, carried on by 0035/0036): there is no card on this node (boot's seeder plants the repo's); the
// card already names ./.ssh/ (idempotent — detected by the head text); or it has no ./desktop/ line to
// anchor on (a card without that pointer is the operator's own — left alone, with a note).
//
// IT REFUSES, NAMING THE PLACE, only on a card that is not valid UTF-8 (an edit would re-encode bytes it
// never meant to touch), exactly as 0035/0036 do.
//
// THE EDIT is a plain block insertion with a backup and a changed-since-planned check. The repo's own
// card is READ-ONLY to this migration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the room's pointers card names ./.ssh/, where a being keeps its ssh keys — persistent and backup-excluded, unlike its pool home's ~/.ssh (wiped each sandbox lease)";

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
const PATH = './.ssh/';
// The block as the repo card carries it: the head on the pointer line, then each continuation line
// RELATIVE to the description column.
export const HEAD = 'my ssh keys — PERSISTENT and backup-excluded, unlike my';
export const REST = [
  "pool home's ~/.ssh (wiped each sandbox lease); keep and",
  'generate keys here, and use',
  '`ssh -i .ssh/<key> -o StrictModes=no`',
];
const ANCHOR = './desktop/';
// A pointer line: indented, a ./path, then its description (0017's pattern, read off the card).
const POINTER = /^(\s+)(\.\/\S+)(\s+)(\S.*)$/;

const refuse = (why) => { throw new Error(`0037 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, ...CARD);
  if (!existsSync(file)) {
    return { satisfied: true, notes: [`there is no ${file} on this node - boot's seeder plants the repo's card, which is not this migration's to pre-empt`] };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  if (text.includes(HEAD)) return { satisfied: true, notes: [`${file} already names ${PATH}`] };

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const pointers = lines.map((l, i) => ({ i, m: POINTER.exec(l) })).filter(({ m }) => m);
  const anchor = pointers.find(({ m }) => m[2] === ANCHOR);
  if (!anchor) return { satisfied: true, notes: [`${file} names no ${ANCHOR} to anchor on - a card without that pointer is the operator's own, left alone`] };

  // The card's own style, read off its FIRST pointer line: the indent and the description column.
  const [, indent, firstPath, gap] = pointers[0].m;
  const column = indent.length + firstPath.length + gap.length;
  const headGap = ' '.repeat(Math.max(1, column - indent.length - PATH.length));
  const pad = ' '.repeat(column);
  const block = [`${indent}${PATH}${headGap}${HEAD}`, ...REST.map((r) => `${pad}${r}`)];

  const at = anchor.i + 1;
  const next = [...lines.slice(0, at), ...block, ...lines.slice(at)].join(nl);

  return {
    satisfied: false,
    changes: [
      `${file}:${at + 1}  name ${PATH} after ${ANCHOR} (${block.length} lines):`,
      ...block.map((l) => `  + ${l}`),
      "a being's ssh keys belong here - its pool home's ~/.ssh is wiped each sandbox lease, this folder survives and is backup-excluded (operator 2026-10-04) - a being that is not told keeps keys where they vanish",
      'backup first, beside it: <file>.bak-0037-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
