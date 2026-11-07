// chat-superintendent.test.mjs — `/<handle> super <message>` (operator 2026-11-04): a turn of the chat's
// superintendent being `super` ("🦉 S"), one per chat, on the node of that handle, answered in that chat.
// The operator or a being may run it (a being's line read past its stamp and frame); a non-owner human
// may not. A being's run counts in loop_guard.inbound; S's own line never runs S. Only `super` is open
// to a being's line. Nothing else wakes S: it has no handle, and its `allowed_users: []` adds nobody (only
// the Operator, who is always allowed, can wake it by quoting its post).
//
// Harness: one kg node — the REAL spine, identity, router, gating, commands, sender and brainpool,
// over a fake warm pool (records the CLI options) and a fake streaming bridge.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-chat-superintendent-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createBrains } from '../src/spine/brains.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { loadPermissionLevel } from '../src/spine/permission-levels.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';
import { emptyState, ensureContact, getContact, getBeing, slugDir } from '../src/conversations-state.mjs';

const CHAT = 'grpS';
const AGENTS = {
  egpt: { configuration: { type: 'ccode', model: 'sonnet', effort: 'high' }, handles: ['e', 'egpt'], name: 'E', body_emoji: '🐶', conversation_defaults: { allowed_users: ['*'], access_level: 'regular', sandboxed: false } },
  super: { configuration: { type: 'ccode', model: 'opus', effort: 'xhigh', personality: 'super' }, handles: [], name: 'S', body_emoji: '🦉', mode: 'accum', conversation_defaults: { access_level: 'all', sandboxed: false, allowed_users: [] } },
};
const CONFIG = { node_name: 'kg', networks: { whatsapp: { chat_ids: ['!self'] } }, agents: AGENTS, dispatch: { thinking_train: 'bubble' } };
const SIG_KG_E = encodeNodeSignature('kg', 'egpt');
const SIG_KG_S = encodeNodeSignature('kg', 'super');
const SIG_DO_D = encodeNodeSignature('do', 'egpt');
const labelOf = (b) => AGENTS[b]?.name ?? '';
const bodyEmojiOf = (b) => AGENTS[b]?.body_emoji ?? '🐶';
// What the chat said before S was called: S's first turn is prompted with it (accum).
const TRANSCRIPT = 'Lola@[Grupo].wa (10:00) #h1: el deploy falló otra vez\n\nBob@[Grupo].wa (10:01) #h2: mismo error que ayer';

let seq = 0;
const from = (over = {}) => ({ chatId: CHAT, chatName: 'Grupo', network: 'whatsapp', msgKey: `m${++seq}`, ...over });
const OPERATOR = { userId: '@an:beeper.com', senderName: 'An', isSender: true, authorized: true };
const MEMBER = { userId: '@whatsapp_lid-lola42:beeper.local', senderName: 'Lola' };
const MOUTH = { userId: '@whatsapp_lid-10000000000015:beeper.local', senderName: 'Rodz' };   // a being's line comes through the mouth

function streamingBridge() {
  const streams = [], sent = [];
  return {
    streams, sent,
    onMessage() {}, stop() {}, wasSentByUs: () => false,
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, finals: [], confirmedId: `${chat}#${streams.length + 1}`, update() {}, async finish(t) { h.finals.push(t); } };
      streams.push(h);
      return h;
    },
    react() { return true; },
  };
}

