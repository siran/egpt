// tests/migrations-0002-session1-task.test.mjs — migrations/0002-session1-task-is-egpt-daemon.mjs.
//
// The session 1 task drives the S0 -> S1 handover, so what is under test is that the rename is
// LOSSLESS OR NOTHING: the new task is registered from the old task's own exported XML with only
// <URI> changed, re-exported and compared byte for byte (and its DACL), and the old task is
// removed only after that holds. Otherwise the new one is removed and the old one left as it was.
//
// The XML fixture is the export MEASURED on kg and do on 2026-09-16 (identical but for the SID
// and the machine name), with the SID replaced. Task Scheduler is a fake: a map of name ->
// { xml, dacl, state } that the migration's PowerShell scripts are dispatched against.
import { describe, it, expect } from 'vitest';
import { plan, probeScript, registerScript, unregisterScript } from '../migrations/0002-session1-task-is-egpt-daemon.mjs';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const DACL = `D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;${SID})(A;;FR;;;${SID})`;
const taskXml = (name) => [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <RegistrationInfo>',
  `    <URI>\\${name}</URI>`,
  '  </RegistrationInfo>',
  '  <Principals>',
  '    <Principal id="Author">',
  `      <UserId>${SID}</UserId>`,
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
  '      <UserId>DOLLY\\an</UserId>',
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

// A fake Task Scheduler. `onRegister(name, xml)` lets a test decide what Windows would store.
function fakeScheduler(tasks, { onRegister = (name, xml) => ({ xml, dacl: DACL, state: 3 }) } = {}) {
  const store = new Map(Object.entries(tasks));
  const calls = [];
  const ps = (script) => {
    const head = script.split('\n')[0];
    calls.push(head);
    if (head === '# egpt-0002:probe') {
      const [, from, to] = script.match(/from = '([^']+)'; to = '([^']+)'/);
      const view = (n) => (store.has(n) ? { exists: true, ...store.get(n) } : { exists: false });
      return JSON.stringify({ from: view(from), to: view(to) });
    }
    let m;
    if ((m = head.match(/^# egpt-0002:register (.+)$/))) {
      if (store.has(m[1])) throw new Error('Cannot create a file when that file already exists.');
      const xml = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8');
      store.set(m[1], onRegister(m[1], xml));
      return '';
    }
    if ((m = head.match(/^# egpt-0002:unregister (.+)$/))) {
      if (!store.delete(m[1])) throw new Error(`No MSFT_ScheduledTask objects found with property 'TaskName' equal to '${m[1]}'`);
      return '';
    }
    throw new Error(`unexpected script: ${head}`);
  };
  return { store, calls, ps };
}

const ctxWith = (sched, over = {}) => ({ platform: 'win32', egptHome: 'C:\\Users\\an\\.egpt', log: () => {}, ps: sched.ps, ...over });
const LIVE = () => ({ 'egpt-session1-daemon': { xml: taskXml('egpt-session1-daemon'), dacl: DACL, state: 4 } });

describe('0002 plans the rename on kg and do (both still carry egpt-session1-daemon, running)', () => {
  it('derives both names from the profile folder, like register-session1-daemon-task.ps1', () => {
    expect(probeScript('egpt-session1-daemon', 'egpt-daemon')).toContain("from = 'egpt-session1-daemon'; to = 'egpt-daemon'");
  });

  it('plans: only <URI> changes, verify, then unregister - and says the running instance is left alone', async () => {
    const sched = fakeScheduler(LIVE());
    const p = await plan(ctxWith(sched));
    expect(p.satisfied).toBe(false);
    expect(p.changes.slice(0, 3)).toEqual([
      "register scheduled task egpt-daemon from egpt-session1-daemon's own exported XML, with only <URI> changed:",
      '  - <URI>\\egpt-session1-daemon</URI>',
      '  + <URI>\\egpt-daemon</URI>',
    ]);
    expect(p.changes.join('\n')).toContain('egpt-session1-daemon is RUNNING: that session 1 daemon is left running - not stopped, and egpt-daemon is not started');
    expect(sched.calls).toEqual(['# egpt-0002:probe']);
  });

  it('a second profile folder derives its own names', async () => {
    const sched = fakeScheduler({ 'egpt-secondary-session1-daemon': { xml: taskXml('egpt-secondary-session1-daemon'), dacl: DACL, state: 3 } });
    const p = await plan(ctxWith(sched, { egptHome: 'C:\\Users\\an\\.egpt-secondary' }));
    expect(p.changes[0]).toContain('register scheduled task egpt-secondary-daemon');
  });
});

describe('0002 apply - lossless or nothing', () => {
  it('registers from the XML with only <URI> changed, verifies, THEN unregisters the old task', async () => {
    const sched = fakeScheduler(LIVE());
    const ctx = ctxWith(sched);
    await (await plan(ctx)).apply();
    expect(sched.calls).toEqual([
      '# egpt-0002:probe',
      '# egpt-0002:probe',
      '# egpt-0002:register egpt-daemon',
      '# egpt-0002:probe',
      '# egpt-0002:unregister egpt-session1-daemon',
    ]);
    expect([...sched.store.keys()]).toEqual(['egpt-daemon']);
    const newXml = sched.store.get('egpt-daemon').xml;
    expect(newXml).toBe(taskXml('egpt-session1-daemon').replace('<URI>\\egpt-session1-daemon</URI>', '<URI>\\egpt-daemon</URI>'));
    // Action, arguments, trigger, principal and settings all came from the export, untouched.
    expect(newXml.split('\r\n').filter((l) => !l.includes('<URI>'))).toEqual(taskXml('x').split('\r\n').filter((l) => !l.includes('<URI>')));
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('the export differs after registering: the NEW task is removed, the old one kept, refused naming the line', async () => {
    const sched = fakeScheduler(LIVE(), {
      onRegister: (name, xml) => ({ xml: xml.replace('  <RegistrationInfo>', '  <RegistrationInfo>\r\n    <Date>2026-09-16T10:00:00</Date>'), dacl: DACL, state: 3 }),
    });
    const p = await plan(ctxWith(sched));
    await expect(p.apply()).rejects.toThrow(/0002 refuses: the rename is not lossless on this node: egpt-daemon's exported XML differs from the source - line 4: expected "    <URI>\\\\egpt-daemon<\/URI>", got "    <Date>2026-09-16T10:00:00<\/Date>"\. egpt-session1-daemon is still registered and unchanged\./);
    expect([...sched.store.keys()]).toEqual(['egpt-session1-daemon']);
    expect(sched.store.get('egpt-session1-daemon').xml).toBe(taskXml('egpt-session1-daemon'));
    expect(sched.calls).toContain('# egpt-0002:unregister egpt-daemon');
    expect(sched.calls).not.toContain('# egpt-0002:unregister egpt-session1-daemon');
  });

  it('the DACL differs after registering (e.g. a different owner): same rollback', async () => {
    const sched = fakeScheduler(LIVE(), { onRegister: (name, xml) => ({ xml, dacl: DACL.replace(`(A;ID;FA;;;${SID})`, '(A;ID;FA;;;BA)'), state: 3 }) });
    await expect((await plan(ctxWith(sched))).apply()).rejects.toThrow(/egpt-daemon's DACL is .*, egpt-session1-daemon's is/);
    expect([...sched.store.keys()]).toEqual(['egpt-session1-daemon']);
  });

  it('Register-ScheduledTask itself fails: nothing is removed', async () => {
    const sched = fakeScheduler(LIVE(), { onRegister: () => { throw new Error('Access is denied.'); } });
    await expect((await plan(ctxWith(sched))).apply()).rejects.toThrow('Access is denied.');
    expect([...sched.store.keys()]).toEqual(['egpt-session1-daemon']);
  });

  it('the old task changed between plan and apply: refused before anything is registered', async () => {
    const sched = fakeScheduler(LIVE());
    const p = await plan(ctxWith(sched));
    sched.store.get('egpt-session1-daemon').xml = sched.store.get('egpt-session1-daemon').xml.replace('<Count>99</Count>', '<Count>3</Count>');
    await expect(p.apply()).rejects.toThrow(/egpt-session1-daemon changed since it was planned/);
    expect(sched.calls.some((c) => c.includes('register'))).toBe(false);
  });
});

describe('0002 idempotency and refusals', () => {
  it('already egpt-daemon: satisfied, nothing registered', async () => {
    const sched = fakeScheduler({ 'egpt-daemon': { xml: taskXml('egpt-daemon'), dacl: DACL, state: 4 } });
    const p = await plan(ctxWith(sched));
    expect(p).toEqual({ satisfied: true, notes: ['scheduled task egpt-daemon is registered'] });
  });

  it('no session 1 task at all: satisfied - a session 0 only node is a valid node', async () => {
    expect((await plan(ctxWith(fakeScheduler({})))).satisfied).toBe(true);
  });

  it('off Windows: satisfied without asking PowerShell', async () => {
    const sched = fakeScheduler(LIVE());
    expect((await plan(ctxWith(sched, { platform: 'darwin' }))).satisfied).toBe(true);
    expect(sched.calls).toEqual([]);
  });

  it('BOTH names registered: refused - two logon tasks are two session 1 daemons', async () => {
    const sched = fakeScheduler({ ...LIVE(), 'egpt-daemon': { xml: taskXml('egpt-daemon'), dacl: DACL, state: 3 } });
    await expect(plan(ctxWith(sched))).rejects.toThrow(/BOTH egpt-session1-daemon and egpt-daemon are registered/);
  });

  it('a task of that name that is not the session 1 daemon: refused', async () => {
    const sched = fakeScheduler({ 'egpt-session1-daemon': { xml: taskXml('egpt-session1-daemon').replace('session1-daemon-launcher.vbs', 'something-else.vbs'), dacl: DACL, state: 3 } });
    await expect(plan(ctxWith(sched))).rejects.toThrow(/does not run setup\\session1-daemon-launcher\.vbs/);
  });

  it('an export with no <URI> naming it: refused, since the one element to change is not there', async () => {
    const sched = fakeScheduler({ 'egpt-session1-daemon': { xml: taskXml('egpt-session1-daemon').replace('    <URI>\\egpt-session1-daemon</URI>\r\n', ''), dacl: DACL, state: 3 } });
    await expect(plan(ctxWith(sched))).rejects.toThrow(/does not carry exactly one <URI>\\egpt-session1-daemon<\/URI>/);
  });
});

describe('0002 PowerShell scripts', () => {
  it('register has no -Force (an existing egpt-daemon is refused, not overwritten) and carries the XML exactly', () => {
    const xml = taskXml('egpt-daemon');
    const s = registerScript('egpt-daemon', xml);
    expect(s).toContain("Register-ScheduledTask -Xml $xml -TaskName 'egpt-daemon' -TaskPath '\\' -ErrorAction Stop");
    expect(s).not.toMatch(/-Force/);
    expect(Buffer.from(s.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8')).toBe(xml);
  });

  it('unregister is -ErrorAction Stop, so a failed removal cannot read as success', () => {
    expect(unregisterScript('egpt-session1-daemon')).toContain("Unregister-ScheduledTask -TaskName 'egpt-session1-daemon' -TaskPath '\\' -Confirm:$false -ErrorAction Stop");
  });

  it('the probe reads the exported XML, the state and the DACL - and never stops or starts a task', () => {
    const s = probeScript('a', 'b');
    expect(s).toContain('Export-ScheduledTask');
    expect(s).toContain('GetSecurityDescriptor(4)');
    for (const s2 of [s, registerScript('a', '<x/>'), unregisterScript('a')]) {
      expect(s2).not.toMatch(/Stop-ScheduledTask|Start-ScheduledTask|\.Run\(/);
    }
  });
});
