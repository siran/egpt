// tests/migrations-0005-daemon-task-description.test.mjs — migrations/0005-daemon-task-has-description.mjs.
//
// The XML fixtures are the exports MEASURED on 2026-09-16 (read-only): kg's and do's `egpt-daemon`
// task, identical but for the SID and the machine name, both with no <Description>, both in state
// 3. The DESCRIBED shape - <Description> on its own line directly above <URI> - is the export of a
// throwaway task registered with Register-ScheduledTask -Description the same day, so "what 0005
// writes" and "what the registrar's registration exports" are compared as the same bytes.
//
// What is under test: exactly one line is added, the re-export must equal it byte for byte with
// the DACL unchanged, and otherwise the original export is put back and the migration refuses.
// Task Scheduler is a fake: a map of name -> { xml, dacl, state } the scripts are dispatched against.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, probeScript, updateScript } from '../migrations/0005-daemon-task-has-description.mjs';
import { runMigrations, runPowerShell } from '../setup/migrate.mjs';

const REPO = join(import.meta.dirname, '..');
const NODES = {
  kg: { sid: 'S-1-5-21-2140830422-4106283080-3982958092-1001', machine: 'reve' },
  do: { sid: 'S-1-5-21-2659214498-2217865581-3355271446-1001', machine: 'DOLLY' },
};
const daclOf = (sid) => `D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;${sid})(A;;FR;;;${sid})`;
// What setup/egpt-daemon-task-labels.ps1 returns - checked against the real module below, on Windows.
const TARGET = (name) => `eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon. Disable it and the spine stays in session 0 (the ${name} service), where any browser it starts is invisible.`;

const taskXml = ({ name = 'egpt-daemon', node = 'kg', description } = {}) => [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <RegistrationInfo>',
  ...(description === undefined ? [] : [`    <Description>${description}</Description>`]),
  `    <URI>\\${name}</URI>`,
  '  </RegistrationInfo>',
  '  <Principals>',
  '    <Principal id="Author">',
  `      <UserId>${NODES[node].sid}</UserId>`,
  '      <LogonType>InteractiveToken</LogonType>',
  '    </Principal>',
  '  </Principals>',
  '  <Settings>',
  '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
  '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
  '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
  '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
  '    <RestartOnFailure>',
  '      <Count>99</Count>',
  '      <Interval>PT1M</Interval>',
  '    </RestartOnFailure>',
  '    <IdleSettings>',
  '      <Duration>PT10M</Duration>',
  '      <WaitTimeout>PT1H</WaitTimeout>',
  '      <StopOnIdleEnd>true</StopOnIdleEnd>',
  '      <RestartOnIdle>false</RestartOnIdle>',
  '    </IdleSettings>',
  '    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>',
  '  </Settings>',
  '  <Triggers>',
  '    <LogonTrigger>',
  `      <UserId>${NODES[node].machine}\\an</UserId>`,
  '    </LogonTrigger>',
  '  </Triggers>',
  '  <Actions Context="Author">',
  '    <Exec>',
  '      <Command>C:\\WINDOWS\\System32\\wscript.exe</Command>',
  '      <Arguments>"C:\\Users\\an\\bin\\egpt\\setup\\session1-daemon-launcher.vbs" "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\an\\bin\\egpt" "C:\\Users\\an\\.egpt" "C:\\Users\\an\\.egpt\\config\\logs\\session1-daemon.log"</Arguments>',
  '      <WorkingDirectory>C:\\Users\\an\\bin\\egpt</WorkingDirectory>',
  '    </Exec>',
  '  </Actions>',
  '</Task>',
].join('\r\n');

// A fake Task Scheduler. `onUpdate(name, xml, store)` decides what Windows would store.
function fakeScheduler(tasks, { target = TARGET, onUpdate = (name, xml, prev) => ({ ...prev, xml }) } = {}) {
  const store = new Map(Object.entries(tasks));
  const calls = [];
  const ps = (script) => {
    const head = script.split('\n')[0];
    calls.push(head);
    if (head === '# egpt-0005:probe') {
      const name = script.match(/^\$name = '([^']+)'$/m)[1];
      return JSON.stringify(store.has(name) ? { target: target(name), exists: true, ...store.get(name) } : { target: target(name), exists: false });
    }
    const m = head.match(/^# egpt-0005:update (.+)$/);
    if (m) {
      const xml = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8');
      store.set(m[1], onUpdate(m[1], xml, store.get(m[1])));
      return '';
    }
    throw new Error(`unexpected script: ${head}`);
  };
  return { store, calls, ps };
}

