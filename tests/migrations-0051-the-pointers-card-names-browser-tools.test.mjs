// tests/migrations-0051-the-pointers-card-names-browser-tools.test.mjs — migrations/0051-the-pointers-card-names-browser-tools.mjs.
//
// The fixture is a profile card as 0038 leaves it (reve's: LF, the EGPT_CDP lines, no browser-tools.mjs).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, ANCHOR, CARD_LINES } from '../migrations/0051-the-pointers-card-names-browser-tools.mjs';
import { CARD_LINES as CDP_LINES } from '../migrations/0038-being-scripts-reach-chrome-through-the-spine.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const REL = 'config/skeletons/room/30-pointers.md';
const BEFORE = [
  '# Pointers',
  '',
  '  ./transcript.md   this thread',
  '  ./desktop/        mine — what I\'m working on right now',
  '',
  "The browser is the spine's. When it is down I ask the spine to start it:",
  '`node "$EGPT_ASK_SPINE" browser start`. I never launch chrome.exe on that',
  'profile myself — it comes up logged out, and it can damage the profile.',
  ...CDP_LINES,
  '',
  "If I don't know something, I look before I say so.",
  '',
];
const AT = BEFORE.indexOf(ANCHOR) + 1;
const AFTER = [...BEFORE.slice(0, AT), ...CARD_LINES, ...BEFORE.slice(AT)];

function home(card = BEFORE.join('\n')) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0051-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card !== null) writeFileSync(join(h, REL), card);
  return h;
}
const read = (h) => readFileSync(join(h, REL), 'utf8');
const ctxFor = (h) => ({ egptHome: h, log: () => {} });
const vaults = (h) => (existsSync(join(h, 'disposable')) ? readdirSync(join(h, 'disposable')) : []);

describe('0051 on a card as 0038 leaves it', () => {
  it('REPRODUCE: the card says how scripts reach the browser, never that browser-tools.mjs clicks and types like a person', async () => {
    const h = home();
    expect(read(h)).toContain('EGPT_CDP');
    expect(read(h)).not.toContain('browser-tools.mjs');
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('the anchor is 0038\'s last card line, and the new lines name the tool beside $EGPT_ASK_SPINE', () => {
    expect(ANCHOR).toBe("the usual localhost:9221 /json and ws:// URLs reach my chat's browser.");
    expect(CARD_LINES.join('\n')).toContain('node "$(dirname "$EGPT_ASK_SPINE")/browser-tools.mjs" <url part>');
  });

  it('plans the lines right after the anchor, and the backup', async () => {
    const h = home();
    expect((await plan(ctxFor(h))).changes).toEqual([
      `${REL}:${AT + 1}  after 0038's EGPT_CDP lines:`,
      ...CARD_LINES.map((l) => `  + ${l}`),
      'backup first: disposable/migration-0051-<timestamp>/config/skeletons/room/30-pointers.md',
    ]);
  });

  it('apply: byte-identical apart from the lines, LF kept; the backup holds the original; a re-plan is satisfied', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(read(h)).toBe(AFTER.join('\n'));
    const v = vaults(h);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^migration-0051-\d{8}T\d{6}$/);
    expect(readFileSync(join(h, 'disposable', v[0], REL), 'utf8')).toBe(BEFORE.join('\n'));
    const again = await plan(ctx);
    expect(again).toMatchObject({ satisfied: true });
    expect(again.notes).toEqual([`${join(h, REL)} already names browser-tools.mjs`]);
  });

  it('a CRLF card keeps CRLF', async () => {
    const h = home(BEFORE.join('\r\n'));
    await (await plan(ctxFor(h))).apply();
    expect(read(h)).toBe(AFTER.join('\r\n'));
  });
});

describe('0051 is satisfied where it has nothing to do, and touches nothing', () => {
  it('the lines are already there, even moved elsewhere by the operator', async () => {
    const moved = [...BEFORE.slice(0, 2), ...CARD_LINES, ...BEFORE.slice(2)].join('\n');
    for (const card of [AFTER.join('\n'), moved]) {
      const h = home(card);
      expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
      expect(read(h)).toBe(card);
      expect(vaults(h)).toEqual([]);
    }
  });

  it('no 0038 line to anchor on: the operator\'s own card, left alone with a note', async () => {
    const h = home(BEFORE.filter((l) => l !== ANCHOR).join('\n'));
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`${join(h, REL)} has no line "${ANCHOR}" to anchor on - a card without 0038's lines is the operator's own, left alone`]);
  });

  it('no card on this node', async () => {
    const h = home(null);
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
    expect(existsSync(join(h, REL))).toBe(false);
  });
});

describe('0051 refuses, naming the place', () => {
  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(join(h, REL), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0051 refuses: .*30-pointers\.md is not valid UTF-8/);
  });

  it('the card changed between plan and apply: nothing written, no backup', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(join(h, REL), BEFORE.join('\n').replace('# Pointers', '# Pointers (mine)'));
    await expect(p.apply()).rejects.toThrow(/0051 refuses: .*30-pointers\.md changed since it was planned - re-run/);
    expect(read(h)).toContain('# Pointers (mine)');
    expect(vaults(h)).toEqual([]);
  });
});

describe('0051 through the runner', () => {
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0051');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-26T00:00:00Z' }]))));
    return h;
  }
  const run = (h) => runMigrations({ through: '0051', egptHome: h, elevated: false, platform: 'win32', log: () => {} });

  it('applied and recorded, then in the ledger', async () => {
    const h = withLedger(home());
    const first = await run(h);
    expect(first.exitCode).toBe(0);
    expect(first.results.at(-1)).toMatchObject({ id: '0051-the-pointers-card-names-browser-tools', outcome: 'applied' });
    expect(read(h)).toBe(AFTER.join('\n'));
    expect((await run(h)).results.at(-1).outcome).toBe('in-ledger');
  });

  it('the REPO\'s card carries the same lines right after the anchor, and the migration never touches it', async () => {
    const repoCard = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md');
    const before = readFileSync(repoCard);
    const lines = before.toString('utf8').split('\n');
    const at = lines.indexOf(ANCHOR);
    expect(lines.slice(at + 1, at + 1 + CARD_LINES.length)).toEqual(CARD_LINES);
    await run(withLedger(home()));
    expect(readFileSync(repoCard).equals(before)).toBe(true);
  });
});