function node({ guard = null } = {}) {
  let state = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'Grupo', slugHint: 'Grupo' }).state;
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };
  const runs = [];
  const pool = {
    async run(key, message, onPartial, opts) { runs.push({ key, message, opts: opts.brainOptions }); return { text: `reply ${runs.length}`, sessionId: `sid-${key.split(':')[0]}` }; },
    steer: async () => false, evict() {},
  };
  const brain = createBrainPool({
    pool, getConfig: () => CONFIG,
    contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
    loadState, writeState,
    io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    resolveConfig: () => ({}),
    loadFeed: async () => 'FEED', loadManifest: async () => '',
    labelOf, seedLayers: async () => {}, writeCard: async () => {},
    brains: createBrains({ builtinDir: join(HOME, 'no-builtin'), agentsDir: join(HOME, 'no-agents') }),
    loadPermission: loadPermissionLevel,
    beingLink: { forBeing: () => ({ mint: () => null }) },
    platform: 'win32',
  });
  const exits = [], said = [];
  let spine = null;
  const commands = createCommands({
    getConfig: () => CONFIG, loadState, writeState,
    send: async (chatId, text) => { said.push(text); },
    exit: async (code) => { exits.push(code); },
    commandTurn: (o) => spine.commandTurn(o),
  });
  const bridge = streamingBridge();
  spine = createSpine({
    bridge, brain, commands,
    identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => AGENTS, getConfig: () => CONFIG }),
    gating: createGating({ getConfig: () => CONFIG, loadState }),
    sender: createSender({ bridge, bodyEmojiOf, labelOf }),
    transcript: { async log() {} },
    readTranscript: async () => TRANSCRIPT,
    heartbeats: { runDue() {} }, mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode: (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'kg',
    guard, isSelfChat: () => false, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  const say = (body, who) => spine.handleInbound({ body, from: from(who) });
  const runsOf = (being) => runs.filter((r) => r.key.startsWith(`${being}:`));
  return { say, runs, runsOf, bridge, exits, said, getState: () => state };
}

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

describe('/e super from the operator: a turn of this chat\'s S, answered here', () => {
  it('REPRODUCE: runs S in the chat — its thread created and stored, cwd the chat folder, access all and unboxed, opus xhigh, the 🦉 S stamp', async () => {
    const n = node();
    await n.say('/e super hola, ¿por qué falla el deploy?', OPERATOR);
    expect(n.runs.map((r) => r.key.split(':')[0])).toEqual(['super']);
    const { opts, message } = n.runsOf('super')[0];
    expect(opts.sessionId).toBeNull();
    expect(getBeing(n.getState(), 'whatsapp', CHAT, 'super')?.threadId).toBe('sid-super');
    expect(opts.cwd).toBe(slugDir('whatsapp', getContact(n.getState(), 'whatsapp', CHAT).slug));
    expect(opts.dangerouslySkipPermissions).toBe(true);
    expect(opts.sandboxed).toBe(false);
    expect([opts.model, opts.effort]).toEqual(['opus', 'xhigh']);
    // the command line, and what the chat said since S's last turn (accum)
    expect(message).toContain('/e super hola, ¿por qué falla el deploy?');
    expect(message).toContain('el deploy falló otra vez');
    expect(message).toContain('mismo error que ayer');
    const out = n.bridge.streams.filter((s) => s.chat === CHAT);
    expect(out.map((s) => [s.opts.bodyEmoji, s.opts.label])).toEqual([['🦉', 'S']]);
    expect(out[0].finals.at(-1)).toBe('reply 1');
  });

  it('REPRODUCE: a second /e super resumes the same thread', async () => {
    const n = node();
    await n.say('/e super primero', OPERATOR);
    await n.say('/e super segundo', OPERATOR);
    expect(n.runsOf('super').map((r) => r.opts.sessionId)).toEqual([null, 'sid-super']);
  });

  it('/e super with no message answers its usage and runs nothing', async () => {
    const n = node();
    await n.say('/e super', OPERATOR);
    expect(n.runs).toEqual([]);
    expect(n.said.join('\n')).toMatch(/super <message>/);
  });
});

