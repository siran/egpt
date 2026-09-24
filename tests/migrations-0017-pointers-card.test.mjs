// tests/migrations-0017-pointers-card.test.mjs — migrations/0017-the-pointers-card-names-the-room.mjs.
//
// The card is a TABLE a being reads, so the assertions are on the FULL text: the inserted lines
// have to land in the block's own indent, at the block's own description column, with the card's
// own line endings, or the table stops being one. kg's fixture is the live card as the profile
// carries it (no ./desktop/, no ./files/); "do" here is the same one rule reading satisfied on a
// card that already names both, not a second branch.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0017-the-pointers-card-names-the-room.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// The profile's card as it reads on a node seeded before ./desktop/ existed.
const CARD_LINES = [
  '# Pointers',
  '',
  '  ./transcript.md   this thread',
  '  ./transcripts/    older threads',
  '  ./directives/     my actions, pointers, rules',
  '  ./media/          files from this chat',
  '  ./scripts/        *.x.md textecutables — when asked to DO something, look',
  '                    here first and carry out the steps with my own tools',
  '',
  '  chrome            {{chrome.bin}}',
  '  chrome profile    {{chrome.profile_dir}}  (--user-data-dir for CDP)',
  '',
  'If I don\'t know something, I look before I say so.',
];
const CARD = crlf(CARD_LINES);
const MEDIA_LINE_NO = CARD_LINES.indexOf('  ./media/          files from this chat') + 1;

const FILES_LINE = '  ./files/          the operator\'s shelf — what /inject leaves here for me';
const DESKTOP_LINE = '  ./desktop/        mine — what I\'m working on right now';

const AFTER = crlf(CARD_LINES.flatMap((l, i) => (i === MEDIA_LINE_NO - 1 ? [l, FILES_LINE, DESKTOP_LINE] : [l])));

function home({ card = CARD } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0017-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), crlf(['# config.yaml (fixture)', 'node_name: kg']));
  if (card !== null) writeFileSync(cardPath(h), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '30-pointers.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0017-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));

describe('0017 on a card that names neither folder', () => {
  it('plans both lines, beside ./media/, in the card\'s own column', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cardPath(h)}:${MEDIA_LINE_NO + 1}-${MEDIA_LINE_NO + 2}  name ./files/ and ./desktop/ after ./media/ (2 lines):`,
      `  + ${FILES_LINE}`,
      `  + ${DESKTOP_LINE}`,
      'the room really has these folders (src/room-core.mjs ensureTree) - a being that is not told cannot use them',
      'backup first, beside it: <file>.bak-0017-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from the two inserted lines - CRLF kept, the table still a table', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cardPath(h), 'utf8');
    expect(out).toBe(AFTER);
    // Every pointer line's description still starts at the same column.
    const cols = out.split('\r\n').filter((l) => /^\s+\.\//.test(l)).map((l) => /^(\s+\.\/\S+\s+)/.exec(l)[1].length);
    expect(new Set(cols).size).toBe(1);
    expect(readFileSync(`${cardPath(h)}.bak-0017-test`, 'utf8')).toBe(CARD);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('IDEMPOTENT: a card that already names ./desktop/ gains only ./files/, and never a second copy', async () => {
    const h = home({ card: crlf(CARD_LINES.flatMap((l, i) => (i === MEDIA_LINE_NO - 1 ? [l, DESKTOP_LINE] : [l]))) });
    const p = await plan(ctxFor(h));
    expect(p.changes[0]).toBe(`${cardPath(h)}:${MEDIA_LINE_NO + 1}-${MEDIA_LINE_NO + 1}  name ./files/ after ./media/ (1 line):`);
    await p.apply();
    const out = readFileSync(cardPath(h), 'utf8');
    expect(out.split('\r\n').filter((l) => l.includes('./desktop/'))).toHaveLength(1);
    expect(out.split('\r\n').filter((l) => l.includes('./files/'))).toHaveLength(1);
  });

  it('a card with LF endings keeps LF', async () => {
    const h = home({ card: CARD_LINES.join('\n') + '\n' });
    await (await plan(ctxFor(h))).apply();
    const out = readFileSync(cardPath(h), 'utf8');
    expect(out).not.toContain('\r');
    expect(out).toBe(CARD_LINES.flatMap((l, i) => (i === MEDIA_LINE_NO - 1 ? [l, FILES_LINE, DESKTOP_LINE] : [l])).join('\n') + '\n');
  });

  it('a card with a DIFFERENT style is matched, not overwritten with this one', async () => {
    const h = home({ card: crlf(['# Pointers', '', '    ./transcript.md  this thread', '    ./media/  files from this chat']) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf([
      '# Pointers',
      '',
      '    ./transcript.md  this thread',
      '    ./media/  files from this chat',
      '    ./files/         the operator\'s shelf — what /inject leaves here for me',
      '    ./desktop/       mine — what I\'m working on right now',
    ]));
  });

  it('a card with no ./media/ line puts them after its last pointer line', async () => {
    const h = home({ card: crlf(['# Pointers', '', '  ./transcript.md   this thread', '  ./scripts/        textecutables', '', 'If I don\'t know something, I look.']) });
    const p = await plan(ctxFor(h));
    expect(p.changes[0]).toContain('after ./scripts/');
    await p.apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf([
      '# Pointers',
      '',
      '  ./transcript.md   this thread',
      '  ./scripts/        textecutables',
      FILES_LINE,
      DESKTOP_LINE,
      '',
      'If I don\'t know something, I look.',
    ]));
  });
});

describe('0017 is satisfied where it has nothing to do', () => {
  it('the card already names both', async () => {
    const h = home({ card: AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cardPath(h)} already names ./files/ and ./desktop/`);
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
  });

  it('there is no card on this node - boot\'s seeder plants the repo\'s', async () => {
    const h = home({ card: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`there is no ${cardPath(h)} on this node - boot's seeder plants the repo's card, which is not this migration's to pre-empt`);
    expect(existsSync(cardPath(h))).toBe(false);
  });
});

describe('0017 refuses, naming the place', () => {
  it('a card with no pointer lines at all', async () => {
    const h = home({ card: crlf(['# Pointers', '', 'I look before I say so.']) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0017 refuses: .*30-pointers\.md has no pointer lines .*so there is no block to join and no style to match/);
  });

  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(cardPath(h), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0017 refuses: .* is not valid UTF-8/);
  });

  it('the card changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = CARD.replace('# Pointers', '# Pointers (mine)');
    writeFileSync(cardPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0017 refuses: .*30-pointers\.md changed since it was planned - re-run/);
    expect(readFileSync(cardPath(h), 'utf8')).toBe(edited);
    expect(baks(h)).toEqual([]);
  });
});

describe('0017 through the runner', () => {
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0017-the-pointers-card-names-the-room'].outcome;

  it('kg: applied and recorded, both lines named, a backup beside the card', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ through: '0017', dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.startsWith('30-pointers.md.bak-0017-'))).toHaveLength(1);
  });

  it('a node whose card already names both: recorded as already satisfied, nothing touched', async () => {
    const h = home({ card: AFTER });
    const { exitCode } = await runMigrations({ through: '0017', dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(baks(h)).toEqual([]);
  });

  it('the REPO\'s card is never touched', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md');
    const before = readFileSync(repoCard);
    const h = home();
    await runMigrations({ through: '0017', dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(readFileSync(repoCard).equals(before)).toBe(true);
    rmSync(h, { recursive: true, force: true });
  });
});
