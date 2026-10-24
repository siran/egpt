// agents-public-list.test.mjs — a non-operator's bare `/agents` (operator 2026-10-16; admitted only
// where public_commands lists agents since 2026-10-19 — run() is called directly below): this node's
// local beings that read this chat, how to call them, their reply mode in plain words, and whether THIS sender can call
// them. Safe fields only. The operator's bare /agents is unchanged; every verb stays operator-only.
// Throttled per chat; hammering it inside the window bans through the media-flood ban.
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-agents-public-list-home`;
});

import { createCommands, AGENTS_USAGE } from '../src/spine/commands.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createFloodBan } from '../src/flood-ban.mjs';
import { ensureContact, recordThread, patchBeing, getBeing } from '../src/conversations-state.mjs';

const GROUP = '!grpC';
const DM = '!dmStranger';
const MEMBER = '@whatsapp_lid-777000:beeper.local';
const OPERATOR = '@an:beeper.com';
const AGENTS = {
  e: { name: 'E', body_emoji: '🐶', handles: ['e', 'egpt'], voice_handles: ['perro'], default: true, configuration: 'egpt' },
  wren: { name: 'Wren', body_emoji: '🐦', handles: ['wren'], mode: 'mention-direct', conversation_defaults: { allowed_users: [OPERATOR] } },
  don: { relay_channel: 'mesh-room', handles: ['don'] },
  mk: { name: 'Mark', body_emoji: '📣', public: true, handles: ['mk'] },
};
const config = (extra = {}) => ({ networks: { whatsapp: { chat_ids: ['!self'], allowed_users: [OPERATOR] } }, agents: AGENTS, ...extra });

let seq = 0;
const msg = (body, over = {}) => ({
  surface: 'whatsapp', node: 'wa', chatId: GROUP, chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' },
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
  senderId: MEMBER, senderName: 'Emely', msgId: `m-${++seq}`, isSender: false, authorized: false, body, ...over,
});
const op = (body, over = {}) => msg(body, { senderId: OPERATOR, senderName: 'An', authorized: true, ...over });

// C: E (with a thread), Wren (restricted to the operator), a stray relay record and a public being.
function seed() {
  let st = ensureContact({ contacts: {} }, 'whatsapp', GROUP, { pushedName: 'C' }).state;
  st = recordThread(st, 'whatsapp', GROUP, 'thread-e', '2026-10-16T00:00:00Z', 'e');
  st = recordThread(st, 'whatsapp', GROUP, 'thread-w', '2026-10-16T00:00:00Z', 'wren');
  st = patchBeing(st, 'whatsapp', GROUP, 'don', { mode: 'on' });
  st = patchBeing(st, 'whatsapp', GROUP, 'mk', { mode: 'on' });
  return st;
}

function harness({ cfg = config(), st = seed(), floodBan = null, clock = { t: 1_000_000 } } = {}) {
  const state = { st };
  const sent = [];
  const audits = [];
  const cmds = createCommands({
    getConfig: () => cfg, send: async (chatId, text) => sent.push({ chatId, text }), exit: () => {},
    loadState: async () => state.st, writeState: async (s) => { state.st = s; },
    logTranscript: async () => true, defaultKey: 'e', now: () => clock.t, floodBan,
    logToGroup: async (line) => { audits.push(line); return true; },
  });
  return { cmds, sent, audits, state, clock };
}

const LIST_C = [
  'Agents in this chat:',
  '🐶 E — call: @e, @egpt (or start a message with "e") · voice: "perro" · answers only when called · you can call it: yes',
  '🐦 Wren — call: @wren (or start a message with "wren") · answers only when called at the start of a message · you can call it: no',
].join('\n');

describe('bare /agents from a non-operator: the public list', () => {
  it('is admitted at the command gate only where public_commands lists agents (operator 2026-10-19)', async () => {
    const closed = harness();
    expect(await closed.cmds.isCommand(closed.cmds.commandOf(msg('/e agents')))).toBe(false);
    const { cmds } = harness({ cfg: config({ public_commands: ['agents'] }) });
    const cmd = (ev) => cmds.commandOf(ev) ?? ev;   // as the spine reads a line
    expect(await cmds.isCommand(cmd(msg('/e agents')))).toBe(true);
    expect(await cmds.isCommand(cmd(msg('  /E AGENTS  ')))).toBe(true);
  });

  it('even where agents is public, every verb, a handle, a slug and force all are still refused', async () => {
    const { cmds } = harness({ cfg: config({ public_commands: ['agents'] }) });
    const cmd = (ev) => cmds.commandOf(ev) ?? ev;
    for (const body of ['/e agents e', '/e agents rethread e', '/e agents reset e', '/e agents compact e', '/e agents stop e', '/e agents refresh e',
      '/e agents mode on e', '/e agents access_level all e', '/e agents force all', '/e agents=c', '/e agents=c e', '/e agent',
      '/e agents compact', '/agents']) {
      expect(await cmds.isCommand(cmd(msg(body))), body).toBe(false);
    }
  });

  it('lists the local beings with exactly the safe fields; relays and public beings are left out', async () => {
    const { cmds, sent } = harness();
    await cmds.run(msg('/agents'));
    expect(sent).toEqual([{ chatId: GROUP, text: LIST_C }]);
    for (const leak of ['access_level', 'sandbox', 'thread', 'tok', 'allowed', 'egpt-', OPERATOR, 'conversations', 'Mark', 'don', 'configuration']) {
      expect(sent[0].text, leak).not.toContain(leak);
    }
  });

  it('"you can call it" follows allowed_users: the conversation tier wins over conversation_defaults', async () => {
    let st = patchBeing(seed(), 'whatsapp', GROUP, 'wren', { allowed_users: [MEMBER] });
    st = patchBeing(st, 'whatsapp', GROUP, 'e', { allowed_users: [] });
    const { cmds, sent } = harness({ st });
    await cmds.run(msg('/agents'));
    const lines = sent[0].text.split('\n');
    expect(lines[1]).toMatch(/^🐶 E — .* · you can call it: no$/);
    expect(lines[2]).toMatch(/^🐦 Wren — .* · you can call it: yes$/);
  });

  it('per-chat handles: where this chat\'s entry sets E\'s handles, the list tells that list (operator 2026-10-24)', async () => {
    const { cmds, sent } = harness({ st: patchBeing(seed(), 'whatsapp', GROUP, 'e', { handles: ['ekg'] }) });
    await cmds.run(msg('/agents'));
    expect(sent[0].text.split('\n')[1]).toBe('🐶 E — call: @ekg (or start a message with "ekg") · voice: "perro" · answers only when called · you can call it: yes');
    expect(sent[0].text.split('\n')[2]).toBe(LIST_C.split('\n')[2]);   // Wren keeps its node-wide handles
  });

  it('a mode change shows up (the operator\'s /agents mode, then the member asks again)', async () => {
    const { cmds, sent, clock } = harness();
    await cmds.run(op('/agents mode on e'));
    await cmds.run(op('/agents mode mute wren'));
    sent.length = 0;
    await cmds.run(msg('/agents'));
    expect(sent[0].text).toContain('🐶 E — call: @e, @egpt (or start a message with "e") · voice: "perro" · answers everything · you can call it: yes');
    expect(sent[0].text).toContain('· only logs the chat, never answers · you can call it: no');
    await cmds.run(op('/agents mode mute e'));
    clock.t += 60_001;
    sent.length = 0;
    await cmds.run(msg('/agents'));
    expect(sent[0].text).toContain('🐶 E — call: @e, @egpt (or start a message with "e") · voice: "perro" · only logs the chat, never answers · you can call it: no');   // mute: nobody wakes it
    await cmds.run(op('/agents mode off wren'));
    clock.t += 60_001;
    sent.length = 0;
    await cmds.run(msg('/agents'));
    expect(sent[0].text.split('\n')).toHaveLength(2);           // an 'off' being neither reads nor answers here
    expect(sent[0].text).not.toContain('Wren');
  });

  it('a fresh chat (no entry, nobody has spoken) lists E plus the other local beings', async () => {
    const { cmds, sent } = harness({ st: { contacts: {} } });
    await cmds.run(msg('/agents', { chatId: '!fresh', chatName: 'F' }));
    expect(sent).toEqual([{ chatId: '!fresh', text: LIST_C }]);
  });

  it('a being whose mode is off in this chat is omitted; every being off → silent', async () => {
    const one = harness({ st: patchBeing(seed(), 'whatsapp', GROUP, 'wren', { mode: 'off' }) });
    await one.cmds.run(msg('/agents'));
    expect(one.sent[0].text.split('\n')).toEqual(LIST_C.split('\n').slice(0, 2));
    const all = harness({ st: patchBeing(patchBeing(seed(), 'whatsapp', GROUP, 'wren', { mode: 'off' }), 'whatsapp', GROUP, 'e', { mode: 'off' }) });
    await all.cmds.run(msg('/agents'));
    expect(all.sent).toEqual([]);
  });

  it('a stranger in a 1:1 reaches only that conversation\'s own agent; a public own agent keeps the chat silent', async () => {
    let st = ensureContact({ contacts: {} }, 'whatsapp', DM, { pushedName: 'S' }).state;
    st = patchBeing(st, 'whatsapp', DM, 'wren', { default: true, allowed_users: ['*'] });
    st = recordThread(st, 'whatsapp', DM, 'thread-e2', '2026-10-16T00:00:00Z', 'e');
    const stranger = (body) => msg(body, { chatId: DM, chatName: 'S', raw: { chatType: 'private' }, senderId: '@whatsapp_lid-999:beeper.local' });
    const a = harness({ st });
    await a.cmds.run(stranger('/agents'));
    expect(a.sent[0].text).toMatch(/🐶 E — .* · you can call it: no/);
    expect(a.sent[0].text).toMatch(/🐦 Wren — .* · you can call it: yes/);

    const pub = patchBeing(patchBeing(st, 'whatsapp', DM, 'wren', { default: false }), 'whatsapp', DM, 'mk', { default: true });
    const b = harness({ st: pub });
    await b.cmds.run(stranger('/agents'));
    expect(b.sent).toEqual([]);
  });

  it('through the real spine: the member gets the list, no being turn runs, no state changes', async () => {
    const state = { st: seed() };
    const replies = [];
    const real = createCommands({
      getConfig: () => config({ public_commands: ['agents'] }), send: async (c, t) => replies.push(t), exit: () => {},
      loadState: async () => state.st, writeState: async (s) => { state.st = s; }, logTranscript: async () => true, defaultKey: 'e',
    });
    const brain = { calls: [], async turn(being) { this.calls.push(being); return { text: 'ok', sessionId: 'thread-e', being }; }, async accessLevel() { return 'regular'; } };
    const spine = createSpine({
      bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
      brain, commands: real,
      heartbeats: { runDue() {} },
      identity: { build: (m) => ({ ...m }) },
      router: createRouter({ getAgents: () => AGENTS, defaultBeing: 'e' }),
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
      sender: { open() { return { update() {}, activate() {}, fail() {}, async finish() {} }; } },
      transcript: { async log() {} },
      defaultBeing: 'e',
      clock: { now: () => 1 },
    });
    const before = state.st;
    await spine.handleInbound(msg('/e agents'));
    expect(replies).toEqual([LIST_C]);
    expect(brain.calls).toEqual([]);
    expect(state.st).toBe(before);
    expect(getBeing(state.st, 'whatsapp', GROUP, 'e')).toMatchObject({ threadId: 'thread-e' });
  });
});

describe('the operator\'s bare /agents is unchanged', () => {
  it('is AGENTS_USAGE, byte-identical, never throttled, never banned', async () => {
    const floodBan = createFloodBan({ now: () => 0 });
    const ban = vi.spyOn(floodBan, 'ban');
    const { cmds, sent } = harness({ floodBan });
    for (let i = 0; i < 12; i++) await cmds.run(op('/agents'));
    await cmds.run(op('/agents', { chatId: '!self', authorized: false }));   // Self DM
    expect(sent.map((s) => s.text)).toEqual(Array(13).fill(AGENTS_USAGE));
    expect(ban).not.toHaveBeenCalled();
  });
});

describe('throttle: one public reply per chat per window (agents_list.every_ms)', () => {
  it('a second call inside the window gets nothing and is not audited; one after the window gets the list', async () => {
    const { cmds, sent, audits, clock } = harness();
    await cmds.run(msg('/agents'));
    clock.t += 59_000;
    await cmds.run(msg('/agents', { senderId: '@whatsapp_lid-778:beeper.local', senderName: 'Other' }));   // per chat, any sender
    await cmds.run(msg('/agents'));
    expect(sent).toHaveLength(1);
    expect(audits).toEqual(['/agents in C by Emely']);
    clock.t += 1_001;
    await cmds.run(msg('/agents'));
    expect(sent.map((s) => s.text)).toEqual([LIST_C, LIST_C]);
  });

  it('the window is per chat and configurable', async () => {
    let st = seed();
    st = ensureContact(st, 'whatsapp', '!grpD', { pushedName: 'D' }).state;
    st = recordThread(st, 'whatsapp', '!grpD', 'thread-d', '2026-10-16T00:00:00Z', 'e');
    const { cmds, sent, clock } = harness({ cfg: config({ agents_list: { every_ms: 5_000 } }), st });
    await cmds.run(msg('/agents'));
    await cmds.run(msg('/agents', { chatId: '!grpD', chatName: 'D' }));
    expect(sent.map((s) => s.chatId)).toEqual([GROUP, '!grpD']);
    clock.t += 5_000;
    await cmds.run(msg('/agents'));
    expect(sent).toHaveLength(3);
  });
});

describe('/agents flood: ignored calls ban through the media-flood ban', () => {
  const setup = (cfg) => {
    const notices = [];
    const clock = { t: 1_000_000 };
    const floodBan = createFloodBan({ cooldownMs: 600_000, now: () => clock.t, onLog: (m) => notices.push(m) });
    return { ...harness({ floodBan, cfg, clock }), floodBan, notices };
  };

  it('5 ignored calls within 10 minutes ban the sender (same mute, /bans lists it, /unban lifts it)', async () => {
    const { cmds, sent, audits, clock, floodBan, notices } = setup();
    await cmds.run(msg('/agents'));
    for (let i = 0; i < 5; i++) { clock.t += 1_000; await cmds.run(msg('/agents')); }
    expect(sent).toHaveLength(1);
    expect(floodBan.isBanned('whatsapp', GROUP, MEMBER)).toBe(true);
    expect(notices).toEqual(['flood-ban: Emely in C — /agents flood, muted 10m']);
    expect(audits).toEqual(['/agents in C by Emely', '/agents in C by Emely → banned — /agents flood']);
    await cmds.run(op('/bans'));
    expect(sent[1].text).toMatch(/^1 active flood ban:\nEmely in C \(\/agents flood\) — \d+m left$/);   // /bans reads the wall clock
    await cmds.run(op('/unban Emely'));
    expect(floodBan.isBanned('whatsapp', GROUP, MEMBER)).toBe(false);
  });

  it('below the threshold nothing happens; ignored calls older than the ban window do not count', async () => {
    const { cmds, clock, floodBan } = setup();
    await cmds.run(msg('/agents'));
    for (let i = 0; i < 4; i++) { clock.t += 1_000; await cmds.run(msg('/agents')); }
    expect(floodBan.isBanned('whatsapp', GROUP, MEMBER)).toBe(false);
    clock.t += 600_000;                                       // the 4 age out of the 10-minute window
    await cmds.run(msg('/agents'));                           // accepted (new throttle window)
    clock.t += 1_000; await cmds.run(msg('/agents'));         // 1 ignored in the window
    expect(floodBan.isBanned('whatsapp', GROUP, MEMBER)).toBe(false);
  });

  it('agents_list.ban_after / ban_window_ms are config; ban_after 0 never bans', async () => {
    const a = setup({ ...config(), agents_list: { ban_after: 2, ban_window_ms: 60_000 } });
    await a.cmds.run(msg('/agents'));
    for (let i = 0; i < 2; i++) { a.clock.t += 1_000; await a.cmds.run(msg('/agents')); }
    expect(a.floodBan.isBanned('whatsapp', GROUP, MEMBER)).toBe(true);

    const b = setup({ ...config(), agents_list: { ban_after: 0 } });
    await b.cmds.run(msg('/agents'));
    for (let i = 0; i < 20; i++) { b.clock.t += 1_000; await b.cmds.run(msg('/agents')); }
    expect(b.floodBan.isBanned('whatsapp', GROUP, MEMBER)).toBe(false);
  });
});