const ctxWith = (sched, over = {}) => ({ platform: 'win32', egptHome: 'C:\\Users\\an\\.egpt', repo: 'C:\\Users\\an\\bin\\egpt', log: () => {}, ps: sched.ps, ...over });
const LIVE = (node, state = 3) => ({ 'egpt-daemon': { xml: taskXml({ node }), dacl: daclOf(NODES[node].sid), state } });

describe('0005 on kg and do - both tasks measured with an empty Description', () => {
  for (const node of ['kg', 'do']) {
    it(`${node}: plans one added line, the lossless check, and names the state`, async () => {
      const sched = fakeScheduler(LIVE(node));
      const p = await plan(ctxWith(sched));
      expect(p.satisfied).toBe(false);
      expect(p.changes).toEqual([
        're-register scheduled task egpt-daemon from its own exported XML, with one line added in <RegistrationInfo>:',
        `  +     <Description>${TARGET('egpt-daemon')}</Description>`,
        `verify: the re-export equals that byte for byte and the DACL is unchanged (${daclOf(NODES[node].sid)}) - else re-register the original export and refuse`,
        "egpt-daemon is not running by Task Scheduler's count (state 3) - a session 1 daemon started under its old name, before 0002 renamed it, is not counted; nothing is started or stopped either way",
      ]);
      expect(sched.calls).toEqual(['# egpt-0005:probe']);
    });

    it(`${node}: apply writes exactly the export a registration WITH that Description gives, and the re-plan is satisfied`, async () => {
      const sched = fakeScheduler(LIVE(node));
      const ctx = ctxWith(sched);
      await (await plan(ctx)).apply();
      expect(sched.calls).toEqual(['# egpt-0005:probe', '# egpt-0005:probe', '# egpt-0005:update egpt-daemon', '# egpt-0005:probe']);
      const after = sched.store.get('egpt-daemon');
      expect(after.xml).toBe(taskXml({ node, description: TARGET('egpt-daemon') }));
      // Every line but the one added is the export as it was: principal, trigger, action, settings.
      expect(after.xml.split('\r\n').filter((l) => !l.includes('<Description>'))).toEqual(taskXml({ node }).split('\r\n'));
      expect(after.dacl).toBe(daclOf(NODES[node].sid));
      expect((await plan(ctx)).satisfied).toBe(true);
    });
  }

  it('a RUNNING instance is named, and left running: no script stops or starts anything', async () => {
    const sched = fakeScheduler(LIVE('kg', 4));
    const p = await plan(ctxWith(sched));
    expect(p.changes.at(-1)).toBe('egpt-daemon is RUNNING: that instance is left running - an update of the registration does not stop or restart it, and nothing here starts one');
    await p.apply();
    expect(sched.store.get('egpt-daemon').state).toBe(4);
  });

  it('a second profile folder derives its own task, and its Description names its own service', async () => {
    const sched = fakeScheduler({ 'egpt-secondary-daemon': { xml: taskXml({ name: 'egpt-secondary-daemon' }), dacl: daclOf(NODES.kg.sid), state: 3 } });
    const p = await plan(ctxWith(sched, { egptHome: 'C:\\Users\\an\\.egpt-secondary' }));
    expect(p.changes[1]).toContain('(the egpt-secondary-daemon service)');
  });
});

