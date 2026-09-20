// tests/migrations-0013-warm-sessions-idle-out.test.mjs — migrations/0013-warm-sessions-idle-out.mjs.
//
// kg's fixture carries the live `warm:` block byte for byte (CRLF, the legend comment on the
// `idle_ttl_by_class:` key line): four classes at `-1` is what kept 13 claude.exe processes alive,
// and what those four lines become is asserted in full.
//
// The assertions are on the FULL text, never a re-parse: the data surviving is not the point, the
// bytes are. A comment is not part of the parse, so "byte-identical apart from those lines" is the
// only check that can see the legend survive and a lying value-line comment get rewritten.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0013-warm-sessions-idle-out.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// kg, through the warm block. Lines 4-10 are the live block, exactly as it reads on kg.
const KG_LINES = [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  '',
  'warm:',
  '  idle_ttl_by_class: # -1 = never idle-evict',
  '    system: -1',
  '    resident: -1',
  '    conversation: -1',
  '    sibling: -1',
  '  idle_ttl_ms: 1800000',
  '  max: 10',
  '',
  'compaction: { enabled: true, ratio: 0.20, cooling_ms: 120000 }',
];
const CLASS_LINES = { system: 6, resident: 7, conversation: 8, sibling: 9 };   // 1-based
const KG = crlf(KG_LINES);
const TTL = 43200000;
const idled = (lines, classes) => lines.map((l, i) => {
  const cls = Object.keys(CLASS_LINES).find((c) => CLASS_LINES[c] === i + 1);
  return cls && classes.includes(cls) ? `    ${cls}: ${TTL}` : l;
});
const KG_AFTER = crlf(idled(KG_LINES, Object.keys(CLASS_LINES)));

function home({ config = KG } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0013-'));
  mkdirSync(join(h, 'config'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), config);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0013-test`; writeFileSync(to, readFileSync(f)); return to; } });
const diffLines = (file, before, after, nos) => nos.flatMap((n) => [`${file}:${n}`, `  - ${before[n - 1]}`, `  + ${after[n - 1]}`]);

describe('0013 on kg - every class is never-evict', () => {
  it('plans all four changed lines, and says what each becomes', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      ...diffLines(cfgPath(h), KG_LINES, idled(KG_LINES, Object.keys(CLASS_LINES)), Object.values(CLASS_LINES)),
      `warm.idle_ttl_by_class: system, resident, conversation, sibling never idle-evict; each becomes ${TTL} ms (12h)`,
      'backup first, beside it: config.yaml.bak-0013-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from those four lines - CRLF, the legend comment and idle_ttl_ms kept', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(KG_AFTER);
    const before = KG.split('\r\n');
    const after = out.split('\r\n');
    expect(after.flatMap((l, i) => (l === before[i] ? [] : [i + 1]))).toEqual(Object.values(CLASS_LINES));
    expect(out).toContain('  idle_ttl_by_class: # -1 = never idle-evict');   // the legend is still true
    expect(out).toContain('  idle_ttl_ms: 1800000');
    expect(out).toContain('  max: 10');
    expect(readFileSync(`${cfgPath(h)}.bak-0013-test`, 'utf8')).toBe(KG);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  // ANY negative is never-evict in src/warm-sessions.mjs (`_armIdle`: `ttl < 0`), not just the -1
  // the dialect spells it with - so a -2 is the same forever-warm session, and is idled out too.
  it('a negative that is not -1 is never-evict just the same', async () => {
    const odd = KG.replace('    resident: -1', '    resident: -2');
    const h = home({ config: odd });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
  });

  it('a class already carrying a finite value is left alone - someone chose it', async () => {
    const chosen = KG.replace('    conversation: -1', '    conversation: 900000');
    const h = home({ config: chosen });
    const p = await plan(ctxFor(h));
    const after = idled(KG_LINES, ['system', 'resident', 'sibling']).map((l) => (l === '    conversation: -1' ? '    conversation: 900000' : l));
    expect(p.changes.slice(0, 9)).toEqual(diffLines(cfgPath(h), chosen.split('\r\n'), after, [CLASS_LINES.system, CLASS_LINES.resident, CLASS_LINES.sibling]));
    await p.apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(crlf(after));
    expect(out).toContain('    conversation: 900000');
  });

  // The block legend explains the dialect and stays true. A comment on the VALUE line describes
  // THAT value, so one that says "never" is rewritten rather than left lying.
  it('rewrites a value-line comment that says never, and leaves every other trailing comment alone', async () => {
    const commented = KG
      .replace('    system: -1', '    system: -1 # never, the node talks to itself')
      .replace('    sibling: -1', '    sibling: -1 # siblings, not conversations');
    const h = home({ config: commented });
    await (await plan(ctxFor(h))).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toContain(`    system: ${TTL} # 12h (0013, operator 2026-09-20: "let them idle out, 12h")`);
    expect(out).toContain(`    sibling: ${TTL} # siblings, not conversations`);
    expect(out).toContain('  idle_ttl_by_class: # -1 = never idle-evict');
    expect(out).not.toMatch(/never, the node talks to itself/);
  });

  it('refuses to write over a config.yaml edited between plan and apply, and touches nothing', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG.replace('  max: 10', '  max: 12');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0013 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(edited);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});

