// 0042 — the actions card drops /transcribe. Fixture: the card as 0041 left it, in both line endings.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { plan, VERB, PARAGRAPH } from '../migrations/0042-the-actions-card-drops-transcribe.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const BEFORE = [
  '# Actions',
  '',
  'Each on its own line:',
  '',
  '    /react #<id> <emoji>',
  '    /reply #<id> <text>',
  '    /media <path> [caption]',
  '    /edit #<id> <text>',
];
const AFTER = [
  '',
  'Messages carry their id as `#<id>`. `/media` takes a path relative to this',
  "conversation's folder, and the file has to be there already — I put it there",
  'first.',
  '',
  'A `/reply` runs on to my next action or the end, so it can hold paragraphs and',
  'lists. My plain words go before my actions.',
];
const CLEAN = [...BEFORE, ...AFTER, ''];
const BY_0041 = [...BEFORE, VERB, ...AFTER, '', ...PARAGRAPH, ''];
const lf = (lines) => lines.join('\n');
const crlf = (lines) => lines.join('\r\n');
const REPO_CARD = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '10-actions.md');

const CARD = ['config', 'skeletons', 'room', '10-actions.md'];
const CONV = ['conversations', 'whatsapp', 'Rodz-2610010000', 'directives', '10-actions.md'];
const ROOM = ['rooms', 'acim', 'directives', '10-actions.md'];
const AGENT = ['agents', 'wren', 'directives', '10-actions.md'];

