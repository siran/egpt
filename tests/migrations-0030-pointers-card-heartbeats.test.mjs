// tests/migrations-0030-pointers-card-heartbeats.test.mjs — migrations/0030-the-pointers-card-names-heartbeats.mjs.
//
// Same shape as 0017's test, one line instead of two. The card is a TABLE a being reads, so the
// assertions are on the FULL text: the line lands in the block's own indent, at its own description
// column, with the card's own line endings. The fixture is the profile card as 0017 left it (CRLF,
// ./files/ and ./desktop/ already named).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0030-the-pointers-card-names-heartbeats.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

const CARD_LINES = [
  '# Pointers',
  '',
  '  ./transcript.md   this thread',
  '  ./transcripts/    older threads',
  '  ./directives/     my actions, pointers, rules',
  '  ./media/          files from this chat',
  '  ./files/          the operator\'s shelf — what /inject leaves here for me',
  '  ./desktop/        mine — what I\'m working on right now',
  '  ./scripts/        *.x.md textecutables — when asked to DO something, look',
  '                    here first and carry out the steps with my own tools',
  '',
  '  chrome            {{chrome.bin}}',
  '  chrome profile    {{chrome.profile_dir}}  (--user-data-dir for CDP)',
  '',
  'If I don\'t know something, I look before I say so.',
];
const DESKTOP_LINE_NO = CARD_LINES.indexOf('  ./desktop/        mine — what I\'m working on right now') + 1;
const HEARTBEATS_LINE = '  ./heartbeats/     my schedule — one <name>.yaml per beat, turns only (agent: + prompt:)';
const withLine = (lines, afterNo, line) => lines.flatMap((l, i) => (i === afterNo - 1 ? [l, line] : [l]));
const CARD = crlf(CARD_LINES);
const AFTER = crlf(withLine(CARD_LINES, DESKTOP_LINE_NO, HEARTBEATS_LINE));

function home({ card = CARD } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0030-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card !== null) writeFileSync(cardPath(h), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '30-pointers.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0030-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));

describe('0030 on a card that does not name ./heartbeats/', () => {
  it('plans one line, after ./desktop/, in the card\'s own column', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cardPath(h)}:${DESKTOP_LINE_NO + 1}  name ./heartbeats/ after ./desktop/ (1 line):`,
      `  + ${HEARTBEATS_LINE}`,
      'the room really has this folder (src/room-core.mjs ensureTree) - a being that is not told cannot use it',
      'backup first, beside it: <file>.bak-0030-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from the one line - CRLF kept, the table still a table - and a re-plan reads satisfied', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cardPath(h), 'utf8');
    expect(out).toBe(AFTER);
    const cols = out.split('\r\n').filter((l) => /^\s+\.\//.test(l)).map((l) => /^(\s+\.\/\S+\s+)/.exec(l)[1].length);
    expect(new Set(cols).size).toBe(1);
    expect(readFileSync(`${cardPath(h)}.bak-0030-test`, 'utf8')).toBe(CARD);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a card with LF endings keeps LF', async () => {
    const h = home({ card: CARD_LINES.join('\n') + '\n' });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(withLine(CARD_LINES, DESKTOP_LINE_NO, HEARTBEATS_LINE).join('\n') + '\n');
  });

  it('a card with a DIFFERENT style and no ./desktop/ line: matched, after its last pointer line', async () => {
    const h = home({ card: crlf(['# Pointers', '', '    ./transcript.md  this thread', '    ./media/  files from this chat', '', 'I look.']) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf([
      '# Pointers',
      '',
      '    ./transcript.md  this thread',
      '    ./media/  files from this chat',
      '    ./heartbeats/    my schedule — one <name>.yaml per beat, turns only (agent: + prompt:)',
      '',
      'I look.',
    ]));
  });
});

describe('0030 is satisfied where it has nothing to do', () => {
  it('the card already names ./heartbeats/', async () => {
    const h = home({ card: AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cardPath(h)} already names ./heartbeats/`);
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
  });

  it('there is no card on this node - boot\'s seeder plants the repo\'s', async () => {
    const h = home({ card: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(existsSync(cardPath(h))).toBe(false);
  });
});

describe('0030 refuses, naming the place', () => {
  it('a card with no pointer lines at all', async () => {
    const h = home({ card: crlf(['# Pointers', '', 'I look before I say so.']) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0030 refuses: .*30-pointers\.md has no pointer lines/);
  });

  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(cardPath(h), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0030 refuses: .* is not valid UTF-8/);
  });

  it('the card changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(cardPath(h), CARD.replace('# Pointers', '# Pointers (mine)'));
    await expect(p.apply()).rejects.toThrow(/0030 refuses: .*30-pointers\.md changed since it was planned - re-run/);
    expect(baks(h)).toEqual([]);
  });
});

describe('0030 through the runner', () => {
  // A real node's ledger, so the runner never loads an earlier migration against this minimal
  // fixture (not a whole node, and not meant to satisfy them) - 0029's pattern.
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0030');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-25T00:00:00Z' }]))));
    return h;
  }
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0030-the-pointers-card-names-heartbeats'].outcome;

  it('applied and recorded, the line named, a backup beside the card', async () => {
    const h = withLedger(home());
    const { exitCode } = await runMigrations({ through: '0030', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(baks(h).filter((f) => f.startsWith('30-pointers.md.bak-0030-'))).toHaveLength(1);
  });

  it('a card that already names it: recorded as already satisfied, nothing touched', async () => {
    const h = withLedger(home({ card: AFTER }));
    const { exitCode } = await runMigrations({ through: '0030', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(baks(h)).toEqual([]);
  });

  it('the REPO\'s card already names it, so a fresh seed needs nothing - and the migration never touches it', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md');
    const before = readFileSync(repoCard);
    expect(before.toString('utf8')).toContain(HEARTBEATS_LINE);
    await runMigrations({ through: '0030', egptHome: withLedger(home()), elevated: false, platform: 'win32', log: () => {} });
    expect(readFileSync(repoCard).equals(before)).toBe(true);
  });
});
