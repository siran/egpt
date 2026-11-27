// 0056 — the actions card's two-line /<handle> msg paragraph gets 0055's wording too.
//
// 0054 first added a TWO-line /<handle> msg paragraph to <profile>/config/skeletons/room/10-actions.md; a later edit of
// 0054 added a third line. A node that ran 0054 before that holds only two lines, and 0055's `from` needs all three in a
// row: on that card it found nothing and recorded already-satisfied. This brings the card to 0055's wording from either
// form (the three-line one is tried first, since the two-line one is its prefix). The lines come from 0055's EDITS.
//
// Satisfied: no card on this node; the new wording already there; neither old form found (the operator's own card, left
// alone - a refusal would stop the chain). Refuses: a card that is not UTF-8, or one that changed since it was planned.
// Backup: <profile>/disposable/migration-0056-<timestamp>/.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EDITS as EDITS_0055 } from './0055-the-actions-card-says-msg-asks.mjs';

export const elevated = false;
export const summary = 'the actions card\'s two-line /<handle> msg paragraph (0054 before its third line) gets the new wording 0055 missed';

const ROOM = ['config', 'skeletons', 'room'];
// Each edit: either block of lines in `froms` (compared trimmed, in a row, longest first) becomes `lines`.
export const EDITS = EDITS_0055.map((e) => ({
  file: e.file,
  froms: [e.from, e.from.slice(0, 2)],
  lines: e.lines,
}));

const refuse = (why) => { throw new Error(`0056 refuses: ${why}`); };

// The card's text with `e` applied, or null when it is already there or no old form is in it.
function applied(lines, e) {
  if (lines.some((l) => l.trim() === e.lines[0].trim())) return null;
  for (const from of e.froms) {
    const at = lines.findIndex((_, i) => from.every((f, k) => (lines[i + k] ?? '').trim() === f.trim()));
    if (at < 0) continue;
    const indent = lines[at].match(/^\s*/)[0];
    return [...lines.slice(0, at), ...e.lines.map((l) => `${indent}${l}`), ...lines.slice(at + from.length)];
  }
  return null;
}

export async function plan(ctx) {
  const home = ctx.egptHome;
  const jobs = [], notes = [];
  for (const name of [...new Set(EDITS.map((e) => e.file))]) {
    const path = join(home, ...ROOM, name);
    if (!existsSync(path)) { notes.push(`there is no ${path} on this node - boot's seeder plants the repo's card`); continue; }
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${path} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
    let lines = text.split(/\r?\n/);
    const added = [];
    for (const e of EDITS.filter((x) => x.file === name)) {
      const next = applied(lines, e);
      if (next) { lines = next; added.push(...e.lines); }
    }
    if (added.length) jobs.push({ name, path, bytes, added, next: lines.join(text.includes('\r\n') ? '\r\n' : '\n') });
    else notes.push(`${name}: already says it, or has no 0054 paragraph to replace - left alone`);
  }
  if (!jobs.length) return { satisfied: true, notes };

  return {
    satisfied: false,
    changes: [
      ...jobs.flatMap((j) => [`${[...ROOM, j.name].join('/')}: the /<handle> msg paragraph becomes`, ...j.added.map((l) => `  + ${l}`)]),
      ...notes,
      'backup first: disposable/migration-0056-<timestamp>/<same relative path>',
    ],
    apply: async () => {
      for (const j of jobs) if (!readFileSync(j.path).equals(j.bytes)) refuse(`${j.path} changed since it was planned - re-run`);
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const vault = join(home, 'disposable', `migration-0056-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
      for (const j of jobs) {
        const to = join(vault, ...ROOM, j.name);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(j.path, to);
        writeFileSync(j.path, j.next, 'utf8');
      }
      ctx.log(`backups: ${vault}`);
    },
  };
}
