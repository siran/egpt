// tests/migrations-0004-daemon-service-labels.test.mjs — migrations/0004-daemon-service-carries-installer-label.mjs.
//
// The fixtures are the probe output MEASURED on 2026-09-16 (read-only) on each node:
//   kg: labels already what install-nssm-service.ps1 stamps, AppEnvironmentExtra carrying both
//       EGPT_HOME and EGPT_HOMES=C:/Users/an/.egpt - 0004 must read "already satisfied" from the
//       service's OWN list: the idempotency proof.
//   do: an older hand install's labels, EGPT_HOME=C:\Users\an\.egpt only - both labels change.
// What is under test beyond that: only the two labels are set, by sc.exe, and every other value
// under the service key must come back identical or the migration refuses naming it.
// The SCM is a fake: the probe returns the fixture and the label script is applied to it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, probeScript, labelScript, profileListOf, displayNameFor, descriptionFor } from '../migrations/0004-daemon-service-carries-installer-label.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const v = (kind, value) => ({ kind, value });
const FAILURE_ACTIONS = v('Binary', 'gFEBAAAAAAAAAAAAAwAAABQAAAABAAAAiBMAAAEAAACIEwAAAQAAAIgTAAA=');

const KG = () => ({
  exists: true,
  keys: {
    '': {
      Type: v('DWord', 16), Start: v('DWord', 2), ErrorControl: v('DWord', 1),
      ImagePath: v('ExpandString', 'C:\\Users\\an\\bin\\egpt\\setup\\bin\\egpt-service.exe'),
      DisplayName: v('String', 'eGPT node supervisor (egpt-daemon)'),
      ObjectName: v('String', '.\\an'), DelayedAutostart: v('DWord', 0), FailureActionsOnNonCrashFailures: v('DWord', 1),
      Description: v('String', 'eGPT spine supervisor (egpt-daemon.mjs) for profile(s) C:/Users/an/.egpt. Stop it and this node goes silent.'),
      FailureActions: FAILURE_ACTIONS,
    },
    Parameters: {
      Application: v('ExpandString', 'C:\\Program Files\\nodejs\\node.exe'),
      AppParameters: v('ExpandString', 'C:\\Users\\an\\bin\\egpt\\egpt-daemon.mjs'),
      AppDirectory: v('ExpandString', 'C:\\Users\\an\\bin\\egpt'),
      AppEnvironmentExtra: v('MultiString', ['EGPT_HOME=C:/Users/an/.egpt', 'EGPT_HOMES=C:/Users/an/.egpt']),
      AppStdout: v('ExpandString', 'C:\\Users\\an\\.egpt\\config\\logs\\daemon-stdout.log'),
      AppStderr: v('ExpandString', 'C:\\Users\\an\\.egpt\\config\\logs\\daemon-stderr.log'),
      AppRotateFiles: v('DWord', 1), AppRotateOnline: v('DWord', 1), AppRotateBytes: v('DWord', 10485760),
      AppRestartDelay: v('DWord', 5000), AppStopMethodConsole: v('DWord', 10000),
    },
    'Parameters\\AppExit': { '': v('String', 'Restart') },
  },
});

const DO_DISPLAY = 'egpt personal AI bridge daemon';
const DO_DESCRIPTION = 'Node.js egpt-daemon.mjs wrapped via NSSM. Holds the WhatsApp bridge + engine. Equivalent to the egpt-spine Task Scheduler task; replaces it on Modern Standby hardware where TS wakes are suppressed during sleep.';
const DO = () => ({
  exists: true,
  keys: {
    '': {
      Type: v('DWord', 16), Start: v('DWord', 2), ErrorControl: v('DWord', 1),
      ImagePath: v('ExpandString', 'C:\\Users\\an\\.egpt\\bin\\egpt-service.exe'),
      DisplayName: v('String', DO_DISPLAY),
      ObjectName: v('String', '.\\an'), DelayedAutostart: v('DWord', 0), FailureActionsOnNonCrashFailures: v('DWord', 1),
      Description: v('String', DO_DESCRIPTION),
      FailureActions: FAILURE_ACTIONS,
    },
    Parameters: {
      Application: v('ExpandString', 'C:\\Program Files\\nodejs\\node.exe'),
      AppParameters: v('ExpandString', 'C:\\Users\\an\\bin\\egpt\\egpt-daemon.mjs'),
      AppDirectory: v('ExpandString', 'C:\\Users\\an\\bin\\egpt'),
      AppStdout: v('ExpandString', 'C:\\Users\\an\\.egpt\\config\\logs\\service-stdout.log'),
      AppStderr: v('ExpandString', 'C:\\Users\\an\\.egpt\\config\\logs\\service-stderr.log'),
      AppRotateFiles: v('DWord', 1), AppRotateOnline: v('DWord', 1), AppRotateBytes: v('DWord', 10485760),
      AppRestartDelay: v('DWord', 5000), AppStopMethodSkip: v('DWord', 0), AppStopMethodConsole: v('DWord', 10000),
      AppStopMethodWindow: v('DWord', 5000), AppStopMethodThreads: v('DWord', 5000),
      AppEnvironmentExtra: v('MultiString', ['EGPT_HOME=C:\\Users\\an\\.egpt']),
    },
    'Parameters\\AppExit': { '': v('String', 'Restart') },
  },
});