describe('0005 apply - lossless or put back', () => {
  it('the re-export differs: the ORIGINAL export is re-registered, and the refusal names the line', async () => {
    const sched = fakeScheduler(LIVE('do'), {
      onUpdate: (name, xml, prev) => ({ ...prev, xml: xml.includes('<Description>') ? xml.replace('  <RegistrationInfo>', '  <RegistrationInfo>\r\n    <Date>2026-09-16T10:00:00</Date>') : xml }),
    });
    const p = await plan(ctxWith(sched));
    await expect(p.apply()).rejects.toThrow(/^0005 refuses: the Description change is not lossless on this node: the re-export differs from the XML given - line 4: expected " {4}<Description>eGPT spine supervisor .*<\/Description>", got " {4}<Date>2026-09-16T10:00:00<\/Date>"\. egpt-daemon was re-registered from its original export and exports it byte for byte again, with its DACL\.$/);
    expect(sched.store.get('egpt-daemon').xml).toBe(taskXml({ node: 'do' }));
    expect(sched.calls.filter((c) => c.startsWith('# egpt-0005:update'))).toHaveLength(2);
  });

  it('the DACL differs after the update: put back, and the refusal says the DACL did NOT come back', async () => {
    const sched = fakeScheduler(LIVE('kg'), { onUpdate: (name, xml, prev) => ({ ...prev, xml, dacl: 'D:(A;;FA;;;BA)' }) });
    await expect((await plan(ctxWith(sched))).apply()).rejects.toThrow(/its DACL is now D:\(A;;FA;;;BA\), it was D:.*Re-registering the original export did NOT give it back byte for byte - inspect egpt-daemon \(Export-ScheduledTask\) before the next logon\./);
    expect(sched.store.get('egpt-daemon').xml).toBe(taskXml({ node: 'kg' }));
  });

  it('putting it back fails too: both failures are named', async () => {
    let n = 0;
    const sched = fakeScheduler(LIVE('kg'), {
      onUpdate: (name, xml, prev) => { n += 1; if (n === 2) throw new Error('Access is denied.'); return { ...prev, xml: xml.replace('<Count>99</Count>', '<Count>3</Count>') }; },
    });
    await expect((await plan(ctxWith(sched))).apply()).rejects.toThrow(/the re-export differs from the XML given - line 19: expected " {6}<Count>99<\/Count>", got " {6}<Count>3<\/Count>"\. Re-registering the original export FAILED \(Access is denied\.\) - inspect egpt-daemon/);
  });

  it('Register-ScheduledTask itself fails: the error surfaces and the task is as it was', async () => {
    const sched = fakeScheduler(LIVE('kg'), { onUpdate: () => { throw new Error('Access is denied.'); } });
    await expect((await plan(ctxWith(sched))).apply()).rejects.toThrow('Access is denied.');
    expect(sched.store.get('egpt-daemon').xml).toBe(taskXml({ node: 'kg' }));
  });

  it('the task changed between plan and apply: refused before anything is registered', async () => {
    const sched = fakeScheduler(LIVE('kg'));
    const p = await plan(ctxWith(sched));
    sched.store.get('egpt-daemon').xml = sched.store.get('egpt-daemon').xml.replace('<Count>99</Count>', '<Count>3</Count>');
    await expect(p.apply()).rejects.toThrow(/0005 refuses: egpt-daemon changed since it was planned - re-run/);
    expect(sched.calls.some((c) => c.includes('update'))).toBe(false);
  });
});

describe('0005 idempotency and refusals', () => {
  it('a task the registrar registered (Description already there): satisfied, nothing registered', async () => {
    const sched = fakeScheduler({ 'egpt-daemon': { xml: taskXml({ description: TARGET('egpt-daemon') }), dacl: daclOf(NODES.kg.sid), state: 4 } });
    expect(await plan(ctxWith(sched))).toEqual({ satisfied: true, notes: [`egpt-daemon: "${TARGET('egpt-daemon')}"`] });
    expect(sched.calls).toEqual(['# egpt-0005:probe']);
  });

  it('no task, or not Windows: satisfied - a session 0 only node is a valid node', async () => {
    expect((await plan(ctxWith(fakeScheduler({})))).satisfied).toBe(true);
    const sched = fakeScheduler(LIVE('kg'));
    expect((await plan(ctxWith(sched, { platform: 'darwin' }))).satisfied).toBe(true);
    expect(sched.calls).toEqual([]);
  });

  it('some OTHER Description: refused, not overwritten', async () => {
    const sched = fakeScheduler({ 'egpt-daemon': { xml: taskXml({ description: 'set by hand' }), dacl: daclOf(NODES.kg.sid), state: 3 } });
    await expect(plan(ctxWith(sched))).rejects.toThrow('0005 refuses: egpt-daemon already carries a Description that is not this one ("set by hand") - replacing it is a human decision');
  });

  it('a task of that name that is not the session 1 daemon: refused', async () => {
    const sched = fakeScheduler({ 'egpt-daemon': { xml: taskXml().replace('session1-daemon-launcher.vbs', 'something-else.vbs'), dacl: daclOf(NODES.kg.sid), state: 3 } });
    await expect(plan(ctxWith(sched))).rejects.toThrow(/does not run setup\\session1-daemon-launcher\.vbs/);
  });

  it('an export with no <URI> line naming it: refused', async () => {
    const sched = fakeScheduler({ 'egpt-daemon': { xml: taskXml().replace('    <URI>\\egpt-daemon</URI>\r\n', ''), dacl: daclOf(NODES.kg.sid), state: 3 } });
    await expect(plan(ctxWith(sched))).rejects.toThrow(/does not carry exactly one <URI>\\egpt-daemon<\/URI> in <RegistrationInfo>/);
  });

  it('a labels module text that cannot round-trip through the XML: refused before anything is written', async () => {
    const sched = fakeScheduler(LIVE('kg'), { target: () => 'stop & start' });
    await expect(plan(ctxWith(sched))).rejects.toThrow(/egpt-daemon-task-labels\.ps1 gives "stop & start" - it must be one non-empty line with no XML metacharacters/);
  });
});

