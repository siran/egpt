// tests/migrations-0043-daemon-task-is-the-only-runner.test.mjs — migrations/0043.
//
// Fixture: the egpt-daemon task as 0005 left it on kg and do - its Description the session 0 era
// line. Task Scheduler is a fake dispatched on the 0005 probe/update scripts 0043 reuses.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, elevated } from '../migrations/0043-the-daemon-task-is-the-only-runner.mjs';
import { sessionZeroDescription } from '../migrations/0005-daemon-task-has-description.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const SID = { kg: 'S-1-5-21-1000000001-1000000002-1000000003-1001', do: 'S-1-5-21-1000000004-1000000005-1000000006-1001' };
const daclOf = (node) => `D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;${SID[node]})(A;;FR;;;${SID[node]})`;
const S0_ERA = 'eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon. Disable it and the spine stays in session 0 (the egpt-daemon service), where any browser it starts is invisible.';
const TARGET = 'eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon - the only eGPT runner on this node. Disable it and the node stays silent.';

const taskXml = ({ node = 'kg', description = S0_ERA } = {}) => [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <RegistrationInfo>',
  ...(description === null ? [] : [`    <Description>${description}</Description>`]),
  '    <URI>\\egpt-daemon</URI>',
  '  </RegistrationInfo>',
  '  <Principals>',
  '    <Principal id="Author">',
  `      <UserId>${SID[node]}</UserId>`,
  '      <LogonType>InteractiveToken</LogonType>',
  '    </Principal>',
  '  </Principals>',
  '  <Triggers>',
  '    <LogonTrigger />',
  '  </Triggers>',
  '  <Actions Context="Author">',
  '    <Exec>',
  '      <Command>C:\\WINDOWS\\System32\\wscript.exe</Command>',
  '      <Arguments>"C:\\Users\\user\\bin\\egpt\\setup\\session1-daemon-launcher.vbs" "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\bin\\egpt" "C:\\Users\\user\\.egpt" "C:\\Users\\user\\.egpt\\config\\logs\\session1-daemon.log"</Arguments>',
  '    </Exec>',
  '  </Actions>',
  '</Task>',
].join('\r\n');