const DO_WANT_DISPLAY = 'eGPT node supervisor (egpt-daemon)';
const DO_WANT_DESCRIPTION = 'eGPT spine supervisor (egpt-daemon.mjs) for profile(s) C:\\Users\\an\\.egpt. Stop it and this node goes silent.';

// A fake SCM over one service's registry snapshot. The label script is read back the way sc.exe
// would take it; `onLabel(state)` lets a test decide what else Windows changed.
const unq = (s) => s.slice(1, -1).replace(/''/g, "'");
function fakeScm(state, { onLabel = () => {} } = {}) {
  const calls = [];
  const ps = (script) => {
    const head = script.split('\n')[0];
    calls.push(head);
    if (head === '# egpt-0004:probe') return JSON.stringify(state.current);
    if (head === '# egpt-0004:label egpt-daemon') {
      const dn = script.match(/sc\.exe config 'egpt-daemon' DisplayName= ('(?:[^']|'')*')/);
      const d = script.match(/sc\.exe description 'egpt-daemon' ('(?:[^']|'')*')/);
      if (dn) state.current.keys[''].DisplayName = v('String', unq(dn[1]));
      if (d) state.current.keys[''].Description = v('String', unq(d[1]));
      onLabel(state.current);
      return '[SC] ChangeServiceConfig SUCCESS';
    }
    throw new Error(`unexpected script: ${head}`);
  };
  return { calls, ps };
}
const ctxWith = (scm, over = {}) => ({ platform: 'win32', egptHome: 'C:\\Users\\an\\.egpt', log: () => {}, ps: scm.ps, ...over });

describe('0004 on kg - already carries the installer labels', () => {
  it('reads already satisfied from the service\'s OWN profile list, and sets nothing', async () => {
    const scm = fakeScm({ current: KG() });
    const p = await plan(ctxWith(scm));
    expect(p).toEqual({ satisfied: true, notes: ['egpt-daemon: "eGPT node supervisor (egpt-daemon)" - "eGPT spine supervisor (egpt-daemon.mjs) for profile(s) C:/Users/an/.egpt. Stop it and this node goes silent."'] });
    expect(scm.calls).toEqual(['# egpt-0004:probe']);
  });

  it('the list is the service\'s, not this run\'s profile: a run from another spelling of the folder still reads it', async () => {
    const scm = fakeScm({ current: KG() });
    expect((await plan(ctxWith(scm, { egptHome: 'D:\\elsewhere\\.egpt' }))).satisfied).toBe(true);
  });

  it('a node with no egpt-daemon service is satisfied; off Windows nothing is asked', async () => {
    expect((await plan(ctxWith(fakeScm({ current: { exists: false } })))).satisfied).toBe(true);
    const scm = fakeScm({ current: KG() });
    expect((await plan(ctxWith(scm, { platform: 'linux' }))).satisfied).toBe(true);
    expect(scm.calls).toEqual([]);
  });
});

