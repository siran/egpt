// tests/migrations-0033-pointers-card-read-only-mounts.test.mjs — migrations/0033-the-pointers-card-names-the-read-only-mounts.mjs.
//
// Same shape as 0032's test (same card), with a block BEFORE the chrome lines instead of a paragraph
// after them. The card is a text a being reads, so the assertions are on the FULL text: the block lands
// before the chrome lines with one blank line on each side, in the card's own line endings. The fixture
// is the profile card as 0032 left it (CRLF, ./heartbeats/ named, the browser paragraph in place).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, BLOCK } from '../migrations/0033-the-pointers-card-names-the-read-only-mounts.mjs';
import { PARAGRAPH } from '../migrations/0032-the-pointers-card-says-ask-the-spine-for-the-browser.mjs';
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
  '  ./heartbeats/     my schedule — one <name>.yaml per beat, turns only (agent: + prompt:)',
  '  ./scripts/        *.x.md textecutables — when asked to DO something, look',
  '                    here first and carry out the steps with my own tools',
  '',
  '  chrome            {{chrome.bin}}',
  '  chrome profile    {{chrome.profile_dir}}  (--user-data-dir for CDP)',
  '',
  ...PARAGRAPH,
  '',
  'If I don\'t know something, I look before I say so.',
];
const CHROME_LINE_NO = CARD_LINES.indexOf('  chrome            {{chrome.bin}}') + 1;
const withBlock = (lines, beforeNo) => lines.flatMap((l, i) => (i === beforeNo - 1 ? [...BLOCK, '', l] : [l]));
const CARD = crlf(CARD_LINES);
const AFTER = crlf(withBlock(CARD_LINES, CHROME_LINE_NO));

function home({ card = CARD } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0033-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card !== null) writeFileSync(cardPath(h), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '30-pointers.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0033-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));

describe('0033 on a card that never names the read-only mounts', () => {
  it('REPRODUCE: the profile card names the room and the browser, and neither ~/src/ nor ~/repos/', async () => {
    const h = home();
    const text = readFileSync(cardPath(h), 'utf8');
    expect(text).not.toMatch(/~\/src\//);
    expect(text).not.toMatch(/~\/repos\//);
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('plans one block, before the chrome lines', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([
      `${cardPath(h)}:${CHROME_LINE_NO}  add one block before the chrome lines (${BLOCK.length} lines):`,
      ...BLOCK.map((l) => `  + ${l}`),
      'a sandboxed being has ~/src (the eGPT checkout) and ~/repos (~\\src\\siran) mounted read-only (setup/sandbox-account.ps1) - a being that is not told does not look',
      'backup first, beside it: <file>.bak-0033-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from the block - CRLF kept, one blank line each side - and a re-plan reads satisfied', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(readFileSync(`${cardPath(h)}.bak-0033-test`, 'utf8')).toBe(CARD);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a card with LF endings keeps LF', async () => {
    const h = home({ card: CARD_LINES.join('\n') + '\n' });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(withBlock(CARD_LINES, CHROME_LINE_NO).join('\n') + '\n');
  });

  it('chrome lines with no blank line above them: the block still gets one on each side', async () => {
    const lines = ['# Pointers', '', '  ./media/  files', '  chrome    C:/x/chrome.exe'];
    const h = home({ card: crlf(lines) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf(['# Pointers', '', '  ./media/  files', '', ...BLOCK, '', '  chrome    C:/x/chrome.exe']));
  });

  it('a card with NO chrome line: the block goes at the end after one blank line', async () => {
    const h = home({ card: crlf(['# Pointers', '', '  ./media/  files from this chat', '', 'I look.']) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf(['# Pointers', '', '  ./media/  files from this chat', '', 'I look.', '', ...BLOCK]));
  });

  it('the block names the two mounts the launcher plants, read-only, and says only a sandboxed being has them', () => {
    const text = BLOCK.join('\n');
    expect(text).toMatch(/sandboxed/);
    expect(text).toMatch(/read-only/);
    expect(text).toMatch(/^ {2}~\/src\/ /m);
    expect(text).toMatch(/^ {2}~\/repos\/ /m);
    // `repos` is optional per node (the launcher passes it only where ~\src\siran exists and the
    // provisioner has granted it).
    expect(text).toMatch(/not every node has them/);
  });
});

describe('0033 is satisfied where it has nothing to do', () => {
  it('the card already names ~/repos/, wherever the operator put it', async () => {
    const h = home({ card: AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cardPath(h)} already names ~/repos/`);
    const moved = home({ card: crlf(['# Pointers', '', 'My repos: ~/repos/ (read-only).']) });
    expect((await plan(ctxFor(moved))).satisfied).toBe(true);
  });

  it('there is no card on this node - boot\'s seeder plants the repo\'s', async () => {
    const h = home({ card: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(existsSync(cardPath(h))).toBe(false);
  });
});

describe('0033 refuses, naming the place', () => {
  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(cardPath(h), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0033 refuses: .* is not valid UTF-8/);
  });

  it('the card changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(cardPath(h), CARD.replace('# Pointers', '# Pointers (mine)'));
    await expect(p.apply()).rejects.toThrow(/0033 refuses: .*30-pointers\.md changed since it was planned - re-run/);
    expect(baks(h)).toEqual([]);
  });
});

describe('0033 through the runner', () => {
  // A real node's ledger, so the runner never loads an earlier migration against this minimal
  // fixture - 0029's, 0030's, 0031's and 0032's pattern.
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0033');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-28T00:00:00Z' }]))));
    return h;
  }
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0033-the-pointers-card-names-the-read-only-mounts'].outcome;

  it('applied and recorded, a backup beside the card', async () => {
    const h = withLedger(home());
    const { exitCode } = await runMigrations({ through: '0033', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(baks(h).filter((f) => f.startsWith('30-pointers.md.bak-0033-'))).toHaveLength(1);
  });

  it('a card that already says it: recorded as already satisfied, nothing touched', async () => {
    const h = withLedger(home({ card: AFTER }));
    const { exitCode } = await runMigrations({ through: '0033', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(baks(h)).toEqual([]);
  });

  it('the REPO\'s card already says it, in the same place, and the migration never touches it', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md');
    const before = readFileSync(repoCard);
    const text = before.toString('utf8');
    expect(text).toContain(BLOCK.join('\n'));
    expect(text.indexOf(BLOCK[0])).toBeLessThan(text.indexOf('  chrome            {{chrome.bin}}'));
    await runMigrations({ through: '0033', egptHome: withLedger(home()), elevated: false, platform: 'win32', log: () => {} });
    expect(readFileSync(repoCard).equals(before)).toBe(true);
  });
});
