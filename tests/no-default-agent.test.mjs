// NO DEFAULT AGENT (operator 2026-10-22/23): mode is per being. Every being whose mode in a chat is
// on/auto takes every line there, named or not; a named being takes it by its own mode; each being
// once per line; nobody on and nobody named → recorded, no reply. Real router + gating + spine.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';

const OP = '+16468217865';
const CHAT = { surface: 'whatsapp', chatId: '!g', chatName: 'grupo', kind: 'text', raw: { chatType: 'group' }, senderId: '+1555', senderName: 'Ana' };
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m-${Math.random()}`, ts: 1, mention: {}, ...extra });

function build(modes = {}) {
  const anyone = { allowed_users: ['*'] };   // the group's members reach every being
  const agents = {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt'], conversation_defaults: anyone },
    wren: { configuration: 'wren', handles: ['wren'], conversation_defaults: anyone },
    eplus: { configuration: 'egpt', handles: ['plus'], conversation_defaults: anyone },
  };
  const state = { contacts: { whatsapp: { '!g': { slug: 'grupo', agents: Object.fromEntries(Object.entries(modes).map(([b, mode]) => [b, { mode }])) } } } };
  const config = { agents, dispatch: { auto_default_mode: 'mention' } };
  let cb = null;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, emit(m) { return cb(m); }, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push(being); return { text: 'ok', sessionId: 's', being }; } };
  const transcript = { entries: [], async log(ev, reply) { this.entries.push({ ev, reply }); } };
  const sender = { open() { return { update() {}, fail() {}, async finish() {} }; } };
  const loadState = async () => state;
  const spine = createSpine({
    bridge, brain, sender, transcript,
    router: createRouter({ getAgents: () => agents, getConfig: () => config, loadState }),
    gating: createGating({ getConfig: () => config, loadState }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  spine.start();
  const inbound = () => transcript.entries.filter((e) => e.reply == null).map((e) => e.ev.body);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { bridge, brain, inbound, settle };
}

// contract 6.6
describe('no default agent — mode is per being', () => {
  it('REPRODUCE-FIRST: two "on" beings both answer an unnamed line', async () => {
    const { bridge, brain, settle } = build({ egpt: 'on', wren: 'on' });
    await bridge.emit(msg('buenas'));
    await settle();
    expect(brain.calls.sort()).toEqual(['egpt', 'wren']);
  });

  it('REPRODUCE-FIRST: an "on" being also answers a line naming another being — each being once', async () => {
    const { bridge, brain, settle } = build({ wren: 'on' });
    await bridge.emit(msg('@e hola'));
    await settle();
    expect(brain.calls.sort()).toEqual(['egpt', 'wren']);
    brain.calls.length = 0;
    await bridge.emit(msg('@wren hola'));   // named AND on: one turn, not two
    await settle();
    expect(brain.calls).toEqual(['wren']);
  });

  it('an accum being only accumulates an unnamed line; named, it answers', async () => {
    const { bridge, brain, inbound, settle } = build({ egpt: 'accum' });
    await bridge.emit(msg('buenas'));
    await settle();
    expect(brain.calls).toEqual([]);
    await bridge.emit(msg('@e qué opinas'));
    await settle();
    expect(brain.calls).toEqual(['egpt']);
    expect(inbound()).toEqual(['buenas', '@e qué opinas']);
  });

  // contract 12.1
  it('REPRODUCE-FIRST: nobody on and nobody named → recorded, no reply (a quote of an unsigned post of ours no longer wakes a default being)', async () => {
    const { bridge, brain, inbound, settle } = build({});
    await bridge.emit(msg('buenas'));
    await bridge.emit(msg('y esto?', { replyToId: 'x1', mention: { replyToBot: true } }));
    await settle();
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['buenas', 'y esto?']);
  });

  it('a line every being here has "off" is not recorded', async () => {
    const { bridge, brain, inbound, settle } = build({ egpt: 'off', wren: 'off', eplus: 'off' });
    await bridge.emit(msg('buenas'));
    await settle();
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual([]);
  });

  it('REPRODUCE-FIRST: the auto + isSender rule holds for an EXTRA target too — the operator\'s own line prompts no auto being', async () => {
    const { bridge, brain, inbound, settle } = build({ egpt: 'auto', eplus: 'auto' });
    await bridge.emit(msg('@e y @plus, vengan', { senderId: OP, isSender: true }));
    await settle();
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['@e y @plus, vengan']);
  });
});
