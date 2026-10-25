// public-commands.test.mjs — who may run a command (operator 2026-10-19 ~14:20). The node's allowed
// users run any command; anyone else in the chat runs only what public_commands names: config.yaml's
// root list (DEFAULT split, send, end; join retired 2026-10-25), or the chat's own conversations.yaml list, which
// replaces it. `/<handle> <not a command>` is no command and addresses nobody. One real node (kg):
// real commands + real router + real spine, the chat in mention mode.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-public-commands-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync } from 'node:fs';
import { createSpine } from '../src/spine/spine.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';
import { ensureContact, recordThread } from '../src/conversations-state.mjs';

const GROUP = 'grpC';
const OTHER = 'grpD';
const RODZ_ID = '@whatsapp_lid-69433129173200:beeper.local';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const BASE = {
  node_name: 'kg', node_role: 'primary',
  networks: { whatsapp: { chat_ids: ['!self'] } },
  beeper: { primary: { phone: '+16468217865' }, secondary: { phone: '+13472576794' } },
  group_title: '{group}-{name}',
  agents: { egpt: { handles: ['e', 'egpt'], default: true } },
};

let seq = 0;
const member = (body, over = {}) => ({
  surface: 'whatsapp', chatId: GROUP, chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' },
  senderId: LULU, senderName: 'Lulu', msgId: `m-${++seq}`, isSender: false, authorized: false, body, ...over,
});
const operator = (body, over = {}) => member(body, { senderId: '@an:beeper.com', senderName: 'An', isSender: true, authorized: true, ...over });

// `config` is merged over BASE; `lists` sets public_commands on a chat's own conversations.yaml entry.
function node({ config = {}, lists = {} } = {}) {
  const cfg = { ...BASE, ...config };
  let st = { contacts: {} };
  for (const [chat, name] of [[GROUP, 'C'], [OTHER, 'D']]) {
    st = ensureContact(st, 'whatsapp', chat, { pushedName: name }).state;
    st = recordThread(st, 'whatsapp', chat, `${chat}-thread`, '2026-10-19T00:00:00Z', 'egpt');
  }
  for (const [chat, list] of Object.entries(lists)) st.contacts.whatsapp[chat].public_commands = list;
  const calls = { create: [], exit: [], sent: [], brain: [], ran: [] };
  const real = createCommands({
    getConfig: () => cfg, send: async (chatId, text) => { calls.sent.push(text); },
    exit: async (code) => { calls.exit.push(code); },
    loadState: async () => st, writeState: async (s) => { st = s; },
    defaultKey: 'egpt',
    forkBridge: {
      editMessage: async () => true,
      createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: `!side${calls.create.length}:beeper.local` }; },
      postReply: async () => ({ ok: true, confirmedId: Promise.resolve('op-1') }),
      archiveChat: async () => true,
      chatAccountId: async () => 'whatsapp',
      chatRaw: async () => null,
      chatTitle: async () => null,
      resolveUserIdByPhone: async (digits) => (digits === '13472576794' ? RODZ_ID : null),
      awaitMouthMessage: async () => null,
    },
  });
  const commands = { ...real, run: (e) => { calls.ran.push(e.body); return real.run(e); } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain: { async turn(being, ev) { calls.brain.push({ being, body: ev.body }); return { text: 'ok', sessionId: 't', being }; }, async accessLevel() { return 'regular'; } },
    commands, router: createRouter({ getAgents: () => cfg.agents, defaultBeing: 'egpt' }),
    heartbeats: { runDue() {} },
    identity: { build: (m) => ({ ...m }) },
    gating: {
      async decide(being, ev, mention) { return { mode: 'mention', receives: true, mayReply: !!(mention?.atEStart || mention?.atEAnywhere), sendToEgpt: 'mode' }; },
      surfaces: (d) => d.mayReply,
    },
    sender: { open() { return { update() {}, activate() {}, fail() {}, async finish() {} }; } },
    transcript: { async log() {} },
    defaultBeing: 'egpt', clock: { now: () => 1 }, turnTimeoutMs: 0,
  });
  const say = (ev) => spine.handleInbound({ ...ev, mention: { ...mentionStatus(ev.body, cfg.agents.egpt.handles), replyToBot: false } });
  return { cmds: real, calls, say };
}
// Admitted at the command gate, as the spine reads a line (commandOf, then isCommand).
const admitted = async (n, ev) => n.cmds.isCommand(n.cmds.commandOf(ev) ?? ev);

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

describe('/<handle> <not a command> is ordinary text that addresses nobody', () => {
  for (const who of [member, operator]) {
    it(`"/e hola" and "/e" from ${who === member ? 'a member' : 'the operator'}: no command, E not woken`, async () => {
      const n = node();
      await n.say(who('/e hola'));
      await n.say(who('/e'));
      expect(n.calls.ran).toEqual([]);
      expect(n.calls.brain).toEqual([]);
    });
  }

  it('lock: plain "e hola" still wakes E', async () => {
    const n = node();
    await n.say(member('e hola'));
    expect(n.calls.brain.map((b) => b.being)).toEqual(['egpt']);
  });
});

