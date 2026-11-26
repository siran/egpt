// tests/migrations-0054-the-cards-name-msg-and-beat-to.test.mjs — migrations/0054-the-cards-name-msg-and-beat-to.mjs.
//
// The fixtures are the REPO's cards with 0054's lines taken out: what a node's card is before it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, EDITS } from '../migrations/0054-the-cards-name-msg-and-beat-to.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const ROOM = ['config', 'skeletons', 'room'];
const repo = (name) => readFileSync(join(import.meta.dirname, '..', ...ROOM, name), 'utf8');
const ADDED = [...new Set(EDITS.flatMap((e) => e.lines))];
const trimmed = new Set(ADDED.map((l) => l.trim()));
// The repo card without 0054's lines (and the blank line that set its paragraph off).
function old(name) {
  const lines = repo(name).split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (trimmed.has(l.trim())) return;
    if (l === '' && trimmed.has((lines[i - 1] ?? '').trim()) && out.at(-1) === '') return;
    out.push(l);
  });
  return out.join('\n');
}
const OLD = { '10-actions.md': old('10-actions.md'), '30-pointers.md': old('30-pointers.md') };

function home(cards = OLD) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0054-')), '.egpt');
  mkdirSync(join(h, ...ROOM), { recursive: true });
  for (const [n, t] of Object.entries(cards)) if (t !== null) writeFileSync(join(h, ...ROOM, n), t);
  return h;
}
const read = (h, n) => readFileSync(join(h, ...ROOM, n), 'utf8');
const ctxFor = (h) => ({ egptHome: h, log: () => {} });
const vaults = (h) => (existsSync(join(h, 'disposable')) ? readdirSync(join(h, 'disposable')) : []);

describe('0054 on cards as they were before /msg and beat to:', () => {
  it('REPRODUCE: the old cards lack the lines, the repo cards carry them', async () => {
    for (const n of Object.keys(OLD)) {
      expect(OLD[n]).not.toBe(repo(n));
      expect(OLD[n]).not.toContain('post:/agent: beats may add to:');
    }
    expect(OLD['10-actions.md']).not.toContain('msg <chat>');
    expect((await plan(ctxFor(home()))).satisfied).toBe(false);
  });

  it("apply: both cards become the repo's, backups hold the originals, a re-plan is satisfied", async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    for (const n of Object.keys(OLD)) expect(read(h, n)).toBe(repo(n));
    const v = vaults(h);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^migration-0054-\d{8}T\d{6}$/);
    for (const n of Object.keys(OLD)) expect(readFileSync(join(h, 'disposable', v[0], ...ROOM, n), 'utf8')).toBe(OLD[n]);
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
  });

  it('a CRLF card keeps CRLF', async () => {
    const crlf = Object.fromEntries(Object.entries(OLD).map(([n, t]) => [n, t.replace(/\n/g, '\r\n')]));
    const h = home(crlf);
    await (await plan(ctxFor(h))).apply();
    for (const n of Object.keys(OLD)) expect(read(h, n)).toBe(repo(n).replace(/\n/g, '\r\n'));
  });

  it('one card done, the other not: only the other is edited', async () => {
    const h = home({ '10-actions.md': repo('10-actions.md'), '30-pointers.md': OLD['30-pointers.md'] });
    await (await plan(ctxFor(h))).apply();
    expect(read(h, '10-actions.md')).toBe(repo('10-actions.md'));
    expect(read(h, '30-pointers.md')).toBe(repo('30-pointers.md'));
    expect(existsSync(join(h, 'disposable', vaults(h)[0], ...ROOM, '10-actions.md'))).toBe(false);
  });
});

describe('0054 is satisfied where it has nothing to do, and touches nothing', () => {
  it('already there', async () => {
    const cards = { '10-actions.md': repo('10-actions.md'), '30-pointers.md': repo('30-pointers.md') };
    const h = home(cards);
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
    expect(vaults(h)).toEqual([]);
  });

  it("no anchor lines: the operator's own cards, left alone", async () => {
    const own = { '10-actions.md': '# Mine\n', '30-pointers.md': '# Mine too\n' };
    const h = home(own);
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
    expect(read(h, '10-actions.md')).toBe(own['10-actions.md']);
    expect(vaults(h)).toEqual([]);
  });

  it('no cards on this node', async () => {
    expect(await plan(ctxFor(home({ '10-actions.md': null, '30-pointers.md': null })))).toMatchObject({ satisfied: true });
  });
});

describe('0054 refuses, naming the place', () => {
  it('a card that is not valid UTF-8', async () => {
    const h = home();
    writeFileSync(join(h, ...ROOM, '30-pointers.md'), Buffer.from([0x20, 0x2e, 0x2f, 0xff, 0xfe, 0x0a]));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0054 refuses: .*30-pointers\.md is not valid UTF-8/);
  });

  it('a card changed between plan and apply: nothing written, no backup', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(join(h, ...ROOM, '10-actions.md'), OLD['10-actions.md'] + '\nmine\n');
    await expect(p.apply()).rejects.toThrow(/0054 refuses: .*10-actions\.md changed since it was planned - re-run/);
    expect(read(h, '30-pointers.md')).toBe(OLD['30-pointers.md']);
    expect(vaults(h)).toEqual([]);
  });
});

describe('0054 through the runner', () => {
  it('applied and recorded, then in the ledger', async () => {
    const h = home();
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0054');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-11-25T00:00:00Z' }]))));
    const run = () => runMigrations({ through: '0054', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(first.results.at(-1)).toMatchObject({ id: '0054-the-cards-name-msg-and-beat-to', outcome: 'applied' });
    expect(read(h, '10-actions.md')).toBe(repo('10-actions.md'));
    expect((await run()).results.at(-1).outcome).toBe('in-ledger');
  });
});
