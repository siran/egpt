// tests/migrations-0055-the-actions-card-says-msg-asks.test.mjs — migrations/0055-the-actions-card-says-msg-asks.mjs.
//
// The fixture is the REPO's actions card with 0055's paragraph put back as 0054 wrote it: what a node's card is before it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, EDITS } from '../migrations/0055-the-actions-card-says-msg-asks.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const ROOM = ['config', 'skeletons', 'room'];
const NAME = '10-actions.md';
const REPO = readFileSync(join(import.meta.dirname, '..', ...ROOM, NAME), 'utf8');
const [E] = EDITS;
const OLD = REPO.replace(E.lines.join('\n'), E.from.join('\n'));

function home(card = OLD) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0055-')), '.egpt');
  mkdirSync(join(h, ...ROOM), { recursive: true });
  if (card !== null) writeFileSync(join(h, ...ROOM, NAME), card);
  return h;
}
const read = (h) => readFileSync(join(h, ...ROOM, NAME), 'utf8');
const ctxFor = (h) => ({ egptHome: h, log: () => {} });
const vaults = (h) => (existsSync(join(h, 'disposable')) ? readdirSync(join(h, 'disposable')) : []);

describe('0055 on the card as 0054 left it', () => {
  it('REPRODUCE: the old card lacks the new wording, the repo card carries it', async () => {
    expect(OLD).not.toBe(REPO);
    expect(OLD).not.toContain("operator's yes");
    expect(REPO).toContain("It waits for the operator's yes before it goes.");
    expect((await plan(ctxFor(home()))).satisfied).toBe(false);
  });

  it("apply: the card becomes the repo's, the backup holds the original, a re-plan is satisfied", async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect(read(h)).toBe(REPO);
    const v = vaults(h);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^migration-0055-\d{8}T\d{6}$/);
    expect(readFileSync(join(h, 'disposable', v[0], ...ROOM, NAME), 'utf8')).toBe(OLD);
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
  });

  it('a CRLF card keeps CRLF', async () => {
    const h = home(OLD.replace(/\n/g, '\r\n'));
    await (await plan(ctxFor(h))).apply();
    expect(read(h)).toBe(REPO.replace(/\n/g, '\r\n'));
  });
});

describe('0055 is satisfied where it has nothing to do, and touches nothing', () => {
  it('already there', async () => {
    const h = home(REPO);
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
    expect(vaults(h)).toEqual([]);
  });

  it("no 0054 paragraph: the operator's own card, left alone", async () => {
    const h = home('# Mine\n');
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
    expect(read(h)).toBe('# Mine\n');
    expect(vaults(h)).toEqual([]);
  });

  it('no card on this node', async () => {
    expect(await plan(ctxFor(home(null)))).toMatchObject({ satisfied: true });
  });
});

describe('0055 refuses, naming the place', () => {
  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(join(h, ...ROOM, NAME), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0055 refuses: .*10-actions\.md is not valid UTF-8/);
  });

  it('a card changed between plan and apply: nothing written, no backup', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(join(h, ...ROOM, NAME), OLD + '\nmine\n');
    await expect(p.apply()).rejects.toThrow(/0055 refuses: .*10-actions\.md changed since it was planned - re-run/);
    expect(read(h)).toBe(OLD + '\nmine\n');
    expect(vaults(h)).toEqual([]);
  });
});

describe('0055 through the runner', () => {
  it('applied and recorded, then in the ledger', async () => {
    const h = home();
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0055');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-11-27T00:00:00Z' }]))));
    const run = () => runMigrations({ through: '0055', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(first.results.at(-1)).toMatchObject({ id: '0055-the-actions-card-says-msg-asks', outcome: 'applied' });
    expect(read(h)).toBe(REPO);
    expect((await run()).results.at(-1).outcome).toBe('in-ledger');
  });
});