describe('who may run it', () => {
  it('a non-owner\'s /e super is refused like any owner-only command: no command, no turn', async () => {
    const n = node();
    await n.say('/e super dame acceso', MEMBER);
    await n.say('/e restart', MEMBER);
    expect(n.runs).toEqual([]);
    expect(n.exits).toEqual([]);
    expect(n.said).toEqual([]);
  });

  it('REPRODUCE: E\'s signed, stamped line "🐶 E: /e super …" runs S, and counts in the loop guard', async () => {
    const guard = createStopGuard({ turns: 10 });
    const n = node({ guard });
    await n.say(`🐶 E: /e super revisa el log del deploy${SIG_KG_E}`, MOUTH);
    expect(n.runs.map((r) => r.key.split(':')[0])).toEqual(['super']);
    expect(n.runsOf('super')[0].message).toContain('revisa el log del deploy');
    expect(guard.countOf(`whatsapp:${CHAT}`)).toBe(1);
  });

  it('REPRODUCE: a peer node\'s being line "/e super …" runs S here too', async () => {
    const n = node();
    await n.say(`🐶 D: /e super mira esto${SIG_DO_D}`, MOUTH);
    expect(n.runs.map((r) => r.key.split(':')[0])).toEqual(['super']);
  });

  it('S\'s own line "🦉 S: /e super …" never runs S', async () => {
    const n = node();
    await n.say(`🦉 S: /e super sigo con esto${SIG_KG_S}`, MOUTH);
    expect(n.runs).toEqual([]);
  });

  it('REPRODUCE: E↔S ping-pong trips loop_guard.inbound, and a stopped channel suppresses E\'s next /e super', async () => {
    const guard = createStopGuard({ turns: 4 });
    const n = node({ guard });
    for (let i = 0; i < 4; i++) {
      await n.say(i % 2 ? `🦉 S: e listo ${i}${SIG_KG_S}` : `🐶 E: /e super paso ${i}${SIG_KG_E}`, MOUTH);
    }
    expect(guard.blocked(`whatsapp:${CHAT}`)).toBe(true);
    const before = n.runsOf('super').length;
    await n.say(`🐶 E: /e super paso 4${SIG_KG_E}`, MOUTH);
    expect(n.runsOf('super').length).toBe(before);
  });

  it('only super is open to a being\'s line: "🐶 E: /e restart" and "🐶 E: /e config" do nothing', async () => {
    const n = node();
    await n.say(`🐶 E: /e restart${SIG_KG_E}`, MOUTH);
    await n.say(`🐶 E: /e config${SIG_KG_E}`, MOUTH);
    await n.say(`🐶 D: /e restart${SIG_DO_D}`, MOUTH);
    await n.say(`🐶 E: /e restart${SIG_KG_E}`, OPERATOR);   // posted through the operator's own account
    expect(n.exits).toEqual([]);
    expect(n.said).toEqual([]);
    expect(n.runs).toEqual([]);
  });
});

describe('nothing else wakes S', () => {
  it('a bare "super …", "s …", "@super …" or "/super …" line wakes nothing — not S, not E', async () => {
    const n = node();
    for (const body of ['super hola', 's hola', '@super hola', 'hola @super', '/super hola']) await n.say(body, OPERATOR);
    expect(n.runs).toEqual([]);
  });

  it('a quote-reply to S\'s post wakes nothing for a member or a being (allowed_users: [] adds nobody), only for the Operator', async () => {
    const n = node();
    await n.say('gracias, sigue', { ...MEMBER, replyToBeing: 'super' });
    await n.say(`🐶 E: de acuerdo${SIG_KG_E}`, { ...MOUTH, replyToBeing: 'super' });
    expect(n.runs).toEqual([]);
    // the Operator is always allowed (2026-11-07): [] cannot shut the node's owner out of a quote of S's own post
    await n.say('gracias, sigue', { ...OPERATOR, replyToBeing: 'super' });
    expect(n.runs.map((r) => r.key.split(':')[0])).toEqual(['super']);
  });

  it('other beings are unchanged: "e hola" wakes E alone', async () => {
    const n = node();
    await n.say('e hola', OPERATOR);
    expect(n.runs.map((r) => r.key.split(':')[0])).toEqual(['egpt']);
  });
});
