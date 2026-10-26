// 0051 — the pointers card says how a being clicks and types in its browser like a person:
// browser-tools.mjs's CLI, which sits beside $EGPT_ASK_SPINE (src/tools/), boxed or not.
//
// boot's seeder is copy-if-missing, so a profile card never gets the repo card's new lines. This adds
// them to <profile>/config/skeletons/room/30-pointers.md right after 0038's EGPT_CDP lines, in the
// card's own line endings. Rooms' directives/ copies are re-copied from it on every fresh thread.
//
// Satisfied: no card on this node; the lines already there (anywhere); no 0038 line to anchor on (the
// operator's own card, left alone — a refusal would stop the chain). Refuses: a card that is not UTF-8,
// or one that changed since it was planned. Backup: <profile>/disposable/migration-0051-<timestamp>/.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CARD_LINES as CDP_LINES } from './0038-being-scripts-reach-chrome-through-the-spine.mjs';

export const elevated = false;
export const summary = 'the pointers card says browser-tools.mjs, beside $EGPT_ASK_SPINE, clicks and types like a person';

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
export const ANCHOR = CDP_LINES.at(-1);
export const CARD_LINES = [
  'I click and type in it like a person with',
  '`node "$(dirname "$EGPT_ASK_SPINE")/browser-tools.mjs" <url part>` and one of',
  '`list`, `click <text>`, `clickSel <css>`, `type <css> <text>`, `text [n]`.',
];

const refuse = (why) => { throw new Error(`0051 refuses: ${why}`); };
const blockAt = (lines, block) => lines.findIndex((_, i) => block.every((b, j) => lines[i + j] === b));

export async function plan(ctx) {
  const home = ctx.egptHome;
  const path = join(home, ...CARD);
  if (!existsSync(path)) return { satisfied: true, notes: [`there is no ${path} on this node - boot's seeder plants the repo's card`] };
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${path} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  const lines = text.split(/\r?\n/);
  if (blockAt(lines, CARD_LINES) >= 0) return { satisfied: true, notes: [`${path} already names browser-tools.mjs`] };
  const at = lines.indexOf(ANCHOR);
  if (at < 0) return { satisfied: true, notes: [`${path} has no line "${ANCHOR}" to anchor on - a card without 0038's lines is the operator's own, left alone`] };
  const next = [...lines.slice(0, at + 1), ...CARD_LINES, ...lines.slice(at + 1)].join(text.includes('\r\n') ? '\r\n' : '\n');
  const rel = CARD.join('/');

  return {
    satisfied: false,
    changes: [
      `${rel}:${at + 2}  after 0038's EGPT_CDP lines:`,
      ...CARD_LINES.map((l) => `  + ${l}`),
      `backup first: disposable/migration-0051-<timestamp>/${rel}`,
    ],
    apply: async () => {
      if (!readFileSync(path).equals(bytes)) refuse(`${path} changed since it was planned - re-run`);
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const to = join(home, 'disposable', `migration-0051-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`, ...CARD);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(path, to);
      writeFileSync(path, next, 'utf8');
      ctx.log(`backup: ${to}`);
    },
  };
}
