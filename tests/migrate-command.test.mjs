// migrate-command.test.mjs — /<handle> migrate [approve|decline <id[,id]>] (operator 2026-11-21).
// The operator's yes or no to the migrations that change operator-owned config, without a shell. It is
// operator-only (the SAME gate every command uses) and shells out to the node's runner THROUGH the one
// child helper the upgrade uses (daemon-runtime.mjs runMigrationsChild), with --dry-run / --approve /
// --decline. The runner is faked at that seam: what is asserted is the flags it is called with and what
// the chat is told; setup/migrate.mjs itself is tested in migrate-runner.test.mjs.
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-migrate-command-home`;
});

import { createCommands } from '../src/spine/commands.mjs';
import { runMigrationsChild } from '../src/daemon-runtime.mjs';
import { COMMANDS } from '../src/interpreter.mjs';

const OPERATOR = '@an:beeper.com';
const cfg = { networks: { whatsapp: { chat_ids: ['!self'], allowed_users: [OPERATOR] } }, agents: { edu: {} } };
const msg = (body, over = {}) => ({ surface: 'whatsapp', node: 'wa', chatId: '!grp', chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' }, senderId: '@x:beeper.com', senderName: 'X', msgId: 'm1', isSender: false, authorized: false, body, ...over });
const op = (body, over = {}) => msg(body, { senderId: OPERATOR, authorized: true, ...over });

const LISTING = [
  'migrations: /repo/migrations',
  '  0006-djh-is-off  done (applied by operator, 2026-11-21T10:00:00.000Z)',
  '  0025-everyone-in-a-box  done (declined by operator, 2026-11-21T10:00:00.000Z)',
  '  0029-the-admin-channel-is-declared  PENDING APPROVAL - the admin channel is declared',
  '  0030-card  PENDING - a card text',
].join('\n');

function harness({ result = { exitCode: 0, out: '', pendingApproval: [] }, wired = true, config = cfg } = {}) {
  const sent = [], calls = [];
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: () => {},
    logTranscript: async () => true,
    ...(wired ? { migrate: async (args) => { calls.push(args); return typeof result === 'function' ? result(args) : result; } } : {}),
  });
  const run = async (ev) => { const e = cmds.commandOf(ev) ?? ev; return { gate: await cmds.isCommand(e), out: await cmds.run(e) }; };
  return { cmds, sent, calls, run };
}

describe('/<handle> migrate', () => {
  it('is operator-only: a stranger is not admitted at the command gate, and a direct run is refused without calling the runner', async () => {
    const h = harness();
    const gate = (ev) => h.cmds.isCommand(h.cmds.commandOf(ev));
    expect(await gate(msg('/edu migrate decline 0025'))).toBe(false);
    expect(await gate(op('/edu migrate decline 0025'))).toBe(true);
    await h.cmds.run(h.cmds.commandOf(msg('/edu migrate approve 0025')));
    expect(h.calls).toEqual([]);
    expect(h.sent.at(-1).text).toMatch(/migrate. is operator-only/);
  });

  it('even where public_commands lists it, a stranger still runs nothing', async () => {
    const h = harness({ config: { ...cfg, public_commands: ['migrate'] } });
    await h.cmds.run(h.cmds.commandOf(msg('/edu migrate decline 0025')));
    expect(h.calls).toEqual([]);
  });

  it('decline: calls the runner with --decline and the ids, and says what it recorded', async () => {
    const out = ['  0025-everyone-in-a-box  DECLINED by the operator - recorded, it will not be proposed again', '  0028-beings-are-kept-thin  DECLINED by the operator - recorded, it will not be proposed again', '  0029-x  DECLINED by the operator - recorded, it will not be proposed again'].join('\n');
    const h = harness({ result: { exitCode: 0, out, pendingApproval: [] } });
    await h.run(op('/edu migrate decline 0025,0028,0029'));
    expect(h.calls).toEqual([['--decline', '0025,0028,0029']]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain('0025-everyone-in-a-box  DECLINED');
    expect(h.sent[0].text).toContain('0029-x  DECLINED');
  });

  it('approve: calls the runner with --approve; ids may be spaced or comma-separated; names what is still pending approval', async () => {
    const out = '  0025-everyone-in-a-box  APPLIED - recorded';
    const h = harness({ result: { exitCode: 3, out, pendingApproval: [{ id: '0029', summary: 's' }] } });
    await h.run(op('/edu migrate approve 0025 0028'));
    expect(h.calls).toEqual([['--approve', '0025,0028']]);
    expect(h.sent[0].text).toBe('0025-everyone-in-a-box  APPLIED - recorded\nstill pending approval: 0029');
  });

  it('bare: runs the runner with --dry-run and lists pending approval, approved, declined and the rest', async () => {
    const h = harness({ result: { exitCode: 0, out: LISTING, pendingApproval: [{ id: '0029', summary: 'the admin channel is declared' }] } });
    await h.run(op('/edu migrate'));
    expect(h.calls).toEqual([['--dry-run']]);
    expect(h.sent[0].text).toBe([
      'migrations on this node:',
      'pending approval: 0029 (the admin channel is declared)',
      'approved: 0006',
      'declined: 0025',
      'pending, runs at the next upgrade: 0030',
    ].join('\n'));
  });

  it('a refusal from the runner (unknown id, a code-shape migration) reaches the chat, and nothing else is said', async () => {
    const h = harness({ result: { exitCode: 1, out: '', pendingApproval: [], reason: 'FAILED before any migration ran: --decline 0001: 0001-x is not an approval migration - it is a code-shape fix tied to the code, which runs by itself and cannot be declined' } });
    await h.run(op('/edu migrate decline 0001'));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toMatch(/cannot be declined/);
  });

  it('a malformed line never reaches the runner: usage instead', async () => {
    const h = harness();
    for (const line of ['/edu migrate decline', '/edu migrate approve --dry-run', '/edu migrate nuke 0025', '/edu migrate decline 25', '/edu migrate decline 0025;ls']) {
      await h.run(op(line));
    }
    expect(h.calls).toEqual([]);
    expect(h.sent).toHaveLength(5);
    for (const s of h.sent) expect(s.text).toMatch(/^usage: \/edu migrate/);
  });

  it('where migrations are not wired it says so', async () => {
    const h = harness({ wired: false });
    await h.run(op('/edu migrate'));
    expect(h.sent[0].text).toBe('migrations are not wired on this node');
  });

  it('has a /help entry marked wired (the drift guard in spine-commands.test.mjs holds it to the dispatch)', () => {
    expect(COMMANDS.find((e) => e.cmd === '/migrate')).toMatchObject({ wired: true, usage: '/<handle> migrate [approve|decline <id[,id]>]' });
  });
});

describe('runMigrationsChild — the one helper the upgrade and /migrate both go through', () => {
  const fake = (status, out) => { const calls = []; return { calls, spawnSync: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status, stdout: Buffer.from(out) }; } }; };

  it('passes the flags after --egpt-home and sets EGPT_HOME for the child', () => {
    const f = fake(0, '');
    runMigrationsChild({ root: '/r', egptHome: '/h', args: ['--decline', '0025'], spawnSync: f.spawnSync, execPath: 'node', env: {} });
    expect(f.calls[0].args.slice(1)).toEqual(['--egpt-home', '/h', '--decline', '0025']);
    expect(f.calls[0].opts.env.EGPT_HOME).toBe('/h');
  });

  it('reads PENDING APPROVAL items (number, summary) off the runner stdout; an early refusal is the reason', () => {
    const r = runMigrationsChild({ root: '/r', egptHome: '/h', spawnSync: fake(3, LISTING).spawnSync });
    expect(r.pendingApproval).toEqual([{ id: '0029', summary: 'the admin channel is declared' }]);
    const e = runMigrationsChild({ root: '/r', egptHome: '/h', spawnSync: fake(1, 'migrations: /x\nFAILED before any migration ran: --decline 0099: no such migration').spawnSync });
    expect(e.reason).toBe('FAILED before any migration ran: --decline 0099: no such migration');
  });
});