describe('the default public list: split, send, end', () => {
  it('a member\'s "/e split x" runs', async () => {
    const n = node();
    await n.say(member('/e split x'));
    expect(n.calls.ran).toEqual(['/split x']);
    expect(n.calls.create.map((c) => c.title)).toEqual(['SI+C-x']);
  });

  it('a member\'s retired "/e join x" is not public by default: no command, no reply, nothing made', async () => {
    const n = node();
    expect(await admitted(n, member('/e join x'))).toBe(false);
    await n.say(member('/e join x'));
    expect(n.calls.ran).toEqual([]);
    expect(n.calls.sent).toEqual([]);
    expect(n.calls.create).toEqual([]);
  });

  it('where public_commands still lists join, a member\'s "/e join x" answers with /split and makes nothing', async () => {
    const n = node({ config: { public_commands: ['join', 'split', 'send', 'end'] } });
    await n.say(member('/e join x'));
    expect(n.calls.ran).toEqual(['/join x']);
    expect(n.calls.create).toEqual([]);
    expect(n.calls.sent).toHaveLength(1);
    expect(n.calls.sent[0]).toContain('/e split x');
  });

  it('a member\'s "/e recap" and bare "/e agents" are refused: no command, nobody woken', async () => {
    const n = node();
    expect(await admitted(n, member('/e recap'))).toBe(false);
    expect(await admitted(n, member('/e agents'))).toBe(false);
    await n.say(member('/e recap'));
    await n.say(member('/e agents'));
    expect(n.calls.ran).toEqual([]);
    expect(n.calls.sent).toEqual([]);
    expect(n.calls.brain).toEqual([]);
  });

  // contract 7.4
  it('a member\'s "/e restart" is refused; the operator\'s runs', async () => {
    const n = node();
    await n.say(member('/e restart'));
    expect(n.calls.exit).toEqual([]);
    expect(n.calls.ran).toEqual([]);
    expect(n.calls.brain).toEqual([]);
    await n.say(operator('/e restart'));
    expect(n.calls.exit).toEqual([43]);
  });
});

describe('config.yaml public_commands replaces the default', () => {
  it('[join, recap]: a member\'s "/e recap" runs, "/e split" is refused', async () => {
    const n = node({ config: { public_commands: ['join', 'recap'] } });
    await n.say(member('/e recap'));
    await n.say(member('/e split y'));
    expect(n.calls.ran).toEqual(['/recap']);
    expect(n.calls.create).toEqual([]);
  });

  it('an entry may carry its leading "/"', async () => {
    const n = node({ config: { public_commands: ['/recap'] } });
    expect(await admitted(n, member('/e recap'))).toBe(true);
    expect(await admitted(n, member('/e join x'))).toBe(false);
  });

  it('[]: nothing is public; the operator still runs everything', async () => {
    const n = node({ config: { public_commands: [] } });
    expect(await admitted(n, member('/e join x'))).toBe(false);
    expect(await admitted(n, operator('/e join x'))).toBe(true);
  });
});

describe('a chat\'s own public_commands replaces the global list there', () => {
  it('[] in C: a member\'s "/e split" is refused in C and still runs in D', async () => {
    const n = node({ lists: { [GROUP]: [] } });
    await n.say(member('/e split x'));
    expect(n.calls.ran).toEqual([]);
    expect(n.calls.create).toEqual([]);
    await n.say(member('/e split x', { chatId: OTHER, chatName: 'D' }));
    expect(n.calls.ran).toEqual(['/split x']);
  });

  it('[recap] in C over a global [join]: C runs recap, not join; D runs join, not recap', async () => {
    const n = node({ config: { public_commands: ['join'] }, lists: { [GROUP]: ['recap'] } });
    const inD = (body) => member(body, { chatId: OTHER, chatName: 'D' });
    expect(await admitted(n, member('/e recap'))).toBe(true);
    expect(await admitted(n, member('/e join x'))).toBe(false);
    expect(await admitted(n, inD('/e join x'))).toBe(true);
    expect(await admitted(n, inD('/e recap'))).toBe(false);
  });

  it('[agents] in C: a member\'s bare "/e agents" gets the public list; a verb is still refused', async () => {
    const n = node({ lists: { [GROUP]: ['agents'] } });
    await n.say(member('/e agents'));
    expect(n.calls.sent).toHaveLength(1);
    expect(n.calls.sent[0]).toMatch(/^Agents in this chat:/);
    expect(await admitted(n, member('/e agents rethread egpt'))).toBe(false);
    await n.say(member('/e agents rethread egpt'));
    expect(n.calls.ran).toEqual(['/agents']);
  });
});

describe('node-signed lines are never public', () => {
  it('a node-signed "/e join" never runs, even where join is listed', async () => {
    const n = node({ config: { public_commands: ['join', 'recap'] } });
    expect(await admitted(n, member('/e join x', { fromNode: 'do' }))).toBe(false);
    expect(await admitted(n, member('/e recap', { fromNode: 'do' }))).toBe(false);
    await n.say(member('/e join x', { fromNode: 'do' }));
    expect(n.calls.ran).toEqual([]);
    expect(n.calls.create).toEqual([]);
  });
});
