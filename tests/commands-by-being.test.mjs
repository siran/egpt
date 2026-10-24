// commands-by-being.test.mjs — a command names its being (operator 2026-10-19: "make the handle of an
// agent act itself a command … now we can know who executes the command"). `/<handle> <command>` runs
// on the node of the being the handle wakes; every other node records it and prompts nobody. A bare
// `/<command>` is no command anywhere (the console keeps it). Two real nodes on one shared chat:
// kg (E: e, egpt) and do (D: d, don), each a real spine + real commands + real router.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-commands-by-being-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSpine } from '../src/spine/spine.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { parseReplyActions } from '../src/spine/reply-actions.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';
import { ensureContact, recordThread, patchBeing } from '../src/conversations-state.mjs';

const GROUP = 'grpC';
const RODZ_ID = '@whatsapp_lid-69433129173200:beeper.local';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const BASE = {
  networks: { whatsapp: { chat_ids: ['!self'] } },
  beeper: { primary: { phone: '+16468217865' }, secondary: { phone: '+13472576794' } },
  group_title: '{group}-{name}', peer_nodes: ['kg', 'do'],
};
const NODES = {
  kg: { ...BASE, node_name: 'kg', node_role: 'primary', agents: { egpt: { handles: ['e', 'egpt'] } } },
  do: { ...BASE, node_name: 'do', node_role: 'secondary', agents: { egpt: { handles: ['d', 'don'] } } },
};
const ALIASES = join(HOME, 'config', 'commands_alias.yaml');
const writeAliases = (text) => { mkdirSync(join(HOME, 'config'), { recursive: true }); writeFileSync(ALIASES, text, 'utf8'); };

let seq = 0;
const member = (body, over = {}) => ({
  surface: 'whatsapp', chatId: GROUP, chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' },
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
  senderId: LULU, senderName: 'Lulu', msgId: `m-${++seq}`, isSender: false, authorized: false, body, ...over,
});
const operator = (body, over = {}) => member(body, { senderId: '@an:beeper.com', senderName: 'An', isSender: true, authorized: true, ...over });

// One node: its own state, bridge, commands and spine. `mode` is the being's reply mode ('on' answers
// every line; 'mention' only a line that addresses the being). `handlesHere`: this chat's entry sets E's
// handles (per-chat handles) — only then is the router handed the state.
function node(name, { mode = 'mention', handlesHere = null } = {}) {
  const config = { ...NODES[name], agents: { egpt: { ...NODES[name].agents.egpt, mode } } };
  let st = ensureContact({ contacts: {} }, 'whatsapp', GROUP, { pushedName: 'C' }).state;
  st = recordThread(st, 'whatsapp', GROUP, `${name}-thread`, '2026-10-19T00:00:00Z', 'egpt');
  if (handlesHere) st = patchBeing(st, 'whatsapp', GROUP, 'egpt', { handles: handlesHere });
  const calls = { create: [], exit: [], sent: [], logs: [], notes: [], transcript: [], brain: [], ran: [], stop: [] };
  const real = createCommands({
    getConfig: () => config, send: async (chatId, text) => { calls.sent.push(text); },
    exit: async (code) => { calls.exit.push(code); },
    loadState: async () => st, writeState: async (s) => { st = s; },
    commandAliasesPath: ALIASES,
    forkBridge: {
      editMessage: async () => true,
      createGroup: async (opts, o = {}) => { calls.create.push({ ...opts, via: o.via ?? null }); return { success: true, chatID: `!${name}-side${calls.create.length}:beeper.local` }; },
      postReply: async () => ({ ok: true, confirmedId: Promise.resolve('op-1') }),
      archiveChat: async () => true,
      chatAccountId: async () => 'whatsapp',
      chatRaw: async () => null,
      chatTitle: async () => null,
      resolveUserIdByPhone: async (digits) => (digits === '13472576794' ? RODZ_ID : null),
      awaitMouthMessage: async () => null,
    },
    onLog: (m) => calls.logs.push(m),
  });
  const commands = { ...real, run: (e) => { calls.ran.push(e.body); return real.run(e); } };
  const router = createRouter({ getAgents: () => config.agents, ...(handlesHere ? { loadState: async () => st } : {}) });
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain: { async turn(being, ev) { calls.brain.push({ being, body: ev.body }); return { text: 'ok', sessionId: `${name}-thread`, being }; }, async accessLevel() { return 'regular'; } },
    commands, router,
    heartbeats: { runDue() {} },
    identity: { build: (m) => ({ ...m }) },
    gating: {
      async decide(being, ev, mention) {
        const mayReply = mode === 'on' || !!(mention?.atEStart || mention?.atEAnywhere);
        return { mode, receives: true, mayReply };
      },
      surfaces: (d) => d.mayReply,
    },
    sender: { open() { return { update() {}, activate() {}, fail() {}, async finish() {} }; } },
    transcript: { async log(ev, reply) { if (reply == null) calls.transcript.push(ev.body); } },
    stopSwitch: { present: () => false, async pull(o) { calls.stop.push(o.reason); } },
    stopPhrase: () => 'EGPT STOP',
    clock: { now: () => 1 }, turnTimeoutMs: 0,
    onLog: (m) => calls.notes.push(m),
  });
  // The bridge's persona mention, as it computes it (mentionStatus over the persona's handles).
  const mention = (body) => ({ ...mentionStatus(body, config.agents.egpt.handles), replyToBot: false });
  return { name, cmds: real, router, calls, getState: () => st, say: (ev) => spine.handleInbound({ ...ev, mention: mention(ev.body) }) };
}
// Both nodes hear every message (the two shared Beeper accounts).
function pair(opts) {
  const kg = node('kg', opts), dolly = node('do', opts);
  return { kg, dolly, say: async (ev) => { await kg.say({ ...ev }); await dolly.say({ ...ev }); } };
}
const recordedOnly = (n, body) => {
  expect(n.calls.transcript, `${n.name} records it`).toContain(body);
  expect(n.calls.ran, `${n.name} runs no command`).toEqual([]);
  expect(n.calls.brain, `${n.name} prompts nobody`).toEqual([]);
  expect(n.calls.sent, `${n.name} says nothing`).toEqual([]);
};

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

