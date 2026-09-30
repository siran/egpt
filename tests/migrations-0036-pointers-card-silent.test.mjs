// tests/migrations-0036-pointers-card-silent.test.mjs — migrations/0036-the-pointers-card-says-a-beat-may-be-silent.mjs.
//
// Same shape as 0035's test (a line ADDED after 0035's block, not a line replaced). The card is a table
// a being reads, so the assertions are on the FULL text: the note is inserted right after 0035's
// "pure AI" line, at that line's own indent, in the card's own line endings. The fixture is a card as
// 0035 leaves it (CRLF, the three-kinds block present, no silent mention).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, LINE } from '../migrations/0036-the-pointers-card-says-a-beat-may-be-silent.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// 0035's three-kinds block, as the migrated profile card carries it (column 20).
const BLOCK = [
  '  ./heartbeats/     my schedule — one <name>.yaml per beat, three kinds:',
  '                    structural  when:/daily: + command:, run as me in my box;',
  '                                post: "{stdout}" says its output in this chat',
  '                    browser     browser: true + agent: + prompt:',
  '                    pure AI     agent: + prompt:',
];
const ANCHOR = '                    pure AI     agent: + prompt:';
const NOTE = `                    ${LINE}`;
const CARD_LINES = [
  '# Pointers',
  '',
  '  ./transcript.md   this thread',
  '  ./desktop/        mine — what I\'m working on right now',
  ...BLOCK,
  '  ./scripts/        *.x.md textecutables — when asked to DO something, look',
  '                    here first and carry out the steps with my own tools',
  '',
  'If I don\'t know something, I look before I say so.',
];
const AT = CARD_LINES.indexOf(ANCHOR);            // the anchor's 0-based index
const inserted = (lines) => lines.flatMap((l) => (l === ANCHOR ? [l, NOTE] : [l]));
const CARD = crlf(CARD_LINES);
const AFTER = crlf(inserted(CARD_LINES));

function home({ card = CARD } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0036-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card !== null) writeFileSync(cardPath(h), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '30-pointers.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0036-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));

describe('0036 on a card that names the three kinds but not silent', () => {
  it('REPRODUCE: the card tells a being the three kinds but never that a beat may be silent', async () => {
    const h = home();
    const text = readFileSync(cardPath(h), 'utf8');
    expect(text).toContain('pure AI     agent: + prompt:');
    expect(text).not.toContain('silent');
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('plans the one note inserted after the "pure AI" line, at that line\'s own indent', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([
      `${cardPath(h)}:${AT + 2}  a note after "pure AI     agent: + prompt:" says a beat may be silent::`,
      `  + ${NOTE}`,
      'a beat may set silent: true to post the whole beat to eGPT Admin instead of this chat (operator 2026-09-30, src/spine/heartbeat-loader.mjs) - a being never told cannot ask for it',
      'backup first, beside it: <file>.bak-0036-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from the inserted line - CRLF kept - and a re-plan reads satisfied', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cardPath(h), 'utf8');
    expect(out).toBe(AFTER);
    expect(readFileSync(`${cardPath(h)}.bak-0036-test`, 'utf8')).toBe(CARD);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a card with LF endings keeps LF', async () => {
    const h = home({ card: CARD_LINES.join('\n') + '\n' });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(inserted(CARD_LINES).join('\n') + '\n');
  });

  it('a card whose "pure AI" line is in a DIFFERENT column: the note keeps that line\'s indent', async () => {
    const h = home({ card: crlf(['# Pointers', '', '      pure AI     agent: + prompt:', '', 'I look.']) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf(['# Pointers', '', '      pure AI     agent: + prompt:', `      ${LINE}`, '', 'I look.']));
  });
});

describe('0036 is satisfied where it has nothing to do', () => {
  it('the card already mentions silent:', async () => {
    const h = home({ card: AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cardPath(h)} already mentions silent:`);
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
  });

  it('no "pure AI" line (a pre-0035 or operator-edited card), or no card on this node', async () => {
    const without = home({ card: crlf(CARD_LINES.filter((l) => l !== ANCHOR)) });
    expect(await plan(ctxFor(without))).toMatchObject({ satisfied: true });
    const none = home({ card: null });
    expect(await plan(ctxFor(none))).toMatchObject({ satisfied: true });
    expect(existsSync(cardPath(none))).toBe(false);
  });
});

describe('0036 refuses, naming the place', () => {
  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(cardPath(h), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0036 refuses: .* is not valid UTF-8/);
  });

  it('the card changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(cardPath(h), CARD.replace('# Pointers', '# Pointers (mine)'));
    await expect(p.apply()).rejects.toThrow(/0036 refuses: .*30-pointers\.md changed since it was planned - re-run/);
    expect(baks(h)).toEqual([]);
  });
});

describe('0036 through the runner', () => {
  // A real node's ledger, so the runner never loads an earlier migration against this minimal
  // fixture (not a whole node) - 0035's pattern.
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0036');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-30T00:00:00Z' }]))));
    return h;
  }
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0036-the-pointers-card-says-a-beat-may-be-silent'].outcome;

  it('applied and recorded, the note in place, a backup beside the card', async () => {
    const h = withLedger(home());
    const { exitCode } = await runMigrations({ through: '0036', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(AFTER);
    expect(baks(h).filter((f) => f.startsWith('30-pointers.md.bak-0036-'))).toHaveLength(1);
  });

  it('a card that already mentions it: recorded as already satisfied, nothing touched', async () => {
    const h = withLedger(home({ card: AFTER }));
    const { exitCode } = await runMigrations({ through: '0036', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(baks(h)).toEqual([]);
  });

  it('the REPO\'s card already carries the note, after 0035\'s block, and the migration never touches it', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md');
    const before = readFileSync(repoCard);
    const text = before.toString('utf8');
    expect(text).toContain(LINE);
    expect(text.indexOf(LINE)).toBeGreaterThan(text.indexOf('pure AI     agent: + prompt:'));
    await runMigrations({ through: '0036', egptHome: withLedger(home()), elevated: false, platform: 'win32', log: () => {} });
    expect(readFileSync(repoCard).equals(before)).toBe(true);
  });
});
