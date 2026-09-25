// 0031 — the actions card says a /reply runs on. The fixture is the card as a node carried it before
// 2026-09-25, in both line endings.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, PARAGRAPH } from '../migrations/0031-the-actions-card-says-reply-runs-on.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';
import { ACTION_VERBS } from '../src/spine/reply-actions.mjs';

const OLD = [
  '# Actions',
  '',
  'Each on its own line:',
  '',
  '    /react #<id> <emoji>',
  '    /reply #<id> <text>',
  '    /media <path> [caption]',
  '    /edit #<id> <text>',
  '',
  'Messages carry their id as `#<id>`. `/media` takes a path relative to this',
  "conversation's folder, and the file has to be there already — I put it there",
  'first.',
  '',
];
const lf = (lines) => lines.join('\n');
const crlf = (lines) => lines.join('\r\n');
const AFTER_LINES = [...OLD.slice(0, -1), '', ...PARAGRAPH, ''];

function home({ card = lf(OLD) } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0031-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card != null) writeFileSync(join(h, 'config', 'skeletons', 'room', '10-actions.md'), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '10-actions.md');
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0031-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0031 — the actions card says a /reply runs on', () => {
  it('REPRODUCE: a node\'s card does not say it, so a being writes every quote-reply on one line', async () => {
    const h = home();
    expect(readFileSync(cardPath(h), 'utf8')).not.toMatch(/`\/reply` runs on/);
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('adds the one paragraph at the end, after one blank line, and nothing else', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(lf(AFTER_LINES));
    expect(baks(h)).toEqual(['10-actions.md.bak-0031-test']);
  });

  it('keeps a CRLF card CRLF', async () => {
    const h = home({ card: crlf(OLD) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(crlf(AFTER_LINES));
  });

  it('is satisfied once applied, and on a card that already says it anywhere', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    const moved = home({ card: lf(['# Actions', '', 'A `/reply` runs on - my own words.', ...OLD.slice(1)]) });
    expect((await plan(ctxFor(moved))).satisfied).toBe(true);
  });

  it('no card on this node: satisfied, the seeder plants the repo\'s', async () => {
    const p = await plan(ctxFor(home({ card: null })));
    expect(p.satisfied).toBe(true);
  });

  it('refuses a card that is not UTF-8, naming it', async () => {
    const h = home({ card: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0031 refuses: .*10-actions\.md is not valid UTF-8/);
  });

  it('the paragraph advertises no verb (no line of it starts with a slash)', () => {
    for (const l of PARAGRAPH) expect(/^\s*\//.test(l)).toBe(false);
    expect(ACTION_VERBS.has('reply')).toBe(true);
  });
});

describe('0031 through the runner', () => {
  // A real node's ledger, so the runner never loads an earlier migration against this minimal
  // fixture - 0029's and 0030's pattern.
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0031');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-25T00:00:00Z' }]))));
    return h;
  }
  const outcome = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0031-the-actions-card-says-reply-runs-on'].outcome;

  it('applied and recorded, a backup beside the card', async () => {
    const h = withLedger(home());
    const { exitCode } = await runMigrations({ through: '0031', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(outcome(h)).toBe('applied');
    expect(readFileSync(cardPath(h), 'utf8')).toBe(lf(AFTER_LINES));
    expect(baks(h).filter((f) => f.startsWith('10-actions.md.bak-0031-'))).toHaveLength(1);
  });

  it('the REPO\'s card already says it, and the migration never touches it', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '10-actions.md');
    const before = readFileSync(repoCard);
    expect(before.toString('utf8')).toContain(PARAGRAPH.join('\n'));
    await runMigrations({ through: '0031', egptHome: withLedger(home()), elevated: false, platform: 'win32', log: () => {} });
    expect(readFileSync(repoCard).equals(before)).toBe(true);
  });
});
