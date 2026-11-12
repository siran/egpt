// tests/migrations-0001-beeper-services.test.mjs — migrations/0001-beeper-services-carry-role.mjs.
//
// The fixtures are the probe output MEASURED on 2026-09-16 (read-only) on each node, with the
// --remote-debugging-port / --remote-allow-origins flags removed as they were live on 2026-10-11:
//   kg: egpt-beeper-primary (no --user-data-dir) + egpt-beeper-secondary (rodz-beeper)
//       - already the target, so 0001 must report "already satisfied": the idempotency proof.
//   do: egpt-primary (an-beeper) + BeeperRodz (rodz-beeper) - BeeperRodz is named for an
//       account, so with no CDP port left nothing on it says its role, and 0001 refuses it.
// LEGACY is an unmigrated node whose names carry the role: both renamed, role read from the name.
// Nothing here touches the SCM: the PowerShell seams are injected.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0001-beeper-services-carry-role.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const BEEPER = 'C:\\Users\\user\\AppData\\Local\\Programs\\BeeperTexts\\Beeper.exe';
const FLAGS = '--disable-gpu --disable-gpu-compositing --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows';
const MAP = [
  { old: 'egpt-primary', new: 'egpt-beeper-primary' },
  { old: 'egpt-secondary', new: 'egpt-beeper-secondary' },
  { old: 'BeeperAn', new: 'egpt-beeper-primary' },
  { old: 'BeeperRodz', new: 'egpt-beeper-secondary' },
];
const svc = (name, appParameters, extra = {}) => ({ name, appParameters, application: BEEPER, startMode: 'Auto', state: 'Running', startName: 'LocalSystem', ...extra });
const ANDIR = '--user-data-dir=C:/Users/user/.egpt/state/an-beeper/userdata';
const RODZDIR = '--user-data-dir=C:/Users/user/.egpt/state/rodz-beeper/userdata';

const KG = {
  map: MAP,
  services: [
    svc('egpt-beeper-primary', FLAGS),
    svc('egpt-beeper-secondary', `${RODZDIR} ${FLAGS}`),
  ],
};
const DO = {
  map: MAP,
  services: [
    svc('egpt-primary', `${ANDIR} ${FLAGS}`),
    svc('BeeperRodz', `${RODZDIR} ${FLAGS}`),
  ],
};
const LEGACY = {
  map: MAP,
  services: [
    svc('egpt-primary', `${ANDIR} ${FLAGS}`),
    svc('egpt-secondary', `${RODZDIR} ${FLAGS}`),
  ],
};

function ctxFor(state, over = {}) {
  const calls = { ps: [], psFile: [] };
  const ctx = {
    platform: 'win32',
    repo: 'C:\\Users\\user\\bin\\egpt',
    log: () => {},
    ps: (script) => { calls.ps.push(script); return JSON.stringify(state.current ?? state); },
    psFile: (file, args) => { calls.psFile.push([file, ...args]); },
    ...over,
  };
  return { ctx, calls };
}

describe('0001 on kg - already the target, no CDP flag on either service', () => {
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
    expect(calls.ps[0]).toContain(". 'C:\\Users\\user\\bin\\egpt\\setup\\beeper-s0-naming.ps1'");
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

describe('0001 on an unmigrated node - the role is read from the name, no CDP port needed', () => {
  it('plans both renames, SECONDARY first, with no --remote-debugging-port on either service', async () => {
    const { ctx } = ctxFor(LEGACY);
    const p = await plan(ctx);
    expect(p.satisfied).toBe(false);
    const text = p.changes.join('\n');
    expect(p.changes[0]).toBe('rename service egpt-secondary -> egpt-beeper-secondary   (Running, Auto, LocalSystem)');
    expect(text).toContain('evidence: its name says secondary; --user-data-dir=C:/Users/user/.egpt/state/rodz-beeper/userdata');
    expect(text).toContain('rename service egpt-primary -> egpt-beeper-primary');
    expect(text).toContain('evidence: its name says primary; --user-data-dir=C:/Users/user/.egpt/state/an-beeper/userdata');
    expect(text.indexOf('egpt-secondary ->')).toBeLessThan(text.indexOf('egpt-primary ->'));
  });

  it('apply CALLS setup/rename-beeper-s0-service.ps1 - it does not reimplement the rename', async () => {
    const { ctx, calls } = ctxFor(LEGACY);
    await (await plan(ctx)).apply();
    const script = join('C:\\Users\\user\\bin\\egpt', 'setup', 'rename-beeper-s0-service.ps1');
    expect(calls.psFile).toEqual([
      [script, '-From', 'egpt-secondary', '-To', 'egpt-beeper-secondary'],
      [script, '-From', 'egpt-primary', '-To', 'egpt-beeper-primary'],
    ]);
  });

  it('through the runner, elevated: renames, re-checks, records - and unelevated it is PENDING and untouched', async () => {
    const state = { current: LEGACY };
    const { ctx, calls } = ctxFor(state, {
      psFile: (file, args) => { calls.psFile.push(args); if (calls.psFile.length === 2) state.current = { map: MAP, services: [svc('egpt-beeper-primary', LEGACY.services[0].appParameters), svc('egpt-beeper-secondary', LEGACY.services[1].appParameters)] }; },
    });
    const home = mkdtempSync(join(tmpdir(), 'egpt-0001-'));
    mkdirSync(join(home, 'config'));
    writeFileSync(join(home, 'config', 'config.yaml'), 'node_name: zz\npeer_nodes: [zz, kg]\n');   // a peer node: the runner is for those only
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
  const refusal = async (services, map = MAP) => {
    const { ctx, calls } = ctxFor({ map, services });
    let err;
    try { await plan(ctx); } catch (e) { err = e; }
    expect(calls.psFile).toEqual([]);
    return err?.message;
  };

  it('do as measured: BeeperRodz is named for an account, so nothing on it says its role - a human decides', async () => {
    expect(await refusal(DO.services))
      .toBe('0001 refuses: BeeperRodz: its name carries no role (primary/secondary) - rename it by hand with setup/rename-beeper-s0-service.ps1');
  });

  it('the name says primary but the map sends it to the secondary', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} ${FLAGS}`)], [{ old: 'egpt-primary', new: 'egpt-beeper-secondary' }]))
      .toBe('0001 refuses: egpt-primary: setup/beeper-s0-naming.ps1 maps it to egpt-beeper-secondary, but its name says primary - the name and the map disagree');
  });

  it('no --user-data-dir on a service that is to be renamed', async () => {
    expect(await refusal([svc('egpt-primary', FLAGS)])).toMatch(/egpt-primary: its AppParameters carry 0 --user-data-dir flags/);
  });

  it('the target name already exists beside the legacy service', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} ${FLAGS}`), svc('egpt-beeper-primary', FLAGS)]))
      .toMatch(/egpt-primary would become egpt-beeper-primary, which already exists/);
  });

  it('two services share one install', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} ${FLAGS}`), svc('egpt-secondary', `--user-data-dir="C:\\Users\\user\\.egpt\\state\\an-beeper\\userdata\\" ${FLAGS}`)]))
      .toMatch(/egpt-primary and egpt-secondary share --user-data-dir/);
  });

  it('a service that does not run as LocalSystem - the rename script would stop to ask for a password', async () => {
    expect(await refusal([svc('egpt-primary', `${ANDIR} ${FLAGS}`, { startName: '.\\user' })]))
      .toMatch(/egpt-primary runs as \.\\user, not LocalSystem/);
  });
});