describe('0004 on do - the older hand install\'s labels', () => {
  it('plans both labels, the list from do\'s own EGPT_HOME, and says the service is not restarted', async () => {
    const p = await plan(ctxWith(fakeScm({ current: DO() })));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      'service egpt-daemon (runs as .\\an) - its labels only, by sc.exe. It is not stopped, restarted or reinstalled.',
      '  DisplayName',
      `    - ${DO_DISPLAY}`,
      `    + ${DO_WANT_DISPLAY}`,
      '  Description',
      `    - ${DO_DESCRIPTION}`,
      `    + ${DO_WANT_DESCRIPTION}`,
      "  the profile list is the service's own, from its AppEnvironmentExtra: EGPT_HOME=C:\\Users\\an\\.egpt",
      'verify: every other value under HKLM\\SYSTEM\\CurrentControlSet\\Services\\egpt-daemon, subkeys included (ImagePath, ObjectName, Start, Parameters\\AppParameters, Parameters\\AppEnvironmentExtra, ...), is identical afterwards - else refuse and name what differs',
    ]);
  });

  it('apply: one sc.exe script for both labels, every other value identical, and the re-plan is satisfied', async () => {
    const state = { current: DO() };
    const scm = fakeScm(state);
    const ctx = ctxWith(scm);
    await (await plan(ctx)).apply();
    expect(scm.calls).toEqual(['# egpt-0004:probe', '# egpt-0004:probe', '# egpt-0004:label egpt-daemon', '# egpt-0004:probe']);
    const want = DO();
    want.keys[''].DisplayName = v('String', DO_WANT_DISPLAY);
    want.keys[''].Description = v('String', DO_WANT_DESCRIPTION);
    expect(state.current).toEqual(want);
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('only the label that differs is set', async () => {
    const start = DO();
    start.keys[''].DisplayName = v('String', DO_WANT_DISPLAY);
    const lines = [];
    const scm = fakeScm({ current: start });
    const orig = scm.ps;
    const p = await plan(ctxWith({ ...scm, ps: (s) => { lines.push(s); return orig(s); } }));
    expect(p.changes.join('\n')).not.toContain('DisplayName\n');
    await p.apply();
    const label = lines.find((s) => s.startsWith('# egpt-0004:label'));
    expect(label).toContain('sc.exe description');
    expect(label).not.toContain('DisplayName=');
  });
});

describe('0004 refuses when setting the labels changed anything else', () => {
  const cases = [
    ['the binary path', (s) => { s.keys[''].ImagePath = v('ExpandString', 'C:\\Users\\an\\bin\\egpt\\setup\\bin\\egpt-service.exe'); }, /ImagePath: before \{"kind":"ExpandString","value":"C:\\\\Users\\\\an\\\\.egpt\\\\bin\\\\egpt-service.exe"\}, after/],
    ['AppParameters', (s) => { s.keys.Parameters.AppParameters = v('ExpandString', 'C:\\Users\\an\\src\\egpt\\egpt-daemon.mjs'); }, /Parameters\\AppParameters: before/],
    ['AppEnvironmentExtra', (s) => { s.keys.Parameters.AppEnvironmentExtra = v('MultiString', []); }, /Parameters\\AppEnvironmentExtra: before \{"kind":"MultiString","value":\["EGPT_HOME=C:\\\\Users\\\\an\\\\.egpt"\]\}, after \{"kind":"MultiString","value":\[\]\}/],
    ['the account', (s) => { s.keys[''].ObjectName = v('String', 'LocalSystem'); }, /ObjectName: before \{"kind":"String","value":".\\\\an"\}, after \{"kind":"String","value":"LocalSystem"\}/],
    ['the start mode', (s) => { s.keys[''].Start = v('DWord', 3); }, /Start: before \{"kind":"DWord","value":2\}, after \{"kind":"DWord","value":3\}/],
    ['a value that appeared', (s) => { s.keys[''].DelayedAutostart = v('DWord', 1); s.keys[''].Group = v('String', 'x'); }, /DelayedAutostart: .*; Group: before null, after/],
    ['a subkey that went away', (s) => { delete s.keys['Parameters\\AppExit']; }, /subkey Parameters\\AppExit was removed/],
  ];
  for (const [what, mutate, message] of cases) {
    it(`${what}`, async () => {
      const scm = fakeScm({ current: DO() }, { onLabel: mutate });
      const p = await plan(ctxWith(scm));
      let err;
      try { await p.apply(); } catch (e) { err = e; }
      expect(err?.message).toMatch(/^0004 refuses: setting the labels on egpt-daemon changed more than the labels - /);
      expect(err.message).toMatch(message);
      expect(err.message).toContain('The labels are already set; nothing was put back.');
    });
  }

  it('the service changed between plan and apply: refused before sc.exe runs', async () => {
    const state = { current: DO() };
    const scm = fakeScm(state);
    const p = await plan(ctxWith(scm));
    state.current.keys.Parameters.AppDirectory = v('ExpandString', 'C:\\Users\\an\\src\\egpt');
    await expect(p.apply()).rejects.toThrow(/0004 refuses: egpt-daemon changed since it was planned - re-run/);
    expect(scm.calls.some((c) => c.includes('label'))).toBe(false);
  });

  it('sc.exe itself fails: the error surfaces', async () => {
    const scm = fakeScm({ current: DO() });
    const ps = (s) => { if (s.startsWith('# egpt-0004:label')) throw new Error('PowerShell exited 1: sc.exe config DisplayName exited 5 - [SC] ChangeServiceConfig FAILED 5: Access is denied.'); return scm.ps(s); };
    await expect((await plan(ctxWith(scm, { ps }))).apply()).rejects.toThrow(/Access is denied/);
  });
});

