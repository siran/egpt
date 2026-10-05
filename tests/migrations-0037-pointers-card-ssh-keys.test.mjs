// tests/migrations-0037-pointers-card-ssh-keys.test.mjs — migrations/0037-the-pointers-card-names-the-ssh-keys.mjs.
//
// Same shape as 0030's test (a block ADDED after ./desktop/, not a single line), with 0035's multi-line
// block. The card is a table a being reads, so the assertions are on the FULL text: the block lands
// right after the ./desktop/ line, in the block's own indent and description column, with the card's own
// line endings. The fixture is the profile card as 0036 leaves it (CRLF, the three-kinds block + silent
// note present, no ./.ssh/).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, HEAD, REST } from '../migrations/0037-the-pointers-card-names-the-ssh-keys.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

const DESKTOP_LINE = '  ./desktop/        mine — what I\'m working on right now';
const CARD_LINES = [
  '# Pointers',
  '',
  '  ./transcript.md   this thread',
  '  ./transcripts/    older threads',
  '  ./directives/     my actions, pointers, rules',
  '  ./media/          files from this chat',
  '  ./files/          the operator\'s shelf — what he put here for me',
  DESKTOP_LINE,
  '  ./heartbeats/     my schedule — one <name>.yaml per beat, three kinds:',
  '                    structural  when:/daily: + command:, run as me in my box;',
  '                                post: "{stdout}" says its output in this chat',
  '                    browser     browser: true + agent: + prompt:',
  '                    pure AI     agent: + prompt:',
  '                    any beat may add silent: true — posts to eGPT Admin, not this chat',
  '  ./scripts/        *.x.md textecutables — when asked to DO something, look',
  '                    here first and carry out the steps with my own tools',
  '',
  '  chrome            {{chrome.bin}}',
  '  chrome profile    {{chrome.profile_dir}}  (--user-data-dir for CDP)',
  '',
  'If I don\'t know something, I look before I say so.',
];
// The block as the repo card carries it: ./.ssh/ at the block's indent, its description at column 20.
const NEW_BLOCK = [
  '  ./.ssh/           my ssh keys — PERSISTENT and backup-excluded, unlike my',
  '                    pool home\'s ~/.ssh (wiped each sandbox lease); keep and',
  '                    generate keys here, and use',
  '                    `ssh -i .ssh/<key> -o StrictModes=no`',
];
const DESKTOP_LINE_NO = CARD_LINES.indexOf(DESKTOP_LINE) + 1;
const withBlock = (lines, afterNo) => lines.flatMap((l, i) => (i === afterNo - 1 ? [l, ...NEW_BLOCK] : [l]));
const CARD = crlf(CARD_LINES);
const AFTER = crlf(withBlock(CARD_LINES, DESKTOP_LINE_NO));
const REASON = "a being's ssh keys belong here - its pool home's ~/.ssh is wiped each sandbox lease, this folder survives and is backup-excluded (operator 2026-10-04) - a being that is not told keeps keys where they vanish";

function home({ card = CARD } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0037-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card !== null) writeFileSync(cardPath(h), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '30-pointers.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0037-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));

describe('0037 on a card that does not name ./.ssh/', () => {
  it('REPRODUCE: the card names the being\'s own folders but never where its ssh keys live', async () => {
    const h = home();
    const text = readFileSync(cardPath(h), 'utf8');
    expect(text).toContain('./desktop/');
    expect(text).not.toContain('.ssh');
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('plans the block, after ./desktop/, in the card\'s own column', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([
      `${cardPath(h)}:${DESKTOP_LINE_NO + 1}  name ./.ssh/ after ./desktop/ (${NEW_BLOCK.length} lines):`,
      ...NEW_BLOCK.map((l) => `  + ${l}`),
      REASON,
      'backup first, beside it: <file>.bak-0037-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from the block - CRLF kept, the table still a table - and a re-plan reads satisfied', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cardPath(h), 'utf8');
    expect(out).toBe(AFTER);
    const cols = out.split('\r\n').filter((l) => /^\s+\.\//.test(l)).map((l) => /^(\s+\.\/\S+\s+)/.exec(l)[1].length);
    expect(new Set(cols).size).toBe(1);
    expect(readFileSync(`${cardPath(h)}.bak-0037-test`, 'utf8')).toBe(CARD);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a card with LF endings keeps LF', async () => {
    const h = home({ card: CARD_LINES.join('\n') + '\n' });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(withBlock(CARD_LINES, DESKTOP_LINE_NO).join('\n') + '\n');
  });

  it('a card in a DIFFERENT style: the block keeps the card\'s own indent and column', async () => {
    const h = home({ card: crlf(['# Pointers', '', '    ./transcript.md  this thread', '    ./desktop/       mine — now', '', 'I look.']) });
    await (await plan(ctxFor(h))).apply();
    const col = ' '.repeat(21);
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf([
      '# Pointers',
      '',
      '    ./transcript.md  this thread',
      '    ./desktop/       mine — now',
      `    ./.ssh/          ${HEAD}`,
      ...REST.map((r) => `${col}${r}`),
      '',
      'I look.',
    ]));
  });
});

describe('0037 is satisfied where it has nothing to do', () => {
  it('the card already names ./.ssh/', async () => {
    const h = home({ card: AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cardPath(h)} already names ./.ssh/`);
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
  });

  it('no ./desktop/ line to anchor on, or no card on this node', async () => {
    const without = home({ card: crlf(CARD_LINES.filter((l) => l !== DESKTOP_LINE)) });
    const p = await plan(ctxFor(without));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cardPath(without)} names no ./desktop/ to anchor on - a card without that pointer is the operator's own, left alone`);
    const none = home({ card: null });
    expect(await plan(ctxFor(none))).toMatchObject({ satisfied: true });
    expect(existsSync(cardPath(none))).toBe(false);
  });
});

describe('0037 refuses, naming the place', () => {
  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(cardPath(h), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0037 refuses: .* is not valid UTF-8/);
  });

  it('the card changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(cardPath(h), CARD.replace('# Pointers', '# Pointers (mine)'));
    await expect(p.apply()).rejects.toThrow(/0037 refuses: .*30-pointers\.md changed since it was planned - re-run/);
    expect(baks(h)).toEqual([]);
  });
});

describe('0037 through the runner', () => {
  // A real node's ledger, so the runner never loads an earlier migration against this minimal
  // fixture (not a whole node) - 0036's pattern.
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0037');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-04T00:00:00Z' }]))));
    return h;
  }
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0037-the-pointers-card-names-the-ssh-keys'].outcome;

  it('applied and recorded, the block in place, a backup beside the card', async () => {
    const h = withLedger(home());
    const { exitCode } = await runMigrations({ through: '0037', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(baks(h).filter((f) => f.startsWith('30-pointers.md.bak-0037-'))).toHaveLength(1);
  });

  it('a card that already names it: recorded as already satisfied, nothing touched', async () => {
    const h = withLedger(home({ card: AFTER }));
    const { exitCode } = await runMigrations({ through: '0037', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(baks(h)).toEqual([]);
  });

  it('the REPO\'s card already carries the block, after ./desktop/, and the migration never touches it', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md');
    const before = readFileSync(repoCard);
    const text = before.toString('utf8');
    expect(text).toContain(NEW_BLOCK.join('\n'));
    expect(text.indexOf(NEW_BLOCK[0])).toBeGreaterThan(text.indexOf('  ./desktop/'));
    await runMigrations({ through: '0037', egptHome: withLedger(home()), elevated: false, platform: 'win32', log: () => {} });
    expect(readFileSync(repoCard).equals(before)).toBe(true);
  });
});
