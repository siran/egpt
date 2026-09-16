// tests/migrations-0001-beeper-services.test.mjs — migrations/0001-beeper-services-carry-role.mjs.
//
// The fixtures are the probe output MEASURED on 2026-09-16 (read-only) on each node:
//   kg: egpt-beeper-primary (CDP 9223, no --user-data-dir) + egpt-beeper-secondary (rodz-beeper, 9225)
//       - already the target, so 0001 must report "already satisfied": the idempotency proof.
//   do: egpt-primary (an-beeper, 9223) + BeeperRodz (rodz-beeper, 9225) - both to rename, the
//       role read from each service's own CDP port, not from its name.
// Nothing here touches the SCM: the PowerShell seams are injected.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0001-beeper-services-carry-role.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const BEEPER = 'C:\\Users\\an\\AppData\\Local\\Programs\\BeeperTexts\\Beeper.exe';
const FLAGS = '--disable-gpu --disable-gpu-compositing --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows';
const MAP = [
  { old: 'egpt-primary', new: 'egpt-beeper-primary' },
  { old: 'egpt-secondary', new: 'egpt-beeper-secondary' },
  { old: 'BeeperAn', new: 'egpt-beeper-primary' },
  { old: 'BeeperRodz', new: 'egpt-beeper-secondary' },
];
const svc = (name, appParameters, extra = {}) => ({ name, appParameters, application: BEEPER, startMode: 'Auto', state: 'Running', startName: 'LocalSystem', ...extra });

const KG = {
  map: MAP,
  services: [
    svc('egpt-beeper-primary', `${FLAGS} --remote-debugging-port=9223 --remote-allow-origins=*`),
    svc('egpt-beeper-secondary', `--user-data-dir=C:/Users/an/.egpt/state/rodz-beeper/userdata ${FLAGS} --remote-debugging-port=9225 --remote-allow-origins=*`),
  ],
};
const DO = {
  map: MAP,
  services: [
    svc('egpt-primary', `--user-data-dir=C:/Users/an/.egpt/state/an-beeper/userdata ${FLAGS} --remote-debugging-port=9223 --remote-allow-origins=*`),
    svc('BeeperRodz', `--user-data-dir=C:/Users/an/.egpt/state/rodz-beeper/userdata ${FLAGS} --remote-allow-origins=* --remote-debugging-port=9225`),
  ],
};

function ctxFor(state, over = {}) {
  const calls = { ps: [], psFile: [] };
  const ctx = {
    platform: 'win32',
    repo: 'C:\\Users\\an\\bin\\egpt',
    log: () => {},
    ps: (script) => { calls.ps.push(script); return JSON.stringify(state.current ?? state); },
    psFile: (file, args) => { calls.psFile.push([file, ...args]); },
    ...over,
  };
  return { ctx, calls };
}

