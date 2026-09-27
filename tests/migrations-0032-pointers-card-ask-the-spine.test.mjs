// tests/migrations-0032-pointers-card-ask-the-spine.test.mjs — migrations/0032-the-pointers-card-says-ask-the-spine-for-the-browser.mjs.
//
// Same shape as 0030's test (same card), with 0031's paragraph instead of a pointer line. The card is
// a text a being reads, so the assertions are on the FULL text: the paragraph lands after the chrome
// lines with one blank line on each side, in the card's own line endings. The fixture is the profile
// card as 0030 left it (CRLF, ./heartbeats/ named, the chrome lines in place).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, PARAGRAPH } from '../migrations/0032-the-pointers-card-says-ask-the-spine-for-the-browser.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';
import { ASK_SPINE_ENV } from '../src/shell/being.mjs';

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
  '  ./heartbeats/     my schedule — one <name>.yaml per beat, turns only (agent: + prompt:)',
  '  ./scripts/        *.x.md textecutables — when asked to DO something, look',
  '                    here first and carry out the steps with my own tools',
  '',
  '  chrome            {{chrome.bin}}',
  '  chrome profile    {{chrome.profile_dir}}  (--user-data-dir for CDP)',
  '',
  'If I don\'t know something, I look before I say so.',
];
const PROFILE_LINE_NO = CARD_LINES.indexOf('  chrome profile    {{chrome.profile_dir}}  (--user-data-dir for CDP)') + 1;
const withParagraph = (lines, afterNo) => lines.flatMap((l, i) => (i === afterNo - 1 ? [l, '', ...PARAGRAPH] : [l]));
const CARD = crlf(CARD_LINES);
const AFTER = crlf(withParagraph(CARD_LINES, PROFILE_LINE_NO));

function home({ card = CARD } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0032-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card !== null) writeFileSync(cardPath(h), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '30-pointers.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0032-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));

describe('0032 on a card that does not tell a being to ask the spine', () => {
  it('REPRODUCE: the profile card names the chrome profile and says nothing about who starts the browser', async () => {
    const h = home();
    expect(readFileSync(cardPath(h), 'utf8')).not.toMatch(/browser start/);
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('plans one paragraph, after the chrome lines', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([
      `${cardPath(h)}:${PROFILE_LINE_NO + 2}  add one paragraph after the chrome lines (${PARAGRAPH.length} lines):`,
      ...PARAGRAPH.map((l) => `  + ${l}`),
      'the spine starts the browser for a boxed being that asks (src/spine/being-link.mjs) - a being that is not told launches its own, logged out',
      'backup first, beside it: <file>.bak-0032-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from the paragraph - CRLF kept, one blank line each side - and a re-plan reads satisfied', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(readFileSync(`${cardPath(h)}.bak-0032-test`, 'utf8')).toBe(CARD);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a card with LF endings keeps LF', async () => {
    const h = home({ card: CARD_LINES.join('\n') + '\n' });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(withParagraph(CARD_LINES, PROFILE_LINE_NO).join('\n') + '\n');
  });

  it('chrome lines at the very end of the card: the paragraph follows them and the file still ends in one newline', async () => {
    const lines = ['# Pointers', '', '  ./media/  files', '', '  chrome    C:/x/chrome.exe'];
    const h = home({ card: crlf(lines) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf([...lines, '', ...PARAGRAPH]));
  });

  it('a card with NO chrome line: the paragraph goes at the end after one blank line', async () => {
    const h = home({ card: crlf(['# Pointers', '', '  ./media/  files from this chat', '', 'I look.']) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf(['# Pointers', '', '  ./media/  files from this chat', '', 'I look.', '', ...PARAGRAPH]));
  });

  it('the paragraph names the variable the spine actually hands a boxed session', () => {
    expect(PARAGRAPH.join('\n')).toContain(`"$${ASK_SPINE_ENV}" browser start`);
  });
});

describe('0032 is satisfied where it has nothing to do', () => {
  it('the card already names browser start, wherever the operator put it', async () => {
    const h = home({ card: AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cardPath(h)} already names browser start`);
    const moved = home({ card: crlf(['# Pointers', '', 'Browser down? `browser start` via the spine.']) });
    expect((await plan(ctxFor(moved))).satisfied).toBe(true);
  });

  it('there is no card on this node - boot\'s seeder plants the repo\'s', async () => {
    const h = home({ card: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(existsSync(cardPath(h))).toBe(false);
  });
});

describe('0032 refuses, naming the place', () => {
  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(cardPath(h), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0032 refuses: .* is not valid UTF-8/);
  });

  it('the card changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(cardPath(h), CARD.replace('# Pointers', '# Pointers (mine)'));
    await expect(p.apply()).rejects.toThrow(/0032 refuses: .*30-pointers\.md changed since it was planned - re-run/);
    expect(baks(h)).toEqual([]);
  });
});

describe('0032 through the runner', () => {
  // A real node's ledger, so the runner never loads an earlier migration against this minimal
  // fixture - 0029's, 0030's and 0031's pattern.
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0032');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-26T00:00:00Z' }]))));
    return h;
  }
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0032-the-pointers-card-says-ask-the-spine-for-the-browser'].outcome;

  it('applied and recorded, a backup beside the card', async () => {
    const h = withLedger(home());
    const { exitCode } = await runMigrations({ through: '0032', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(baks(h).filter((f) => f.startsWith('30-pointers.md.bak-0032-'))).toHaveLength(1);
  });

  it('a card that already says it: recorded as already satisfied, nothing touched', async () => {
    const h = withLedger(home({ card: AFTER }));
    const { exitCode } = await runMigrations({ through: '0032', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(baks(h)).toEqual([]);
  });

  it('the REPO\'s card already says it, and the migration never touches it', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md');
    const before = readFileSync(repoCard);
    expect(before.toString('utf8')).toContain(PARAGRAPH.join('\n'));
    await runMigrations({ through: '0032', egptHome: withLedger(home()), elevated: false, platform: 'win32', log: () => {} });
    expect(readFileSync(repoCard).equals(before)).toBe(true);
  });
});