describe('0004 refuses what it does not know, by name', () => {
  it('a service of that name that does not run egpt-daemon.mjs', async () => {
    const s = DO();
    s.keys.Parameters.AppParameters = v('ExpandString', 'C:\\somewhere\\other.mjs');
    await expect(plan(ctxWith(fakeScm({ current: s })))).rejects.toThrow('0004 refuses: egpt-daemon\'s nssm AppParameters ("C:\\\\somewhere\\\\other.mjs") do not run egpt-daemon.mjs - it is not the service this migration knows');
  });

  it('an environment with neither EGPT_HOMES nor EGPT_HOME', async () => {
    const s = DO();
    s.keys.Parameters.AppEnvironmentExtra = v('MultiString', ['NODE_OPTIONS=--max-old-space-size=4096']);
    await expect(plan(ctxWith(fakeScm({ current: s })))).rejects.toThrow(/carries neither EGPT_HOMES nor EGPT_HOME, so the profile list its Description names cannot be read/);
    delete s.keys.Parameters.AppEnvironmentExtra;
    await expect(plan(ctxWith(fakeScm({ current: s })))).rejects.toThrow(/AppEnvironmentExtra \(null\) carries neither/);
  });
});

describe('0004 derives the profile list the way install-nssm-service.ps1 builds it', () => {
  it('EGPT_HOMES wins over EGPT_HOME, in order, split on ; or , and joined with ", "', () => {
    expect(profileListOf(['EGPT_HOME=C:/Users/an/.egpt', 'EGPT_HOMES=C:/Users/an/.egpt;C:/Users/an/.egpt-secondary']).list).toEqual(['C:/Users/an/.egpt', 'C:/Users/an/.egpt-secondary']);
    expect(descriptionFor(profileListOf(['EGPT_HOMES= C:/b , C:/a ;;']).list)).toBe('eGPT spine supervisor (egpt-daemon.mjs) for profile(s) C:/b, C:/a. Stop it and this node goes silent.');
  });

  it('EGPT_HOME alone, verbatim - slashes as the service carries them', () => {
    expect(profileListOf(['EGPT_HOME=C:\\Users\\an\\.egpt'])).toEqual({ from: 'EGPT_HOME=C:\\Users\\an\\.egpt', list: ['C:\\Users\\an\\.egpt'] });
  });

  it('a blank EGPT_HOMES is no list - EGPT_HOME, as the daemon itself falls back', () => {
    expect(profileListOf(['EGPT_HOME=C:/x', 'EGPT_HOMES=']).list).toEqual(['C:/x']);
  });

  it('install-nssm-service.ps1 still stamps exactly these two templates, and splits -EgptHomes the same way', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'setup', 'install-nssm-service.ps1'), 'utf8');
    const dn = src.match(/nssm set \$ServiceName DisplayName\s+"([^"]+)"/)[1];
    const d = src.match(/nssm set \$ServiceName Description\s+"([^"]+)"/)[1];
    expect(dn.replace('$ServiceName', 'egpt-x-daemon')).toBe(displayNameFor('egpt-x-daemon'));
    expect(d.replace("$($profileList -join ', ')", 'C:/a, C:/b')).toBe(descriptionFor(['C:/a', 'C:/b']));
    expect(src).toContain("$EgptHomes.Split(@(';', ','), [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() } | Where-Object { $_ }");
  });
});