describe('0001 on kg - already the target', () => {
  it('reports already satisfied and renames nothing', async () => {
    const { ctx, calls } = ctxFor(KG);
    const p = await plan(ctx);
    expect(p.satisfied).toBe(true);
    expect(p.notes.join()).toContain('egpt-beeper-primary (Running, Auto), egpt-beeper-secondary (Running, Auto)');
    expect(calls.psFile).toEqual([]);
  });

  it('the probe reads the legacy names from the ONE map, setup/beeper-s0-naming.ps1', async () => {
    const { ctx, calls } = ctxFor(KG);
    await plan(ctx);
    expect(calls.ps[0]).toContain(". 'C:\\Users\\an\\bin\\egpt\\setup\\beeper-s0-naming.ps1'");
    expect(calls.ps[0]).toContain('Get-BeeperS0LegacyNameMap');
  });

  it('a node with no Beeper at all is satisfied too - zero numbers is a valid node', async () => {
    const { ctx } = ctxFor({ map: MAP, services: [] });
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('off Windows there are no services to rename', async () => {
    const { ctx, calls } = ctxFor(KG, { platform: 'linux' });
    expect((await plan(ctx)).satisfied).toBe(true);
    expect(calls.ps).toEqual([]);
  });
});

describe('0001 on do - resolved from evidence', () => {
  it('plans both renames, SECONDARY first, each with its evidence', async () => {
    const { ctx } = ctxFor(DO);
    const p = await plan(ctx);
    expect(p.satisfied).toBe(false);
    const text = p.changes.join('\n');
    expect(p.changes[0]).toBe('rename service BeeperRodz -> egpt-beeper-secondary   (Running, Auto, LocalSystem)');
    expect(text).toContain("evidence: CDP 9225 = the secondary's port; --user-data-dir=C:/Users/an/.egpt/state/rodz-beeper/userdata");
    expect(text).toContain('rename service egpt-primary -> egpt-beeper-primary');
    expect(text).toContain("evidence: CDP 9223 = the primary's port; --user-data-dir=C:/Users/an/.egpt/state/an-beeper/userdata");
    expect(text.indexOf('BeeperRodz ->')).toBeLessThan(text.indexOf('egpt-primary ->'));
  });

  it('apply CALLS setup/rename-beeper-s0-service.ps1 - it does not reimplement the rename', async () => {
    const { ctx, calls } = ctxFor(DO);
    await (await plan(ctx)).apply();
    const script = join('C:\\Users\\an\\bin\\egpt', 'setup', 'rename-beeper-s0-service.ps1');
    expect(calls.psFile).toEqual([
      [script, '-From', 'BeeperRodz', '-To', 'egpt-beeper-secondary'],
      [script, '-From', 'egpt-primary', '-To', 'egpt-beeper-primary'],
    ]);
  });

  it('through the runner, elevated: renames, re-checks, records - and unelevated it is PENDING and untouched', async () => {
    const state = { current: DO };
    const { ctx, calls } = ctxFor(state, {
      psFile: (file, args) => { calls.psFile.push(args); if (calls.psFile.length === 2) state.current = { map: MAP, services: [svc('egpt-beeper-primary', DO.services[0].appParameters), svc('egpt-beeper-secondary', DO.services[1].appParameters)] }; },
    });
    const home = mkdtempSync(join(tmpdir(), 'egpt-0001-'));
    const dir = mkdtempSync(join(tmpdir(), 'egpt-0001-dir-'));
    cpSync(join(import.meta.dirname, '..', 'migrations', '0001-beeper-services-carry-role.mjs'), join(dir, '0001-beeper-services-carry-role.mjs'));
    // The copy imports nothing relative, so it loads from a temp dir as it would from the repo.
    const unelevated = await runMigrations({ dir, egptHome: home, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(unelevated.exitCode).toBe(2);
    expect(unelevated.results[0].outcome).toBe('pending-elevation');
    expect(calls.psFile).toEqual([]);

    const elevatedRun = await runMigrations({ dir, egptHome: home, elevated: true, platform: 'win32', ctx, log: () => {} });
    expect(elevatedRun.exitCode).toBe(0);
    expect(elevatedRun.results[0].outcome).toBe('applied');
    expect(calls.psFile.length).toBe(2);
  });
});

describe('0001 refuses by name when the evidence is ambiguous', () => {
  const refusal = async (services) => {
    const { ctx, calls } = ctxFor({ map: MAP, services });
    let err;
    try { await plan(ctx); } catch (e) { err = e; }
    expect(calls.psFile).toEqual([]);
    return err?.message;
  };
  const ANDIR = '--user-data-dir=C:/Users/an/.egpt/state/an-beeper/userdata';
  const RODZDIR = '--user-data-dir=C:/Users/an/.egpt/state/rodz-beeper/userdata';

  it('the name says primary but the service serves the secondary port', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} --remote-debugging-port=9225`)]))
      .toBe("0001 refuses: egpt-primary: setup/beeper-s0-naming.ps1 maps it to egpt-beeper-primary, but it serves CDP 9225, the secondary's port - the name and the evidence disagree");
  });

  it('BeeperRodz on the primary port - an account name is a guess, the port decides, and they disagree', async () => {
    expect(await refusal([svc('BeeperRodz', `${RODZDIR} --remote-debugging-port=9223`)])).toMatch(/BeeperRodz: .* maps it to egpt-beeper-secondary, but it serves CDP 9223/);
  });

  it('no CDP port, or an unknown one', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} ${FLAGS}`)])).toMatch(/egpt-primary: its AppParameters carry 0 --remote-debugging-port flags/);
    expect(await refusal([svc('egpt-primary', `${ANDIR} --remote-debugging-port=9224`)])).toMatch(/egpt-primary: CDP port 9224 names no role/);
  });

  it('no --user-data-dir on a service that is to be renamed', async () => {
    expect(await refusal([svc('egpt-primary', '--remote-debugging-port=9223')])).toMatch(/egpt-primary: its AppParameters carry 0 --user-data-dir flags/);
  });

  it('two services claim one role', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} --remote-debugging-port=9223`), svc('BeeperAn', `${RODZDIR} --remote-debugging-port=9223`)]))
      .toMatch(/egpt-primary and BeeperAn both serve the primary's CDP port/);
  });

  it('the target name already exists beside the legacy service', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} --remote-debugging-port=9223`), svc('egpt-beeper-primary', '--remote-debugging-port=9223')]))
      .toMatch(/egpt-primary would become egpt-beeper-primary, which already exists/);
  });

  it('two services share one install', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} --remote-debugging-port=9223`), svc('BeeperRodz', `--user-data-dir="C:\\Users\\an\\.egpt\\state\\an-beeper\\userdata\\" --remote-debugging-port=9225`)]))
      .toMatch(/egpt-primary and BeeperRodz share --user-data-dir/);
  });

  it('a service that does not run as LocalSystem - the rename script would stop to ask for a password', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} --remote-debugging-port=9223`, { startName: '.\\an' })]))
      .toMatch(/egpt-primary runs as \.\\an, not LocalSystem/);
  });
});
