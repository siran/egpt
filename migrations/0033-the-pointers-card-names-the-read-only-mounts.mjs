// 0033 — the pointers card names ~/src/ and the operator's shared folders, the read-only folders a
// sandboxed being has beside its room.
//
// THE RULING (operator, 2026-09-28): "sandboxed beings should have access to my
// 'C:\Users\an\src\siran', we can call it repos/", then "please frame this in config.yaml as
// global_read_paths list". Every pool profile now carries, beside the `src` junction onto the eGPT
// checkout, one read-only junction per entry of the node's config.yaml global_read_paths - kg's is
// `repos`, onto ~\src\siran (setup/sandbox-account.ps1, Get-SandboxProfileJunctionStatement; the
// standing grant and the .env carve-out are setup/provision-sandbox-account.ps1's; 0034 writes kg's
// entry). A being learns its surroundings from ONE card, config/skeletons/room/30-pointers.md, and
// NO card had ever named `src` either - since 2026-09-23 a boxed being could read its own code and
// was never told where. So the card names `src`, and the shared folders by kind: a card cannot
// render a config list, and `ls ~` is true on every node.
//
// WHY A MIGRATION: 0017's, 0030's and 0032's reason. boot's seedSkeletons is COPY-IF-MISSING, so a node
// that already carries the card never receives the repo's new block; the profile copy is the one the
// operator edits and the one this migration owns.
//
// IT ADDS THE ONE BLOCK, and nothing else, in the card's own line endings: right BEFORE the card's
// chrome lines (`chrome` / `chrome profile`) - the repo card's place, the other things outside the
// room - with one blank line on each side; or, with no chrome line, at the end after one blank line
// (0032's place).
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN — setup/migrate.mjs, the 0003/0007/0011/0012
// lesson): the card already names ~/src/, wherever the operator put it, or there is no card on this
// node (boot's seeder plants the repo's).
//
// IT REFUSES, NAMING THE PLACE, only on a card that is not valid UTF-8 (an edit would re-encode bytes
// it never meant to touch).
//
// THE EDIT is a plain line insertion with a backup and a changed-since-planned check. The repo's own
// card is READ-ONLY to this migration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the room's pointers card names ~/src/ and the operator's shared folders, the read-only folders a sandboxed being has beside its room";

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
// The block as the repo card carries it, one line per element.
export const BLOCK = [
  'When I run sandboxed, my home holds read-only folders beside this room:',
  '',
  '  ~/src/            my own code — the eGPT checkout',
  '  ~/<name>/         folders the operator shares with every being on this',
  '                    node, e.g. ~/repos/ (his repositories) — `ls ~` shows',
  '                    which this node has',
];
// What "already says it" means: the mount every boxed being has, wherever the operator put it.
const SAYS_IT = '~/src/';
// A chrome line of the card's pointer block: indented, then `chrome` (`chrome` and `chrome profile`).
const CHROME_LINE = /^\s+chrome\b/;

const refuse = (why) => { throw new Error(`0033 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, ...CARD);
  if (!existsSync(file)) {
    return { satisfied: true, notes: [`there is no ${file} on this node - boot's seeder plants the repo's card, which is not this migration's to pre-empt`] };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  if (text.includes(SAYS_IT)) return { satisfied: true, notes: [`${file} already names ${SAYS_IT}`] };

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const chrome = lines.findIndex((l) => CHROME_LINE.test(l));

  let next, where;
  if (chrome >= 0) {
    // One blank line before it unless the card already has one there, and one between it and chrome.
    const block = [...((lines[chrome - 1] ?? '').trim() ? [''] : []), ...BLOCK, ''];
    next = [...lines.slice(0, chrome), ...block, ...lines.slice(chrome)].join(nl);
    where = `${file}:${chrome + 1}  add one block before the chrome lines (${BLOCK.length} lines):`;
  } else {
    const body = text.replace(/(\r?\n)+$/, '');
    next = `${body}${nl}${nl}${BLOCK.join(nl)}${nl}`;
    where = `${file}: no chrome line to sit beside - add one block at the end (${BLOCK.length} lines):`;
  }

  return {
    satisfied: false,
    changes: [
      where,
      ...BLOCK.map((l) => `  + ${l}`),
      'a sandboxed being has ~/src (the eGPT checkout) mounted read-only, and one folder beside it per config.yaml global_read_paths entry (setup/sandbox-account.ps1) - a being that is not told does not look',
      'backup first, beside it: <file>.bak-0033-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
