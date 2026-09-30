// 0036 — the pointers card mentions that a beat may be `silent:` (it then posts to eGPT Admin
// instead of this chat).
//
// THE RULING (operator, 2026-09-30): "the bridge should announce it is triggering a heartbeat, unless
// the heartbeat is `silent`, in which case it posts in eGPT Admin." A being learns what a beat may be
// from that ONE card (config/skeletons/room/30-pointers.md), whose ./heartbeats/ block 0035 filled with
// the three kinds — so a beat field it is never told about is one it does not use. `silent:` applies
// to any kind (structural post:, browser, pure AI), so it is a NOTE under the block, not a fourth kind.
//
// WHY A MIGRATION: 0030's, 0033's and 0035's reason. boot's seedSkeletons is COPY-IF-MISSING, so a node
// that already carries the card never receives the repo's new line; the profile copy is the one the
// operator edits and the one this migration owns.
//
// IT ADDS ONE LINE, and nothing else: a note right after 0035's "pure AI" line (the tail of the
// three-kinds block), at that line's own indent, in the card's own line endings.
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN — setup/migrate.mjs, the 0003/0007/0011/0012
// lesson, carried on by 0035): there is no card on this node (boot's seeder plants the repo's); the card
// already mentions silent:; or it has no "pure AI" line at all (a pre-0035 card 0035 left alone, or the
// operator's own — left alone, with a note).
//
// IT REFUSES, NAMING THE PLACE, only on a card that is not valid UTF-8 (an edit would re-encode bytes it
// never meant to touch), exactly as 0035 does.
//
// THE EDIT is a plain line insertion with a backup and a changed-since-planned check. The repo's own card
// is READ-ONLY to this migration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the room's pointers card mentions that a beat may be silent: — it then posts to eGPT Admin instead of this chat";

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
// 0035's last line, byte for byte — the tail of the three-kinds block, the anchor the note follows.
const ANCHOR = 'pure AI     agent: + prompt:';
// The note this migration adds, in the card's voice (trimmed; its indent comes from the anchor line's).
export const LINE = 'any beat may add silent: true — posts to eGPT Admin, not this chat';

const refuse = (why) => { throw new Error(`0036 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, ...CARD);
  if (!existsSync(file)) {
    return { satisfied: true, notes: [`there is no ${file} on this node - boot's seeder plants the repo's card, which is not this migration's to pre-empt`] };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  if (text.includes(LINE)) return { satisfied: true, notes: [`${file} already mentions silent:`] };

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trimStart() === ANCHOR);
  if (at < 0) return { satisfied: true, notes: [`${file} has no "${ANCHOR}" line - the three-kinds block 0035 writes is not here (a pre-0035 or operator-edited card), left alone`] };
  const indent = lines[at].match(/^\s*/)[0];
  const added = `${indent}${LINE}`;
  const next = [...lines.slice(0, at + 1), added, ...lines.slice(at + 1)].join(nl);

  return {
    satisfied: false,
    changes: [
      `${file}:${at + 2}  a note after "${ANCHOR}" says a beat may be silent::`,
      `  + ${added}`,
      'a beat may set silent: true to post the whole beat to eGPT Admin instead of this chat (operator 2026-09-30, src/spine/heartbeat-loader.mjs) - a being never told cannot ask for it',
      'backup first, beside it: <file>.bak-0036-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
