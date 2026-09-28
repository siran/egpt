// 0035 — the pointers card names the three kinds of beat a being keeps in ./heartbeats/.
//
// THE RULING (operator, 2026-09-28): "there are different types of yaml heartbeats: - structural: no
// ai. usually datetime and command. being are allowed any command, since they are sandboxed and the
// command runs under their unprivileged account - browser: heartbeat requests a CDP browser. agent can
// manage it. - pure AI: just a prompt asking the AI to do anything." The loader now runs a being's
// command: IN ITS BOX, as the conversation's pool account (src/spine/heartbeat-loader.mjs spawnBoxed,
// src/sandbox-cli-session.mjs spawnBoxedCommand), with post: "{stdout}" into the same chat, and
// `browser: true` starts the spine's browser before a turn. The line 0030 wrote says "turns only
// (agent: + prompt:)" — false now, and a being learns its room from that ONE card
// (config/skeletons/room/30-pointers.md): a kind of beat it is never told about is one it does not have.
//
// WHY A MIGRATION: 0017's, 0030's and 0033's reason. boot's seedSkeletons is COPY-IF-MISSING, so a
// node that already carries the card never receives the repo's new block; the profile copy is the one
// the operator edits and the one this migration owns.
//
// IT REPLACES THE ONE LINE 0030 WROTE, and nothing else: the ./heartbeats/ pointer line whose
// description is exactly 0030's, in place, keeping that line's own indent and description column; the
// block's continuation lines sit at that column (the ./scripts/ line's continuation style), in the
// card's own line endings.
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN — setup/migrate.mjs, the 0003/0007/0011/0012
// lesson): there is no card on this node (boot's seeder plants the repo's); the card already names the
// three kinds; its ./heartbeats/ line says something other than 0030's words (the operator's own —
// left alone, with a note); or it has no ./heartbeats/ line at all (0030 adds it; a card without one
// is the operator's choice).
//
// IT REFUSES, NAMING THE PLACE, only on a card that is not valid UTF-8 (an edit would re-encode bytes
// it never meant to touch).
//
// THE EDIT is a plain line replacement with a backup and a changed-since-planned check. The repo's own
// card is READ-ONLY to this migration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the room's pointers card names the three kinds of beat in ./heartbeats/ — structural (a command, run in the being's box), browser, pure AI";

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
const PATH = './heartbeats/';
// 0030's description, byte for byte — the only one this replaces.
const OLD = 'my schedule — one <name>.yaml per beat, turns only (agent: + prompt:)';
// The new description as the repo card carries it: the head on the pointer line, then each
// continuation line RELATIVE to the description column.
export const HEAD = 'my schedule — one <name>.yaml per beat, three kinds:';
export const REST = [
  'structural  when:/daily: + command:, run as me in my box;',
  '            post: "{stdout}" says its output in this chat',
  'browser     browser: true + agent: + prompt:',
  'pure AI     agent: + prompt:',
];
// A pointer line: indented, a ./path, then its description (0017's pattern, read off the card).
const POINTER = /^(\s+)(\.\/\S+)(\s+)(\S.*)$/;

const refuse = (why) => { throw new Error(`0035 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, ...CARD);
  if (!existsSync(file)) {
    return { satisfied: true, notes: [`there is no ${file} on this node - boot's seeder plants the repo's card, which is not this migration's to pre-empt`] };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  if (text.includes(HEAD)) return { satisfied: true, notes: [`${file} already names the three kinds of beat`] };

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => POINTER.exec(l)?.[2] === PATH);
  if (at < 0) return { satisfied: true, notes: [`${file} names no ${PATH} - 0030 adds that line; a card without it is the operator's choice, left alone`] };
  const [, indent, , gap, description] = POINTER.exec(lines[at]);
  if (description !== OLD) return { satisfied: true, notes: [`${file}:${at + 1} describes ${PATH} in words that are not 0030's - the operator's own, left alone: ${description}`] };

  const column = ' '.repeat(indent.length + PATH.length + gap.length);
  const block = [`${indent}${PATH}${gap}${HEAD}`, ...REST.map((r) => `${column}${r}`)];
  const next = [...lines.slice(0, at), ...block, ...lines.slice(at + 1)].join(nl);

  return {
    satisfied: false,
    changes: [
      `${file}:${at + 1}  the ${PATH} line names the three kinds of beat (1 line -> ${block.length}):`,
      `  - ${lines[at]}`,
      ...block.map((l) => `  + ${l}`),
      'a being\'s command: beat now runs in its box, and browser: true starts the browser before its turn (src/spine/heartbeat-loader.mjs) - a being that is told "turns only" never writes either',
      'backup first, beside it: <file>.bak-0035-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
