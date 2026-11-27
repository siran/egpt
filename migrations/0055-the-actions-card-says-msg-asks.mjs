// 0055 — the actions card says how /<handle> msg works now: it is a reply action (its own line, running on to the
// next action or the end, /media lines included) and it waits for the operator's yes.
//
// 0054 gave the card a three-line paragraph about /<handle> msg. boot's seeder is copy-if-missing, so a profile card
// never gets the repo card's new wording: this swaps that paragraph for the new one in
// <profile>/config/skeletons/room/10-actions.md, in the card's own line endings. Rooms' directives/ copies are
// re-copied from the card on every fresh thread.
//
// Satisfied: no card on this node; the new wording already there; the 0054 paragraph not found as it was (the
// operator's own card, left alone - a refusal would stop the chain). Refuses: a card that is not UTF-8, or one that
// changed since it was planned. Backup: <profile>/disposable/migration-0055-<timestamp>/.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const elevated = false;
export const summary = 'the actions card says a being\'s /<handle> msg is an action on its own line, runs on, and waits for the operator\'s yes';

const ROOM = ['config', 'skeletons', 'room'];
// Each edit: the block of lines `from` (compared trimmed, in a row) becomes `lines`.
export const EDITS = [
  {
    file: '10-actions.md',
    from: [
      '`/<handle> msg` (my own handle) posts `<text>` as me into another chat, only one I already answer in;',
      '`<chat>` is a name ("quoted" if it has spaces); several matches send nothing.',
      'It arrives exactly as I write it, no name tag, no signature, so I start with whoever it is for.',
    ],
    lines: [
      '`/<handle> msg` (my own handle) is a message for another chat, only one I already answer in.',
      'It sits on its own line anywhere after my plain words and runs on to my next action',
      'or the end, so it can take several lines, and `/media <path>` lines too (files from my folder).',
      '`<chat>` is a name ("quoted" if it has spaces); several matches send nothing.',
      'It arrives exactly as I write it, no name tag, no signature, so I start with whoever it is for.',
      'It waits for the operator\'s yes before it goes.',
    ],
  },
];

const refuse = (why) => { throw new Error(`0055 refuses: ${why}`); };

// The card's text with `e` applied, or null when it is already there or the old block is not in it.
function applied(lines, e) {
  if (lines.some((l) => l.trim() === e.lines[0].trim())) return null;
  const at = lines.findIndex((_, i) => e.from.every((f, k) => (lines[i + k] ?? '').trim() === f.trim()));
  if (at < 0) return null;
  const indent = lines[at].match(/^\s*/)[0];
  return [...lines.slice(0, at), ...e.lines.map((l) => `${indent}${l}`), ...lines.slice(at + e.from.length)];
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
      'backup first: disposable/migration-0055-<timestamp>/<same relative path>',
    ],
    apply: async () => {
      for (const j of jobs) if (!readFileSync(j.path).equals(j.bytes)) refuse(`${j.path} changed since it was planned - re-run`);
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const vault = join(home, 'disposable', `migration-0055-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
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
