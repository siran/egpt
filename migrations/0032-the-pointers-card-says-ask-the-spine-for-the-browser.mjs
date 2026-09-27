// 0032 — the pointers card tells a being to ASK THE SPINE for the browser, and never to launch it.
//
// THE MEASUREMENT (operator, 2026-09-26): kg's brain Chrome (CDP :9221, config chrome.profile_dir)
// died at a reboot and being E could not bring it back. E is BOXED — it runs as a leased pool
// account — so a chrome.exe it started itself would run as the wrong user against a profile whose
// logins are sealed by DPAPI to the operator: logged out, and a risk to the profile. The spine now
// starts it on request (src/spine/being-link.mjs; the being runs src/tools/ask-spine.mjs through the
// EGPT_ASK_SPINE variable its boxed session is handed), and the operator ruled that is the ONE thing
// a boxed being may ask for: "for now only the browser". A being learns its room from ONE card,
// config/skeletons/room/30-pointers.md, and a command it is never told is a command it does not run.
//
// WHY A MIGRATION: 0017's, 0030's and 0031's reason. boot's seedSkeletons is COPY-IF-MISSING, so a
// node that already carries the card never receives the repo's new paragraph; the profile copy is
// the one the operator edits and the one this migration owns.
//
// IT ADDS THE ONE PARAGRAPH, and nothing else, in the card's own line endings: right after the
// card's chrome lines (`chrome` / `chrome profile`) with one blank line before it — the repo card's
// place, beside the profile it is about — or, with no chrome line, at the end after one blank line
// (0031's place).
//
// SATISFIED, NOT REFUSED (a refusal STOPS THE WHOLE CHAIN — setup/migrate.mjs, the 0003/0007/0011/0012
// lesson): the card already names `browser start`, wherever the operator put it, or there is no card
// on this node (boot's seeder plants the repo's).
//
// IT REFUSES, NAMING THE PLACE, only on a card that is not valid UTF-8 (an edit would re-encode bytes
// it never meant to touch).
//
// THE EDIT is a plain line insertion with a backup and a changed-since-planned check. The repo's own
// card is READ-ONLY to this migration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = "the room's pointers card tells a being to ask the spine to start the browser, and never to launch chrome.exe on its profile itself";

const CARD = ['config', 'skeletons', 'room', '30-pointers.md'];
// The paragraph as the repo card carries it, one line per element.
export const PARAGRAPH = [
  "The browser is the spine's. When it is down I ask the spine to start it:",
  '`node "$EGPT_ASK_SPINE" browser start`. I never launch chrome.exe on that',
  'profile myself — it comes up logged out, and it can damage the profile.',
];
// What "already says it" means: the request itself, wherever the operator put it.
const SAYS_IT = 'browser start';
// A chrome line of the card's pointer block: indented, then `chrome` (`chrome` and `chrome profile`).
const CHROME_LINE = /^\s+chrome\b/;

const refuse = (why) => { throw new Error(`0032 refuses: ${why}`); };

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
  const chrome = lines.map((l, i) => (CHROME_LINE.test(l) ? i : -1)).filter((i) => i >= 0);

  let next, where;
  if (chrome.length) {
    const at = chrome[chrome.length - 1] + 1;
    // One blank line before it, and one after it unless the card already has one there.
    const block = ['', ...PARAGRAPH, ...((lines[at] ?? '').trim() ? [''] : [])];
    next = [...lines.slice(0, at), ...block, ...lines.slice(at)].join(nl);
    where = `${file}:${at + 2}  add one paragraph after the chrome lines (${PARAGRAPH.length} lines):`;
  } else {
    const body = text.replace(/(\r?\n)+$/, '');
    next = `${body}${nl}${nl}${PARAGRAPH.join(nl)}${nl}`;
    where = `${file}: no chrome line to sit beside - add one paragraph at the end (${PARAGRAPH.length} lines):`;
  }

  return {
    satisfied: false,
    changes: [
      where,
      ...PARAGRAPH.map((l) => `  + ${l}`),
      'the spine starts the browser for a boxed being that asks (src/spine/being-link.mjs) - a being that is not told launches its own, logged out',
      'backup first, beside it: <file>.bak-0032-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
