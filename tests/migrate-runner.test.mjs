// tests/migrate-runner.test.mjs — setup/migrate.mjs, the runner that brings a node forward.
//
// The rules under test are the ones agreed with the operator (2026-09-16): what a node has
// applied is NODE state (a ledger under EGPT_HOME), never git; an already-satisfied migration
// is recorded without acting; a failure stops the chain and is never recorded; a dry run
// changes nothing; an elevated migration run unelevated is PENDING - loud, unrecorded, and not
// blocking the migrations after it unless they name it in `after`.
//
// Each test writes throwaway migration modules into its own temp dir. They report what the
// runner did to them through globalThis.__mig, so every assertion is about the RUNNER.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMigrations, ledgerPath, listMigrations } from '../setup/migrate.mjs';

// A migration module whose behaviour is data: { elevated, after, satisfied, throwInPlan,
// throwInApply, stillPendingAfterApply }. Calls are logged to globalThis.__mig.calls.
function migrationSource(id, spec) {
  return `
const spec = ${JSON.stringify(spec)};
const log = (what) => globalThis.__mig.calls.push('${id}:' + what);
${'elevated' in spec ? `export const elevated = ${spec.elevated};` : ''}
export const summary = 'test ${id}';
${spec.after ? `export const after = ${JSON.stringify(spec.after)};` : ''}
export async function plan(ctx) {
  log('plan');
  if (spec.throwInPlan) throw new Error('${id} refuses: ' + spec.throwInPlan);
  if (spec.satisfied || globalThis.__mig.applied.has('${id}') && !spec.stillPendingAfterApply) return { satisfied: true, notes: ['note from ${id}'] };
  return {
    satisfied: false,
    changes: ['change planned by ${id}'],
    apply: async () => {
      log('apply');
      if (spec.throwInApply) throw new Error('${id} apply broke: ' + spec.throwInApply);
      globalThis.__mig.applied.add('${id}');
    },
  };
}
`;
}

function setup(specs) {
  const root = mkdtempSync(join(tmpdir(), 'egpt-migrate-'));
  const dir = join(root, 'migrations');
  const egptHome = join(root, 'home');
  mkdirSync(dir);
  mkdirSync(egptHome);
  for (const [id, spec] of Object.entries(specs)) writeFileSync(join(dir, `${id}.mjs`), migrationSource(id, spec));
  const lines = [];
  const run = (opts = {}) => runMigrations({ dir, egptHome, elevated: false, platform: 'win32', log: (l) => lines.push(l), now: () => new Date('2026-09-16T10:00:00Z'), ...opts });
  const ledger = () => (existsSync(ledgerPath(egptHome)) ? JSON.parse(readFileSync(ledgerPath(egptHome), 'utf8')) : null);
  return { dir, egptHome, run, ledger, lines, output: () => lines.join('\n') };
}

beforeEach(() => { globalThis.__mig = { calls: [], applied: new Set() }; });

describe('pending detection', () => {
  it('skips what the ledger already records - its plan() is never even asked', async () => {
    const t = setup({ '0001-one': {}, '0002-two': { elevated: false } });
    mkdirSync(join(t.egptHome, 'state'));
    writeFileSync(ledgerPath(t.egptHome), JSON.stringify({ '0001-one': { outcome: 'applied', at: '2026-09-15T00:00:00Z' } }));
    // 0001 has no `elevated` export - loading it would FAIL. Being skipped is what keeps this green.
    const { exitCode, results } = await t.run();
    expect(exitCode).toBe(0);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([['0001-one', 'in-ledger'], ['0002-two', 'applied']]);
    expect(globalThis.__mig.calls).toEqual(['0002-two:plan', '0002-two:apply', '0002-two:plan']);
  });

  it('runs migrations in file-name order', async () => {
    const t = setup({ '0002-b': { elevated: false }, '0001-a': { elevated: false }, '0010-c': { elevated: false } });
    await t.run();
    expect(globalThis.__mig.calls.filter((c) => c.endsWith(':apply'))).toEqual(['0001-a:apply', '0002-b:apply', '0010-c:apply']);
  });
});

describe('already satisfied', () => {
  it('is recorded WITHOUT acting', async () => {
    const t = setup({ '0001-there': { elevated: true, satisfied: true } });
    const { exitCode } = await t.run();
    expect(exitCode).toBe(0);
    expect(globalThis.__mig.calls).toEqual(['0001-there:plan']);
    expect(t.ledger()).toEqual({ '0001-there': { outcome: 'already-satisfied', at: '2026-09-16T10:00:00.000Z' } });
    expect(t.output()).toContain('0001-there  already satisfied - recorded, nothing changed');
  });

  it('an ELEVATED migration that is already satisfied is recorded by an unelevated run - reading needs no admin', async () => {
    const t = setup({ '0001-there': { elevated: true, satisfied: true } });
    await t.run({ elevated: false });
    expect(t.ledger()['0001-there'].outcome).toBe('already-satisfied');
  });

  it('a lost ledger is survivable: re-running re-checks, acts on nothing, and records again', async () => {
    const t = setup({ '0001-a': { elevated: false } });
    await t.run();
    expect(globalThis.__mig.calls).toEqual(['0001-a:plan', '0001-a:apply', '0001-a:plan']);
    writeFileSync(ledgerPath(t.egptHome), '{}');
    globalThis.__mig.calls = [];
    await t.run();
    expect(globalThis.__mig.calls).toEqual(['0001-a:plan']);
    expect(t.ledger()['0001-a'].outcome).toBe('already-satisfied');
  });
});