describe('0005 and the registrar stamp the same Description', () => {
  const registrar = readFileSync(join(REPO, 'setup', 'register-session1-daemon-task.ps1'), 'utf8');

  it('the probe takes it from setup/egpt-daemon-task-labels.ps1, for the name derived from the profile', () => {
    const s = probeScript('C:\\Users\\an\\bin\\egpt', 'egpt-daemon');
    expect(s).toContain(". 'C:\\Users\\an\\bin\\egpt\\setup\\egpt-daemon-task-labels.ps1'");
    expect(s).toContain("$name = 'egpt-daemon'");
    expect(s).toContain('Get-EgptDaemonTaskDescription -Name $name');
  });

  it('the registrar dot-sources the same module and registers with its text for the same name', () => {
    expect(registrar).toContain(". (Join-Path $PSScriptRoot 'egpt-daemon-task-labels.ps1')");
    expect(registrar).toContain('$TaskName = "$base-daemon"');
    expect(registrar).toContain('$Description = Get-EgptDaemonTaskDescription -Name $TaskName');
    expect(registrar).toMatch(/Register-ScheduledTask -TaskName \$TaskName [^\n]*`\r?\n[^\n]*-Description \$Description [^\n]*-Force/);
    expect(registrar).not.toMatch(/-Description\s+['"]/);
  });

  it.skipIf(process.platform !== 'win32')('the module, run for real, gives the text these fixtures use', () => {
    const out = runPowerShell(`. '${join(REPO, 'setup', 'egpt-daemon-task-labels.ps1')}'\nGet-EgptDaemonTaskDescription -Name 'egpt-daemon'\nGet-EgptDaemonTaskDescription -Name 'egpt-secondary-daemon'\n`);
    expect(out.split(/\r?\n/).filter(Boolean)).toEqual([TARGET('egpt-daemon'), TARGET('egpt-secondary-daemon')]);
  }, 20000);
});

describe('0005 PowerShell scripts', () => {
  it('the update is an in-place -Force registration from the XML, -ErrorAction Stop, carrying the XML exactly', () => {
    const xml = taskXml({ description: TARGET('egpt-daemon') });
    const s = updateScript('egpt-daemon', xml);
    expect(s).toContain("Register-ScheduledTask -Xml $xml -TaskName 'egpt-daemon' -TaskPath '\\' -Force -ErrorAction Stop");
    expect(Buffer.from(s.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8')).toBe(xml);
  });

  it('neither script stops, starts, ends or removes a task', () => {
    for (const s of [probeScript('C:\\r', 'egpt-daemon'), updateScript('egpt-daemon', '<x/>')]) {
      expect(s).not.toMatch(/Stop-ScheduledTask|Start-ScheduledTask|Unregister-ScheduledTask|Disable-ScheduledTask|\.Run\(|\.Stop\(/);
    }
  });
});

describe('0005 through the runner', () => {
  it('dry run on do: prints the added line, registers nothing, records nothing', async () => {
    const h = join(mkdtempSync(join(tmpdir(), 'egpt-0005-')), '.egpt');
    mkdirSync(join(h, 'config'), { recursive: true });
    writeFileSync(join(h, 'config', 'config.yaml'), 'node_name: zz\n');
    const sched = fakeScheduler(LIVE('do'));
    // The migrations before 0005 are told "nothing of yours here", as tests/migrations-0003-* does.
    const ps = (s) => (s.startsWith('# egpt-0005') ? sched.ps(s) : JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }));
    const lines = [];
    const { exitCode, results } = await runMigrations({ dir: join(REPO, 'migrations'), egptHome: h, dryRun: true, elevated: false, platform: 'win32', ctx: { ps }, log: (l) => lines.push(l) });
    expect(exitCode).toBe(0);
    expect(results.find((r) => r.id === '0005-daemon-task-has-description').outcome).toBe('would-apply');
    expect(lines.join('\n')).toContain(`<Description>${TARGET('egpt-daemon')}</Description>`);
    expect(sched.calls.filter((c) => c.includes('update'))).toEqual([]);
    expect(sched.store.get('egpt-daemon').xml).toBe(taskXml({ node: 'do' }));
    expect(existsSync(join(h, 'state'))).toBe(false);
  });
});