function home(files = { card: lf(BY_0041) }) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0042-')), '.egpt');
  const put = (parts, text) => { const f = join(h, ...parts); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
  mkdirSync(h, { recursive: true });
  if (files.card != null) put(CARD, files.card);
  if (files.conv != null) put(CONV, files.conv);
  if (files.room != null) put(ROOM, files.room);
  if (files.agent != null) put(AGENT, files.agent);
  mkdirSync(join(h, 'config'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), 'node_name: kg\npeer_nodes: [kg, do]\n');
  return h;
}
const read = (h, parts) => readFileSync(join(h, ...parts), 'utf8');
const baks = (h) => readdirSync(join(h, ...CARD.slice(0, -1))).filter((f) => f.includes('.bak-'));
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0042-test`; writeFileSync(to, readFileSync(f)); return to; } });
const run = async (h) => { const p = await plan(ctxFor(h)); expect(p.satisfied).toBe(false); await p.apply(); };

describe('0042 — the actions card drops /transcribe', () => {
  it("REPRODUCE: a node's card still teaches /transcribe after 0041", async () => {
    const h = home();
    expect(read(h, CARD)).toContain('/transcribe');
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it("drops exactly 0041's lines: the card becomes the repo's, backup beside it", async () => {
    const h = home();
    await run(h);
    expect(read(h, CARD)).toBe(lf(CLEAN));
    expect(read(h, CARD)).toBe(readFileSync(REPO_CARD, 'utf8'));
    expect(baks(h)).toEqual(['10-actions.md.bak-0042-test']);
    expect(readFileSync(join(h, ...CARD) + '.bak-0042-test', 'utf8')).toBe(lf(BY_0041));
  });

  it('keeps a CRLF card CRLF', async () => {
    const h = home({ card: crlf(BY_0041) });
    await run(h);
    expect(read(h, CARD)).toBe(crlf(CLEAN));
  });

  it('cleans every directives copy; backups go to disposable/, not into directives/', async () => {
    const h = home({ card: lf(CLEAN), conv: crlf(BY_0041), room: lf(BY_0041), agent: lf(CLEAN) });
    await run(h);
    expect(read(h, CONV)).toBe(crlf(CLEAN));
    expect(read(h, ROOM)).toBe(lf(CLEAN));
    expect(read(h, AGENT)).toBe(lf(CLEAN));
    expect(baks(h)).toEqual([]);
    expect(readdirSync(join(h, ...CONV.slice(0, -1)))).toEqual(['10-actions.md']);
    const [vault] = readdirSync(join(h, 'disposable'));
    expect(vault).toMatch(/^migration-0042-\d{8}T\d{6}$/);
    expect(readFileSync(join(h, 'disposable', vault, ...CONV), 'utf8')).toBe(crlf(BY_0041));
    expect(readFileSync(join(h, 'disposable', vault, ...ROOM), 'utf8')).toBe(lf(BY_0041));
    expect(existsSync(join(h, 'disposable', vault, ...AGENT))).toBe(false);
  });

  it('a paragraph with text after it keeps one blank line between its neighbours', async () => {
    const h = home({ card: lf([...BEFORE, VERB, ...AFTER, '', ...PARAGRAPH, '', 'My own line.', '']) });
    await run(h);
    expect(read(h, CARD)).toBe(lf([...BEFORE, ...AFTER, '', 'My own line.', '']));
  });

  it('is idempotent: satisfied once applied', async () => {
    const h = home({ card: lf(BY_0041), conv: lf(BY_0041) });
    await run(h);
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  it('absent: no card and no copies, or a card that never had the lines - satisfied', async () => {
    expect((await plan(ctxFor(home({ card: null })))).satisfied).toBe(true);
    expect((await plan(ctxFor(home({ card: lf(CLEAN), conv: lf(CLEAN) })))).satisfied).toBe(true);
  });

  it("leaves /transcribe in the operator's own words alone, and says so", async () => {
    const h = home({ card: lf([...BY_0041.slice(0, -1), 'Never /transcribe anything.', '']) });
    const p = await plan(ctxFor(h));
    expect(p.changes.join('\n')).toMatch(/names \/transcribe in words 0041 did not write/);
    await p.apply();
    expect(read(h, CARD)).toBe(lf([...CLEAN.slice(0, -1), 'Never /transcribe anything.', '']));
    const again = await plan(ctxFor(h));
    expect(again.satisfied).toBe(true);
    expect(again.notes.join('\n')).toMatch(/left as is/);
  });

  it('refuses a non-UTF-8 card that names /transcribe, naming it', async () => {
    const h = home({ card: Buffer.concat([Buffer.from(`${VERB}\n`), Buffer.from([0xff, 0xfe, 0x0a])]) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0042 refuses: .*10-actions\.md is not valid UTF-8/);
  });

  it('refuses a file that changed since it was planned', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(join(h, ...CARD), lf([...BY_0041, 'edited']));
    await expect(p.apply()).rejects.toThrow(/0042 refuses: .*changed since it was planned/);
  });
});

describe('0042 through the runner', () => {
  const ID_0041 = '0041-the-actions-card-says-transcribe-goes-to-dolly';
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0042');
    const entries = [...earlier.map(({ id }) => id), ID_0041].map((id) => [id, { outcome: 'applied', at: '2026-10-16T00:00:00Z' }]);
    writeFileSync(join(h, 'state', 'migrations-applied.json'), JSON.stringify(Object.fromEntries(entries)));
    return h;
  }

  it('0041 is gone from the repo; its ledger entry is ignored and kept', () => {
    expect(listMigrations(MIGRATIONS_DIR).map(({ id }) => id)).not.toContain(ID_0041);
  });

  it('applied and recorded on a node that ran 0041, backup beside the card, the repo card untouched', async () => {
    const before = readFileSync(REPO_CARD);
    const h = withLedger(home());
    const { exitCode, results } = await runMigrations({ through: '0042', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(results.filter((r) => r.outcome !== 'in-ledger').map((r) => [r.id, r.outcome])).toEqual([['0042-the-actions-card-drops-transcribe', 'applied']]);
    expect(ledger(h)['0042-the-actions-card-drops-transcribe'].outcome).toBe('applied');
    expect(ledger(h)[ID_0041].outcome).toBe('applied');
    expect(read(h, CARD)).toBe(lf(CLEAN));
    expect(baks(h).filter((f) => f.startsWith('10-actions.md.bak-0042-'))).toHaveLength(1);
    expect(readFileSync(REPO_CARD).equals(before)).toBe(true);
  });
});
