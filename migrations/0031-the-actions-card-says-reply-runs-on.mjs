// 0031 — the actions card says a /reply runs on, so a quote-reply can carry paragraphs and lists.
//
// THE MEASUREMENT (operator, 2026-09-25): King Ken's quote-replies in Dagiely Palma arrived as one
// flat paragraph, "1) ... 2) ... 3)" inline. His session jsonl shows the model wrote them that way
// because they were `/reply #<id> <text>` actions, whose text was the rest of ONE line; the same
// beings' plain messages kept their paragraphs (E at 00:17 in Dagiely Palma, Ken at 11:58 in
// 🌴FAMILIA PALMA🌴). src/spine/reply-actions.mjs now keeps a /reply open over the lines below it,
// to the next action line or the end. A being learns its limbs from ONE card,
// config/skeletons/room/10-actions.md, and a rule it is never told is a rule it does not use.
//
// WHY A MIGRATION: 0017's and 0030's reason. boot's seedSkeletons is COPY-IF-MISSING, so a node
// that already carries the card never receives the repo's new paragraph; the profile copy is the
// one the operator edits and the one this migration owns.
//
// IT ADDS THE ONE PARAGRAPH, and nothing else, at the END of the card after one blank line, in the
// card's own line endings - the repo card's place and wording.
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN - setup/migrate.mjs): the card already
// says a /reply runs on, or there is no card on this node (boot's seeder plants the repo's).
//
// IT REFUSES, NAMING THE PLACE, only on a card that is not valid UTF-8 (an edit would re-encode
// bytes it never meant to touch). The repo's own card is READ-ONLY to this migration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the actions card says a /reply runs on to the next action, so a quote-reply can carry paragraphs and lists";

const CARD = ['config', 'skeletons', 'room', '10-actions.md'];
// The paragraph as the repo card carries it, one line per element.
export const PARAGRAPH = [
  'A `/reply` runs on to my next action or the end, so it can hold paragraphs and',
  'lists. My plain words go before my actions.',
];
// What "already says it" means: the rule's own opening words, wherever the operator put them.
const SAYS_IT = '`/reply` runs on';

const refuse = (why) => { throw new Error(`0031 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, ...CARD);
  if (!existsSync(file)) {
    return { satisfied: true, notes: [`there is no ${file} on this node - boot's seeder plants the repo's card, which is not this migration's to pre-empt`] };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  if (text.includes(SAYS_IT)) return { satisfied: true, notes: [`${file} already says a /reply runs on`] };

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.replace(/(\r?\n)+$/, '');
  const next = `${body}${nl}${nl}${PARAGRAPH.join(nl)}${nl}`;

  return {
    satisfied: false,
    changes: [
      `${file}: add one paragraph at the end (${PARAGRAPH.length} lines):`,
      ...PARAGRAPH.map((l) => `  + ${l}`),
      'the parser already keeps a /reply open to the next action (src/spine/reply-actions.mjs) - a being that is not told writes it on one line',
      'backup first, beside it: <file>.bak-0031-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