describe('a failure stops the chain and is never recorded', () => {
  it('a refusal in plan() stops everything after it', async () => {
    const t = setup({ '0001-ok': { elevated: false }, '0002-bad': { elevated: false, throwInPlan: 'the profile is not the expected shape' }, '0003-later': { elevated: false } });
    const { exitCode, results } = await t.run();
    expect(exitCode).toBe(1);
    expect(results.map((r) => r.outcome)).toEqual(['applied', 'failed']);
    expect(globalThis.__mig.calls.some((c) => c.startsWith('0003-later'))).toBe(false);
    expect(Object.keys(t.ledger())).toEqual(['0001-ok']);
    expect(t.output()).toContain('0002-bad refuses: the profile is not the expected shape');
  });

  it('a throw in apply() is not recorded', async () => {
    const t = setup({ '0001-bad': { elevated: false, throwInApply: 'disk full' }, '0002-later': { elevated: false } });
    const { exitCode } = await t.run();
    expect(exitCode).toBe(1);
    expect(t.ledger()).toBeNull();
    expect(globalThis.__mig.calls).toEqual(['0001-bad:plan', '0001-bad:apply']);
  });

  it('an apply() that returns but leaves the node unconverged is a failure, not a success', async () => {
    const t = setup({ '0001-liar': { elevated: false, stillPendingAfterApply: true } });
    const { exitCode } = await t.run();
    expect(exitCode).toBe(1);
    expect(t.ledger()).toBeNull();
    expect(t.output()).toContain('plan() still reports changes pending');
  });

  it('a migration that does not DECLARE elevation is refused before it can act', async () => {
    const t = setup({ '0001-undeclared': {} });
    const { exitCode } = await t.run();
    expect(exitCode).toBe(1);
    expect(globalThis.__mig.calls).toEqual([]);
    expect(t.output()).toContain('must export `elevated` (boolean)');
  });

  it('a ledger that does not parse is refused and left exactly as it was', async () => {
    const t = setup({ '0001-a': { elevated: false } });
    mkdirSync(join(t.egptHome, 'state'));
    writeFileSync(ledgerPath(t.egptHome), '{ not json');
    const { exitCode } = await t.run();
    expect(exitCode).toBe(1);
    expect(readFileSync(ledgerPath(t.egptHome), 'utf8')).toBe('{ not json');
    expect(globalThis.__mig.calls).toEqual([]);
  });

  it('two migrations sharing a number are refused - order would be a guess', () => {
    const t = setup({ '0001-a': { elevated: false }, '0001-b': { elevated: false } });
    expect(() => listMigrations(t.dir)).toThrow(/two migrations share the number 0001/);
  });
});

describe('dry run', () => {
  it('changes nothing: no apply, no ledger, not even the state dir', async () => {
    const t = setup({ '0001-there': { elevated: false, satisfied: true }, '0002-pending': { elevated: false }, '0003-admin': { elevated: true } });
    const { exitCode, results } = await t.run({ dryRun: true });
    expect(exitCode).toBe(0);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([['0001-there', 'would-record'], ['0002-pending', 'would-apply'], ['0003-admin', 'would-apply']]);
    expect(globalThis.__mig.calls.some((c) => c.endsWith(':apply'))).toBe(false);
    expect(existsSync(join(t.egptHome, 'state'))).toBe(false);
    expect(t.output()).toContain('change planned by 0002-pending');
    expect(t.output()).toContain('0003-admin  PENDING - test 0003-admin  [needs elevation]');
  });
});

describe('elevation', () => {
  it('unelevated: an elevated migration is PENDING, loud, unrecorded - and the next one still runs', async () => {
    const t = setup({ '0001-admin': { elevated: true }, '0002-user': { elevated: false } });
    const { exitCode, results } = await t.run({ elevated: false });
    expect(exitCode).toBe(2);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([['0001-admin', 'pending-elevation'], ['0002-user', 'applied']]);
    expect(globalThis.__mig.calls).not.toContain('0001-admin:apply');
    expect(Object.keys(t.ledger())).toEqual(['0002-user']);
    const out = t.output();
    expect(out).toContain('0001-admin NEEDS ELEVATION and was NOT applied');
    expect(out).toMatch(/ADMINISTRATOR shell: +".*" ".*migrate\.mjs" --egpt-home ".*home"/);
    expect(out).toMatch(/Start-Process -Verb RunAs ".*migrate\.cmd"/);
  });

  it('elevated: the same migration applies and is recorded', async () => {
    const t = setup({ '0001-admin': { elevated: true } });
    const { exitCode } = await t.run({ elevated: true });
    expect(exitCode).toBe(0);
    expect(t.ledger()['0001-admin'].outcome).toBe('applied');
  });

  it('a migration that names a pending one in `after` is BLOCKED, not run and not recorded', async () => {
    const t = setup({ '0001-admin': { elevated: true }, '0002-needs-it': { elevated: false, after: ['0001-admin'] }, '0003-free': { elevated: false } });
    const { exitCode, results } = await t.run({ elevated: false });
    expect(exitCode).toBe(2);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([['0001-admin', 'pending-elevation'], ['0002-needs-it', 'blocked'], ['0003-free', 'applied']]);
    expect(globalThis.__mig.calls.some((c) => c.startsWith('0002-needs-it'))).toBe(false);
  });
});

describe('the shipped migrations directory', () => {
  it('holds only well-formed, uniquely numbered files, each declaring elevation', async () => {
    const list = listMigrations(join(import.meta.dirname, '..', 'migrations'));
    expect(list.map((m) => m.id)).toEqual(expect.arrayContaining(['0001-beeper-services-carry-role', '0002-session1-task-is-egpt-daemon', '0003-transcription-worker-shape']));
    for (const m of list) {
      const mod = await import(pathToFileURL(m.file).href);
      expect(typeof mod.elevated, `${m.id} must declare elevation`).toBe('boolean');
      expect(typeof mod.plan).toBe('function');
    }
  });
});
