// 0054 — the cards say how a being posts into another chat: "/<handle> msg <chat> <text>" (actions card),
// and a beat's to: "<chat>" and /media line (pointers card).
//
// boot's seeder is copy-if-missing, so a profile card never gets the repo cards' new lines. This adds
// them to <profile>/config/skeletons/room/10-actions.md and 30-pointers.md, in each card's own line
// endings. Rooms' directives/ copies are re-copied from the card on every fresh thread.
//
// Per card, satisfied: no card on this node; the lines already there; no anchor line (the operator's own
// card, left alone — a refusal would stop the chain). Refuses: a card that is not UTF-8, or one that
// changed since it was planned. Backup: <profile>/disposable/migration-0054-<timestamp>/.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const elevated = false;
export const summary = 'the actions and pointers cards say how to post into another chat: /<handle> msg, a beat\'s to:, /media';

const ROOM = ['config', 'skeletons', 'room'];
// Each edit: insert `lines` after the line equal (trimmed) to `after`.
export const EDITS = [
  {
    file: '10-actions.md',
    after: '/edit #<id> <text>',
    indent: '    ',
    lines: ['/<handle> msg <chat> <text>'],
  },
  {
    file: '10-actions.md',
    after: 'first.',
    blank: true,
    lines: [
      '`/<handle> msg` (my own handle) posts `<text>` as me into another chat, only one I already answer in;',
      '`<chat>` is a name ("quoted" if it has spaces); several matches send nothing.',
    ],
  },
  {
    file: '30-pointers.md',
    after: 'any beat may add silent: true — posts to eGPT Admin, not this chat',
    lines: [
      'post:/agent: beats may add to: "<chat>" — posts there instead (a',
      'topic of this chat; a chat where I already answer, if it is mine)',
      'a /media <path> line in a beat\'s output sends the file (from here)',
    ],
  },
];

const refuse = (why) => { throw new Error(`0054 refuses: ${why}`); };

// The card's text with `e` applied, or null when it is already there or has no anchor.
function applied(lines, e) {
  if (lines.some((l) => l.trim() === e.lines[0].trim())) return null;
  const at = lines.findIndex((l) => l.trim() === e.after);
  if (at < 0) return null;
  const indent = e.indent ?? lines[at].match(/^\s*/)[0];
  const added = e.lines.map((l) => `${indent}${l}`);
  return [...lines.slice(0, at + 1), ...(e.blank ? ['', ...added] : added), ...lines.slice(at + 1)];
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
    else notes.push(`${name}: already says it, or has no anchor line - left alone`);
  }
  if (!jobs.length) return { satisfied: true, notes };

  return {
    satisfied: false,
    changes: [
      ...jobs.flatMap((j) => [`${[...ROOM, j.name].join('/')}:`, ...j.added.map((l) => `  + ${l}`)]),
      ...notes,
      'backup first: disposable/migration-0054-<timestamp>/<same relative path>',
    ],
    apply: async () => {
      for (const j of jobs) if (!readFileSync(j.path).equals(j.bytes)) refuse(`${j.path} changed since it was planned - re-run`);
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const vault = join(home, 'disposable', `migration-0054-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
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
