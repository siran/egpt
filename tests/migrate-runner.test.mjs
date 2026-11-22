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
${spec.approval ? 'export const approval = true;' : ''}
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

  it('`through` stops the chain after that number: a later migration is neither loaded nor recorded', async () => {
    // 0003 has no `elevated` export - loading it would FAIL. Being left out is what keeps this green.
    const t = setup({ '0001-a': { elevated: false }, '0002-b': { elevated: false }, '0003-c': {} });
    const { exitCode, results } = await t.run({ through: '0002' });
    expect(exitCode).toBe(0);
    expect(results.map((r) => r.id)).toEqual(['0001-a', '0002-b']);
    expect(Object.keys(t.ledger())).toEqual(['0001-a', '0002-b']);
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

describe('approval (operator-owned config: the node says yes or no)', () => {
  const specs = () => ({ '0001-code': { elevated: false }, '0002-policy': { elevated: false, approval: true }, '0003-after': { elevated: false, after: ['0002-policy'] }, '0004-free': { elevated: false } });

  it('a pending approval migration is reported PENDING APPROVAL with its summary and both commands; it is not applied, not recorded, and exit is 3', async () => {
    const t = setup(specs());
    const { exitCode, results } = await t.run();
    expect(exitCode).toBe(3);
    expect(results.map((r) => [r.id, r.outcome])).toEqual([['0001-code', 'applied'], ['0002-policy', 'pending-approval'], ['0003-after', 'blocked'], ['0004-free', 'applied']]);
    expect(globalThis.__mig.calls.some((c) => c.startsWith('0002-policy:apply'))).toBe(false);
    expect(Object.keys(t.ledger())).toEqual(['0001-code', '0004-free']);
    const out = t.output();
    expect(out).toMatch(/0002-policy {2}PENDING APPROVAL - test 0002-policy/);
    expect(out).toMatch(/approve: .*--approve 0002/);
    expect(out).toMatch(/decline: .*--decline 0002/);
    expect(out).toMatch(/PENDING APPROVAL \(or BLOCKED behind one\)/);
  });

  it('one that lists it in `after` is blocked, and that is exit 3 as well', async () => {
    const t = setup({ '0001-policy': { elevated: false, approval: true }, '0002-needs-it': { elevated: false, after: ['0001-policy'] } });
    const { exitCode } = await t.run();
    expect(exitCode).toBe(3);
    expect(globalThis.__mig.calls.some((c) => c.startsWith('0002-needs-it'))).toBe(false);
  });

  it('pending elevation outranks pending approval: exit 2 when both are left, in either order', async () => {
    const t = setup({ '0001-policy': { elevated: false, approval: true }, '0002-admin': { elevated: true } });
    expect((await t.run()).exitCode).toBe(2);
    const u = setup({ '0001-admin': { elevated: true }, '0002-policy': { elevated: false, approval: true } });
    expect((await u.run()).exitCode).toBe(2);
  });

  it('an approval migration that is already satisfied is recorded as ever: nothing to approve', async () => {
    const t = setup({ '0001-policy': { elevated: false, approval: true, satisfied: true } });
    const { exitCode } = await t.run();
    expect(exitCode).toBe(0);
    expect(t.ledger()['0001-policy'].outcome).toBe('already-satisfied');
  });

  describe('quiet: unapproved, with a newer migration applied', () => {
    const seed = (t, entries) => {
      mkdirSync(join(t.egptHome, 'state'), { recursive: true });
      writeFileSync(ledgerPath(t.egptHome), JSON.stringify(entries));
    };
    const done = (outcome) => ({ outcome, at: '2026-09-01T00:00:00.000Z' });

    it('is not applied, not recorded, marked quiet, and exit 0 when it is the only pending item', async () => {
      const t = setup({ '0001-policy': { elevated: false, approval: true }, '0002-code': { elevated: false } });
      seed(t, { '0002-code': done('applied') });
      const { exitCode, results } = await t.run();
      expect(exitCode).toBe(0);
      expect(results.find((r) => r.id === '0001-policy')).toMatchObject({ outcome: 'pending-approval', quiet: true });
      expect(globalThis.__mig.calls.some((c) => c.startsWith('0001-policy:apply'))).toBe(false);
      expect(Object.keys(t.ledger())).toEqual(['0002-code']);
      expect(t.output()).toMatch(/0001-policy {2}PENDING APPROVAL \(quiet: newer applied\) - test 0001-policy/);
      expect(t.output()).not.toMatch(/\*\*\*\*/);
    });

    it('already-satisfied and approved newer ones count; a declined one does not', async () => {
      for (const [outcome, quiet] of [['already-satisfied', true], ['applied', true], ['declined', false]]) {
        const t = setup({ '0001-policy': { elevated: false, approval: true }, '0002-x': { elevated: false } });
        seed(t, { '0002-x': { ...done(outcome), ...(outcome === 'applied' && { by: 'operator' }) } });
        const { exitCode } = await t.run();
        expect([outcome, exitCode]).toEqual([outcome, quiet ? 0 : 3]);
      }
    });

    it('without a newer applied migration it is not quiet: exit 3, loud as before', async () => {
      const t = setup({ '0001-policy': { elevated: false, approval: true } });
      const { exitCode, results } = await t.run();
      expect(exitCode).toBe(3);
      expect(results[0].quiet).toBeUndefined();
      expect(t.output()).toMatch(/0001-policy {2}PENDING APPROVAL - test/);
    });

    it('a mix: exit 3, and only the non-quiet one is loud', async () => {
      const t = setup({ '0001-old': { elevated: false, approval: true }, '0002-code': { elevated: false }, '0003-new': { elevated: false, approval: true } });
      seed(t, { '0002-code': done('applied') });
      const { exitCode, results } = await t.run();
      expect(exitCode).toBe(3);
      expect(results.map((r) => [r.id, !!r.quiet])).toEqual([['0001-old', true], ['0002-code', false], ['0003-new', false]]);
    });

    it('elevation pending plus a quiet approval: exit 2', async () => {
      const t = setup({ '0001-policy': { elevated: false, approval: true }, '0002-code': { elevated: false }, '0003-admin': { elevated: true } });
      seed(t, { '0002-code': done('applied') });
      expect((await t.run()).exitCode).toBe(2);
    });

    it('--approve on a quiet one applies it', async () => {
      const t = setup({ '0001-policy': { elevated: false, approval: true }, '0002-code': { elevated: false } });
      seed(t, { '0002-code': done('applied') });
      const { exitCode, results } = await t.run({ approve: ['0001'] });
      expect(exitCode).toBe(0);
      expect(results.find((r) => r.id === '0001-policy').outcome).toBe('applied');
      expect(t.ledger()['0001-policy'].by).toBe('operator');
    });
  });

  it('--approve applies it through the normal path (plan, apply, re-plan) and records it; the one that waited on it then runs', async () => {
    const t = setup(specs());
    await t.run();
    globalThis.__mig.calls.length = 0;
    const { exitCode, results } = await t.run({ approve: ['0002'] });
    expect(exitCode).toBe(0);
    expect(results.find((r) => r.id === '0002-policy').outcome).toBe('applied');
    expect(results.find((r) => r.id === '0003-after').outcome).toBe('applied');
    expect(globalThis.__mig.calls.filter((c) => c.startsWith('0002-policy'))).toEqual(['0002-policy:plan', '0002-policy:apply', '0002-policy:plan']);
    expect(t.ledger()['0002-policy']).toEqual({ outcome: 'applied', at: '2026-09-16T10:00:00.000Z', by: 'operator' });
  });

  it('--approve in the very first run applies it in chain order; the whole name works as well as the number', async () => {
    const t = setup(specs());
    const { exitCode } = await t.run({ approve: ['0002-policy'] });
    expect(exitCode).toBe(0);
    expect(globalThis.__mig.calls.filter((c) => c.endsWith(':apply'))).toEqual(['0001-code:apply', '0002-policy:apply', '0003-after:apply', '0004-free:apply']);
  });

  it('--decline records `declined` with a time and "by operator", runs nothing of it, and it is never proposed again', async () => {
    const t = setup(specs());
    const { exitCode, results } = await t.run({ decline: ['0002'] });
    expect(exitCode).toBe(0);
    expect(results.find((r) => r.id === '0002-policy').outcome).toBe('declined');
    expect(t.ledger()['0002-policy']).toEqual({ outcome: 'declined', at: '2026-09-16T10:00:00.000Z', by: 'operator' });
    expect(globalThis.__mig.calls.some((c) => c.startsWith('0002-policy'))).toBe(false);
    // the one that waited on it is not stuck: the ledger has an entry
    expect(results.find((r) => r.id === '0003-after').outcome).toBe('applied');
    globalThis.__mig.calls.length = 0;
    t.lines.length = 0;
    const again = await t.run();
    expect(again.exitCode).toBe(0);
    expect(globalThis.__mig.calls).toEqual([]);
    expect(t.output()).toMatch(/0002-policy {2}done \(declined by operator,/);
    expect(t.output()).not.toMatch(/PENDING APPROVAL - test/);
  });

  it('--decline takes several ids at once; on a dry run it records nothing', async () => {
    const t = setup({ '0001-a': { elevated: false, approval: true }, '0002-b': { elevated: false, approval: true } });
    const dry = await t.run({ decline: ['0001', '0002'], dryRun: true });
    expect(dry.results.map((r) => r.outcome)).toEqual(['would-decline', 'would-decline']);
    expect(t.ledger()).toBe(null);
    await t.run({ decline: ['0001', '0002'] });
    expect(Object.values(t.ledger()).map((e) => e.outcome)).toEqual(['declined', 'declined']);
  });

  it('refuses an unknown id: exit 1, nothing runs, nothing is recorded', async () => {
    const t = setup(specs());
    for (const opts of [{ approve: ['0099'] }, { decline: ['0099'] }]) {
      const { exitCode } = await t.run(opts);
      expect(exitCode).toBe(1);
    }
    expect(t.output()).toMatch(/--decline 0099: no such migration/);
    expect(globalThis.__mig.calls.some((c) => c.endsWith(':apply'))).toBe(false);
    expect(t.ledger()).toBe(null);
  });

  it('refuses --decline of a code-shape migration: the code depends on it', async () => {
    const t = setup(specs());
    const { exitCode } = await t.run({ decline: ['0001'] });
    expect(exitCode).toBe(1);
    expect(t.output()).toMatch(/0001-code is not an approval migration - it is a code-shape fix tied to the code.* cannot be declined/);
    expect(globalThis.__mig.calls.some((c) => c.endsWith(':apply'))).toBe(false);
    expect(t.ledger()).toBe(null);
  });

  it('refuses --approve of a non-approval migration, an id already recorded, and one id given to both flags', async () => {
    const t = setup(specs());
    expect((await t.run({ approve: ['0001'] })).exitCode).toBe(1);
    await t.run({ decline: ['0002'] });
    const again = await t.run({ approve: ['0002'] });
    expect(again.exitCode).toBe(1);
    expect(t.output()).toMatch(/0002-policy is already recorded \(declined,/);
    expect(t.output()).toMatch(/--approve 0001: 0001-code is not an approval migration/);
    const u = setup(specs());
    expect((await u.run({ approve: ['0002'], decline: ['0002'] })).exitCode).toBe(1);
    expect(u.output()).toMatch(/given to both --approve and --decline/);
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

  // operator 2026-11-21: 0025 / 0028 / 0029 would rewrite an independent node's real config on its
  // first upgrade; the node must say yes (or decline them, as EDW does).
  it('0025, 0028 and 0029 declare approval', async () => {
    for (const n of ['0025', '0028', '0029']) {
      const m = listMigrations(join(import.meta.dirname, '..', 'migrations')).find((x) => x.id.startsWith(n));
      expect((await import(pathToFileURL(m.file).href)).approval, n).toBe(true);
    }
  });
});