function fakeScheduler(tasks, { onUpdate = (name, xml, prev) => ({ ...prev, xml }) } = {}) {
  const store = new Map(Object.entries(tasks));
  const calls = [];
  const ps = (script) => {
    const head = script.split('\n')[0];
    calls.push(head);
    if (head === '# egpt-0005:probe') {
      const name = script.match(/^\$name = '([^']+)'$/m)[1];
      return JSON.stringify(store.has(name) ? { target: TARGET, exists: true, ...store.get(name) } : { target: TARGET, exists: false });
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

const ctxWith = (sched, over = {}) => ({ platform: 'win32', egptHome: 'C:\\Users\\user\\.egpt', repo: 'C:\\Users\\user\\bin\\egpt', log: () => {}, ps: sched.ps, ...over });
const LIVE = (node, state = 4, description = S0_ERA) => ({ 'egpt-daemon': { xml: taskXml({ node, description }), dacl: daclOf(node), state } });

describe('0043 - the task Description stops pointing at the retired session 0 service', () => {
  it('the session 0 era line is the one 0005 stamped on both nodes', () => {
    expect(sessionZeroDescription('egpt-daemon')).toBe(S0_ERA);
  });

  for (const node of ['kg', 'do']) {
    it(`${node}: REPRODUCE - the task still says the spine falls back to session 0; plans the swap`, async () => {
      const sched = fakeScheduler(LIVE(node));
      const p = await plan(ctxWith(sched));
      expect(p.satisfied).toBe(false);
      expect(p.changes.slice(0, 3)).toEqual([
        're-register scheduled task egpt-daemon from its own exported XML, with its Description replaced:',
        `  - ${S0_ERA}`,
        `  + ${TARGET}`,
      ]);
      expect(sched.calls).toEqual(['# egpt-0005:probe']);
    });

    it(`${node}: apply changes exactly that line, keeps the DACL, and the re-plan is satisfied`, async () => {
      const sched = fakeScheduler(LIVE(node));
      const ctx = ctxWith(sched);
      await (await plan(ctx)).apply();
      expect(sched.calls).toEqual(['# egpt-0005:probe', '# egpt-0005:probe', '# egpt-0005:update egpt-daemon', '# egpt-0005:probe']);
      const after = sched.store.get('egpt-daemon');
      expect(after.xml).toBe(taskXml({ node, description: TARGET }));
      expect(after.dacl).toBe(daclOf(node));
      expect((await plan(ctx)).satisfied).toBe(true);
    });
  }

  it('a RUNNING instance is left running', async () => {
    const sched = fakeScheduler(LIVE('kg', 4));
    const p = await plan(ctxWith(sched));
    expect(p.changes.at(-1)).toMatch(/egpt-daemon is RUNNING: that instance is left running/);
    await p.apply();
    expect(sched.store.get('egpt-daemon').state).toBe(4);
  });

  it('not lossless: the original export is put back, and 0043 refuses', async () => {
    const sched = fakeScheduler(LIVE('do'), { onUpdate: (name, xml, prev) => ({ ...prev, xml: xml.includes(TARGET) ? xml.replace('<LogonTrigger />', '<LogonTrigger/>') : xml }) });
    await expect((await plan(ctxWith(sched))).apply()).rejects.toThrow(/^0043 refuses: the Description change is not lossless on this node: .* egpt-daemon was re-registered from its original export/);
    expect(sched.store.get('egpt-daemon').xml).toBe(taskXml({ node: 'do' }));
  });
});

describe('0043 idempotency and refusals', () => {
  it('already the current line (a freshly registered task): satisfied, nothing registered', async () => {
    const sched = fakeScheduler(LIVE('kg', 4, TARGET));
    expect(await plan(ctxWith(sched))).toEqual({ satisfied: true, notes: [`egpt-daemon: "${TARGET}"`] });
    expect(sched.calls).toEqual(['# egpt-0005:probe']);
  });

  it('no task, or not Windows: satisfied', async () => {
    expect((await plan(ctxWith(fakeScheduler({})))).satisfied).toBe(true);
    const sched = fakeScheduler(LIVE('kg'));
    expect((await plan(ctxWith(sched, { platform: 'linux' }))).satisfied).toBe(true);
    expect(sched.calls).toEqual([]);
  });

  it('no Description at all: satisfied - nothing points at session 0', async () => {
    const p = await plan(ctxWith(fakeScheduler(LIVE('kg', 3, null))));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toMatch(/no Description/);
  });

  it('some OTHER Description: refused, not overwritten', async () => {
    await expect(plan(ctxWith(fakeScheduler(LIVE('kg', 3, 'set by hand'))))).rejects.toThrow('0043 refuses: egpt-daemon carries a Description that is neither this one nor the session 0 era one ("set by hand") - replacing it is a human decision');
  });

  it('needs no elevation: the task is the operator\'s own (default DACL, as measured for 0005)', () => {
    expect(elevated).toBe(false);
  });
});

describe('0043 through the runner', () => {
  it('a node that has run everything up to 0042: applied and recorded', async () => {
    const h = join(mkdtempSync(join(tmpdir(), 'egpt-0043-')), '.egpt');
    mkdirSync(join(h, 'state'), { recursive: true });
    mkdirSync(join(h, 'config'), { recursive: true });
    writeFileSync(join(h, 'config', 'config.yaml'), 'node_name: zz\npeer_nodes: [zz, kg]\n');   // a peer node: the runner is for those only
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0043');
    writeFileSync(join(h, 'state', 'migrations-applied.json'), JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-16T00:00:00Z' }]))));
    const sched = fakeScheduler(LIVE('kg'));
    const { exitCode, results } = await runMigrations({ through: '0043', egptHome: h, elevated: false, platform: 'win32', ctx: { ps: sched.ps, repo: 'C:\\Users\\user\\bin\\egpt' }, log: () => {} });
    expect(exitCode).toBe(0);
    expect(results.filter((r) => r.outcome !== 'in-ledger').map((r) => [r.id, r.outcome])).toEqual([['0043-the-daemon-task-is-the-only-runner', 'applied']]);
    expect(JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0043-the-daemon-task-is-the-only-runner'].outcome).toBe('applied');
    expect(sched.store.get('egpt-daemon').xml).toBe(taskXml({ description: TARGET }));
  });
});