describe('0004 PowerShell scripts', () => {
  it('the label script runs sc.exe for the labels and nothing else - no reinstall, no stop, no credential', () => {
    const s = labelScript('egpt-daemon', { displayName: 'eGPT node supervisor (egpt-daemon)', description: "for profile(s) C:/Users/O'Brien/.egpt." });
    expect(s).toContain("& sc.exe config 'egpt-daemon' DisplayName= 'eGPT node supervisor (egpt-daemon)'");
    expect(s).toContain("& sc.exe description 'egpt-daemon' 'for profile(s) C:/Users/O''Brien/.egpt.'");
    expect(s.match(/\$LASTEXITCODE -ne 0/g)).toHaveLength(2);
    for (const bad of [/nssm/i, /Stop-Service|Start-Service|Restart-Service|New-Service|Remove-Service/i, /sc\.exe (stop|start|delete|create)/i, /Get-Credential|obj=|password=/i]) {
      expect(s).not.toMatch(bad);
    }
  });

  it('the probe only reads: registry opened read-only, values unexpanded', () => {
    const s = probeScript('egpt-daemon');
    expect(s).toContain('OpenSubKey("SYSTEM\\CurrentControlSet\\Services\\$name")');
    expect(s).toContain("'DoNotExpandEnvironmentNames'");
    expect(s).not.toMatch(/OpenSubKey\([^)]*,\s*\$true|CreateSubKey|SetValue|DeleteValue|sc\.exe|Set-ItemProperty/);
  });
});

describe('0004 through the runner', () => {
  const home = () => { const h = join(mkdtempSync(join(tmpdir(), 'egpt-0004-')), '.egpt'); mkdirSync(h); return h; };
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'egpt-0004-dir-'));
    // The copy imports nothing relative, so it loads from a temp dir as it would from the repo.
    cpSync(join(import.meta.dirname, '..', 'migrations', '0004-daemon-service-carries-installer-label.mjs'), join(d, '0004-daemon-service-carries-installer-label.mjs'));
    return d;
  };

  it('dry run on do: prints both labels, runs no sc.exe, records nothing', async () => {
    const h = home();
    const scm = fakeScm({ current: DO() });
    const lines = [];
    const { exitCode, results } = await runMigrations({ dir: dir(), egptHome: h, dryRun: true, elevated: true, platform: 'win32', ctx: { ps: scm.ps }, log: (l) => lines.push(l) });
    expect(exitCode).toBe(0);
    expect(results[0].outcome).toBe('would-apply');
    expect(lines.join('\n')).toContain(`+ ${DO_WANT_DESCRIPTION}`);
    expect(scm.calls.every((c) => c === '# egpt-0004:probe')).toBe(true);
    expect(existsSync(join(h, 'state'))).toBe(false);
  });

  it('unelevated on do: PENDING, nothing set; elevated: applied and recorded; kg unelevated: recorded as satisfied', async () => {
    const h = home();
    const d = dir();
    const state = { current: DO() };
    const scm = fakeScm(state);
    const unelevated = await runMigrations({ dir: d, egptHome: h, elevated: false, platform: 'win32', ctx: { ps: scm.ps }, log: () => {} });
    expect([unelevated.exitCode, unelevated.results[0].outcome]).toEqual([2, 'pending-elevation']);
    expect(state.current).toEqual(DO());

    const elevatedRun = await runMigrations({ dir: d, egptHome: h, elevated: true, platform: 'win32', ctx: { ps: scm.ps }, log: () => {} });
    expect([elevatedRun.exitCode, elevatedRun.results[0].outcome]).toEqual([0, 'applied']);
    expect(JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0004-daemon-service-carries-installer-label'].outcome).toBe('applied');

    const kgHome = home();
    const kg = await runMigrations({ dir: d, egptHome: kgHome, elevated: false, platform: 'win32', ctx: { ps: fakeScm({ current: KG() }).ps }, log: () => {} });
    expect([kg.exitCode, kg.results[0].outcome]).toEqual([0, 'satisfied']);
  });
});