describe('/<handle> <command>: the handle\'s node runs it, the other node ignores it', () => {
  it('/e join viaje: kg creates SI+C-viaje; dolly records the line and creates nothing', async () => {
    const { kg, dolly, say } = pair();
    await say(operator('/e join viaje'));
    expect(kg.calls.ran).toEqual(['/join viaje']);
    expect(kg.calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
    expect(dolly.calls.create).toEqual([]);
    recordedOnly(dolly, '/e join viaje');
  });

  it('/e join with no name: a random 5-character name (lowercase letters and digits)', async () => {
    const { kg, say } = pair();
    await say(operator('/e join'));
    await say(operator('/e join'));
    const titles = kg.calls.create.map((c) => c.title);
    expect(titles).toHaveLength(2);
    for (const t of titles) expect(t).toMatch(/^SI\+C-[a-z0-9]{5}$/);
    expect(titles[0]).not.toBe(titles[1]);
  });

  it('/e restart from the operator: kg exits 43 (the lifecycle path); dolly does nothing', async () => {
    const { kg, dolly, say } = pair();
    await say(operator('/e restart'));
    expect(kg.calls.exit).toEqual([43]);
    expect(dolly.calls.exit).toEqual([]);
    recordedOnly(dolly, '/e restart');
  });

  it('/e restart from a member is refused as before: no exit; ordinary text that addresses nobody', async () => {
    const { kg, dolly, say } = pair();
    await say(member('/e restart'));
    expect(kg.calls.exit).toEqual([]);
    expect(dolly.calls.exit).toEqual([]);
    expect(kg.calls.ran).toEqual([]);
    expect(kg.calls.brain).toEqual([]);
  });

  it('/don agents on dolly: dolly runs /agents; kg ignores it', async () => {
    const { kg, dolly, say } = pair();
    await say(operator('/don agents'));
    expect(dolly.calls.ran).toEqual(['/agents']);
    expect(dolly.calls.sent.join('\n')).toMatch(/^usage: \/<handle> agents/m);
    recordedOnly(kg, '/don agents');
  });

  it('a handle is case-insensitive: /E Restart runs on kg', async () => {
    const { kg, say } = pair();
    await say(operator('/E Restart'));
    expect(kg.calls.exit).toEqual([43]);
  });
});

describe('a bare /<command> is no command anywhere', () => {
  for (const body of ['/join', '/join viaje', '/restart', '/agents']) {
    it(`"${body}" runs nothing on either node and is an ordinary message`, async () => {
      const { kg, dolly, say } = pair({ mode: 'on' });
      await say(operator(body));
      for (const n of [kg, dolly]) {
        expect(n.calls.ran, n.name).toEqual([]);
        expect(n.calls.create, n.name).toEqual([]);
        expect(n.calls.exit, n.name).toEqual([]);
        expect(n.calls.transcript, n.name).toEqual([body]);
        expect(n.calls.brain.map((b) => b.body), n.name).toEqual([body]);   // 'on': answered like any line
      }
    });
  }
});

// Operator 2026-10-19 ~14:20: "'/e hola' must not work since 'hola' is not recognized as a command".
describe('/<handle> <not a command> is ordinary text that addresses nobody', () => {
  it('/e hola: the router addresses no one; nothing runs; nobody is woken on either node', async () => {
    const { kg, dolly, say } = pair();
    const routed = await kg.router.resolve(member('/e hola'));
    expect(routed.targets).toEqual([]);
    await say(member('/e hola'));
    for (const n of [kg, dolly]) recordedOnly(n, '/e hola');
  });

  it('lock: "e hola" still wakes E on kg', async () => {
    const { kg, dolly, say } = pair();
    await say(member('e hola'));
    expect(kg.calls.brain.map((b) => b.being)).toEqual(['egpt']);
    expect(dolly.calls.brain).toEqual([]);
  });
});

// PER-CHAT HANDLES (operator 2026-10-24): where this chat's entry sets E's handles to [ekg], a command
// addressed `/e …` is not E's here (kg records it, as for another node's being) and `/ekg …` is.
describe("/<handle> <command> follows the chat's own handles", () => {
  it("REPRODUCE-FIRST: handles [ekg] here — `/e agents` is not E's, `/ekg agents` is", async () => {
    const kg = node('kg', { handlesHere: ['ekg'] });
    await kg.say(operator('/e agents'));
    recordedOnly(kg, '/e agents');
    await kg.say(operator('/ekg agents'));
    expect(kg.calls.ran).toEqual(['/agents']);
  });

  it('…and the chat line follows suit: "e hola" wakes nobody there, "ekg hola" wakes E', async () => {
    const kg = node('kg', { handlesHere: ['ekg'] });
    await kg.say(member('e hola'));
    expect(kg.calls.brain).toEqual([]);
    await kg.say(member('ekg hola'));
    expect(kg.calls.brain.map((b) => b.being)).toEqual(['egpt']);
  });

  it('LOCK: with no per-chat key `/e agents` runs on kg as before', async () => {
    const kg = node('kg');
    await kg.say(operator('/e agents'));
    expect(kg.calls.ran).toEqual(['/agents']);
  });
});

describe('aliases target /<handle> <command>', () => {
  it('"aparte: /e join": a member\'s "aparte viaje" makes SI+C-viaje on kg only', async () => {
    writeAliases('aparte: /e join\n');
    const { kg, dolly, say } = pair();
    await say(member('aparte viaje'));
    expect(kg.calls.ran).toEqual(['/join viaje']);
    expect(kg.calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
    recordedOnly(dolly, 'aparte viaje');
  });

  it('an old bare target ("aparte: /join") is refused at load with one log line; the line stays ordinary', async () => {
    writeAliases('aparte: /join\n');
    const { kg, say } = pair();
    await say(member('aparte viaje'));
    const refused = kg.calls.logs.filter((l) => l.startsWith('commands_alias.yaml: "aparte"'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/no being.*\/<handle> join.*refused/);
    expect(kg.calls.ran).toEqual([]);
    expect(kg.calls.create).toEqual([]);
  });
});

describe('the console (the editor shell, surface room) keeps bare commands', () => {
  const onConsole = (body) => operator(body, { surface: 'room', chatId: 'lobby', chatName: 'lobby', raw: null });
  it('a registered bare command runs there; the handle form too', async () => {
    const kg = node('kg');
    await kg.say(onConsole('/restart'));
    await kg.say(onConsole('/e restart force'));
    expect(kg.calls.exit).toEqual([43, 43]);
  });

  it('"/e hola" and an unregistered "/foo" are no command there and address nobody', async () => {
    const kg = node('kg');
    await kg.say(onConsole('/e hola'));
    await kg.say(onConsole('/foo bar'));
    expect(kg.calls.ran).toEqual([]);
    expect(kg.calls.brain).toEqual([]);
  });
});

describe('regression locks', () => {
  it('EGPT STOP from an allowed user still stops each node, in any chat', async () => {
    const { kg, dolly, say } = pair();
    await say(member('EGPT STOP', { authorized: true }));
    expect(kg.calls.stop).toHaveLength(1);
    expect(dolly.calls.stop).toHaveLength(1);
  });

  it('the radio quick reply "rs" is still the operator\'s command with no handle', async () => {
    const { kg, say } = pair();
    await say(operator('rs'));
    await say(member('rs'));
    expect(kg.calls.ran).toEqual(['rs']);
  });

  it('a being\'s reply limbs are untouched: "/react 👍" in a reply is still a limb', () => {
    const { run, prose } = parseReplyActions('hecho\n/react #m1 👍', { chatId: GROUP });
    expect(run).toEqual([{ type: 'react', chatId: GROUP, targetId: 'm1', emoji: '👍' }]);
    expect(prose).toBe('hecho');
  });
});