describe('0013 is satisfied where it has nothing to do', () => {
  it('every class already idles out', async () => {
    const h = home({ config: KG_AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`no class under warm.idle_ttl_by_class in ${cfgPath(h)} is kept warm forever (system=${TTL}, resident=${TTL}, conversation=${TTL}, sibling=${TTL}) - every warm session already idles out`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
  });

  // 0 = always evict. That is a choice, and a session dropped at turn end is not one kept 12h.
  it('a class set to 0 (always evict) is a finite choice, not never', async () => {
    const zeros = KG.replace(/: -1$/gm, ': 0');
    const p = await plan(ctxFor(home({ config: zeros })));
    expect(p).toMatchObject({ satisfied: true });
    expect(p.notes[0]).toMatch(/system=0, resident=0, conversation=0, sibling=0/);
  });

  // A refusal STOPS THE WHOLE CHAIN, so a node this migration has no business on reads satisfied.
  it('no `warm:` block at all, and a warm block with no idle_ttl_by_class', async () => {
    const none = await plan(ctxFor(home({ config: 'node_name: zz\n' })));
    expect(none).toMatchObject({ satisfied: true });
    expect(none.notes[0]).toMatch(/has no `warm:` block, so there is no per-class idle TTL here to change/);
    const bare = await plan(ctxFor(home({ config: 'warm:\n  max: 10\n' })));
    expect(bare).toMatchObject({ satisfied: true });
    expect(bare.notes[0]).toMatch(/has no `idle_ttl_by_class`, so there is no per-class idle TTL here to change/);
    // `warm:` that is not a mapping at all is somebody else's bug, not a chain-stopping one here.
    const scalar = await plan(ctxFor(home({ config: 'warm: 10\n' })));
    expect(scalar).toMatchObject({ satisfied: true });
  });
});

describe('0013 refuses, naming the place', () => {
  it('idle_ttl_by_class present but not a mapping', async () => {
    for (const block of ['warm:\n  idle_ttl_by_class: never\n', 'warm:\n  idle_ttl_by_class: [ system, resident ]\n']) {
      await expect(plan(ctxFor(home({ config: block })))).rejects
        .toThrow(/0013 refuses: warm\.idle_ttl_by_class in .*config\.yaml is .*, not a mapping of class to milliseconds/);
    }
  });

  it('a class holding something that is not a number of milliseconds', async () => {
    const worded = KG.replace('    resident: -1', '    resident: forever');
    await expect(plan(ctxFor(home({ config: worded })))).rejects
      .toThrow(/0013 refuses: warm\.idle_ttl_by_class\.resident in .*config\.yaml is "forever", not a number of milliseconds/);
    const empty = KG.replace('    sibling: -1', '    sibling:');
    await expect(plan(ctxFor(home({ config: empty })))).rejects
      .toThrow(/0013 refuses: warm\.idle_ttl_by_class\.sibling in .*config\.yaml is null, not a number of milliseconds/);
  });

  it('a config.yaml that does not parse', async () => {
    await expect(plan(ctxFor(home({ config: 'warm: [ broken\n' })))).rejects.toThrow(/0013 refuses: .* does not parse/);
  });
});

describe('0013 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0012-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0013-warm-sessions-idle-out'].outcome;

  it('kg: applied and recorded, only those four lines changed, a backup left beside the config', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0013-'))).toHaveLength(1);
  });

  it('a node whose classes already idle out: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: KG_AFTER });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});
