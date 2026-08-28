// remote-command.test.mjs — egpt as a REMOTE CONTROL for the network (operator 2026-07-26:
// "i open a local shell, type '/chrome mo' and a chrome in mo's spine, a friend in germany,
// opens. i can drive it by typing commands on the egpt shell").
//
// The operator's SHELL is node-local (the spine dials the editor on 127.0.0.1:23375), so no
// other node EVER sees a shell message — the mesh is the only path. A node-addressed command
// whose node is not ours, said where that node cannot hear it, becomes a MESH ENVELOPE; the
// target executes it locally and the reply mirrors home through the machinery a `@don`
// being-prompt already rides.
//
// Everything here runs the REAL services (commands + mesh + spine) against a fake bridge and
// a fake brain. No network, no Chrome, no Claude.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
// A PRIVATE profile for this file — the SAME fix, for the same reason, as
// tests/rooms-members.test.mjs and tests/list-entity-dirs.test.mjs.
//
// The room-scoped mesh tests below use a REAL Room, so /members writes go through
// Room.setMember → ONE process-global config/rooms.yaml (rooms-file.roomsFilePath). The
// suite's SHARED throwaway profile (tests/setup-egpt-home.mjs) is written CONCURRENTLY by
// tests/lobby.test.mjs, and vitest's `forks` pool puts the two in DIFFERENT PROCESSES — so
// their read-modify-writes lose each other's updates, and whichever file is mid-sequence
// reads back a roster missing the member it just added. Nothing prunes that shared file
// either (179 KB / 6.5k junk rows locally), so the window only ever widened.
//
// egpt-home.mjs freezes EGPT_HOME at module load, so the override must run BEFORE the imports
// below — vi.hoisted is what does that. The beforeAll below is the tripwire + the prune.
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-remote-command-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { createMeshService } from '../src/spine/mesh.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { emptyState } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';


// Tripwire + prune: never the live profile, never the shared one, and never an accumulation
// of its own. Fails loudly rather than racing again.
beforeAll(() => {
  expect(join(EGPT_HOME)).toBe(join(TEST_HOME));
  expect(EGPT_HOME).not.toBe(join(homedir(), '.egpt'));
  expect(EGPT_HOME).not.toBe(join(homedir(), '.egpt-test-home'));
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
// Real fs I/O (the room-scoped mesh tests below use a REAL Room, config.yaml and all) takes a
// few more event-loop turns than the in-memory fakes elsewhere in this file — drain generously.
const drain = async () => { for (let i = 0; i < 10; i++) await flush(); };

// kg's REAL agent shape (REVE's live config, read 2026-07-26): `don` is the relay to node `do`,
// SURFACE-PINNED to the shell because on Beeper `do` hears the operator directly; `carol` is an
// UNPINNED multipath relay that also names do. Both are the routing table now — there is no
// mesh.nodes (evicted 2026-07-25, "we do agent-base routing").
const KG = () => ({
  node_name: 'kg',
  account_peers: ['kg', 'do'],
  networks: { whatsapp: { chat_ids: ['!self'] } },
  agents: {
    egpt: { configuration: 'claude', handles: ['e'], default: true },
    carol: { handles: ['carol'], paths: [{ path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } }] },
    don: { surface: 'shell', to: 'don.do', relay_channel: 'egpt-mesh-do-kg' },
  },
});

// do's side: `don` is a LOCAL being here (that is what `to: don.do` points at).
const DO = () => ({
  node_name: 'do',
  account_peers: ['kg', 'do'],
  networks: { whatsapp: { chat_ids: ['!do-self'] } },
  agents: {
    egpt: { configuration: 'claude', handles: ['e'], default: true },
    don: { configuration: 'claude' },
  },
});

function fakeBridge() {
  const b = {
    sent: [], statusPosts: [], streams: [],
    async resolveChatId(nameOrId) { return nameOrId; },
    send(chat, text) { b.sent.push({ chat, text }); return { ok: true }; },
    async postStatus(chat, text) { const id = `post-${b.statusPosts.length + 1}`; b.statusPosts.push({ chat, text, id }); return id; },
    startStream(chat, init, opts = {}) {
      const h = { chat, init, opts, updates: [], finals: [], delivered: false, lastError: null };
      h.update = (t) => h.updates.push(t);
      h.finish = async (t) => { h.finals.push(t); h.delivered = true; };
      h.delete = async () => {};
      h.fail = () => {};
      b.streams.push(h);
      return h;
    },
    onMessage() {}, stop() {},
  };
  return b;
}

const LIVE_CDP = {
  isRunning: async () => true,
  listTabs: async () => [{ id: 't1', title: 'Claude', url: 'https://claude.ai/' }],
  cdpHost: async () => '127.0.0.1:9221',
  openTab: async () => 't2',
  activateTarget: async () => {},
  closeTab: async () => {},
};

// One node's full stack: real commands + real mesh + real spine over fakes.
// resolveConvRoom/loadAdapters are optional passthroughs (undefined = createCommands' own
// defaults, unchanged) — the room-scoped mesh tests below inject a real one.
function nodeStack({ config, cdp = LIVE_CDP, resolveConvRoom, loadAdapters } = {}) {
  const bridge = fakeBridge();
  const exits = [];
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: 'the being answers' }; } };
  let t = 0;
  const commands = createCommands({
    getConfig: () => config,
    send: (chatId, text) => bridge.send(chatId, text),
    exit: (code) => exits.push(code),
    cdp,
    launchChromeTask: () => ({ ok: false }),
    now: () => t,
    sleep: async (ms) => { t += ms; },
    resolveConvRoom,
    loadAdapters,
  });
  const mesh = createMeshService({ bridge, brain, commands, getConfig: () => config, setTimer: () => null, clearTimer: () => {} });
  const transcript = { entries: [], async log(ev) { this.entries.push(ev); } };
  const spine = createSpine({
    bridge, brain, commands, mesh,
    identity: { build: (m) => ({ ...m }) },
    router: { resolve: () => ({ being: 'e', mention: {} }) },
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
    sender: { open: () => ({ update() {}, fail() {}, async finish() {} }) },
    transcript, heartbeats: { runDue() {} },
    clock: { now: () => 1 },
  });
  return { bridge, brain, commands, mesh, spine, exits, transcript };
}

const envelopes = (bridge) => bridge.sent.filter((s) => parseMesh(s.text) != null);
const plain = (bridge) => bridge.sent.filter((s) => parseMesh(s.text) == null);

// The console's InboundEvent as identity.build actually stamps it since 2026-08-28: the shell
// is a TRANSPORT (node tag 'sh', network 'shell') onto surface `room`, seat `lobby`. The
// operator's `don: surface: shell` pin still routes here — it names a network, and both the
// router and agentRoutes resolve it through the SAME network->surface map identity used.
const SHELL = { surface: 'room', node: 'sh', chatId: 'lobby', chatName: 'shell', senderId: 'operator', senderName: 'operator', msgId: null, ts: 1, kind: 'text', authorized: true, raw: {} };
const FAM = { surface: 'whatsapp', node: 'wa', chatId: '!fam', chatName: 'fam', senderId: 'u-an', senderName: 'An', msgId: 'm1', ts: 1, kind: 'text', authorized: true, isSender: true, raw: {} };

// ── 1. THE HEADLINE: a node-addressed command typed on the SHELL must TRAVEL ───────────────
describe('origin — a node-addressed command the target cannot hear becomes a mesh envelope', () => {
  it('/chrome do on kg\'s SHELL forwards ONE envelope to do\'s route and posts the 🤔 home', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/chrome do' });
    await flush();

    const envs = envelopes(bridge);
    expect(envs).toHaveLength(1);
    // The route came from the AGENTS block: `don` carries relay_channel + `to: don.do`, and is
    // pinned `surface: shell` — the operator's own declaration that this is the shell's relay.
    expect(envs[0].chat).toBe('egpt-mesh-do-kg');
    expect(parseMesh(envs[0].text)).toMatchObject({ to: 'don.do', body: '/chrome do', from_node: 'kg', from: 'shell' });
    // …and the origin got its living-mirror placeholder, in the SHELL chat.
    expect(bridge.statusPosts.map((p) => p.chat)).toEqual(['lobby']);
    // Nothing was answered locally: kg does not run a `do` command.
    expect(plain(bridge)).toHaveLength(0);
  });

  it('the reply mirrors back into the origin shell chat', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/chrome do' });
    await flush();
    const postId = bridge.statusPosts[0].id;

    // do answers: a reply envelope observed in the relay chat, carrying the return address.
    await spine.handleInbound({
      surface: 'whatsapp', node: 'wa', chatId: 'egpt-mesh-do-kg', chatName: 'mesh', senderId: 'u-do', senderName: 'do',
      msgId: 'r1', ts: 2, kind: 'text', raw: {},
      body: encodeMesh({ by: 'don.do', body: 'attached: 127.0.0.1:9221', re: 'shell.kg', post_id: postId, done: true }),
    });
    await flush();

    const home = bridge.streams.filter((s) => s.chat === 'lobby');
    expect(home).toHaveLength(1);
    expect(home[0].finals.join('\n')).toContain('attached: 127.0.0.1:9221');
  });
});

// ── 2. WHAT MUST NOT CHANGE ────────────────────────────────────────────────────────────────
describe('origin — the local and broadcast paths are untouched', () => {
  it('/chrome kg on kg\'s own shell is handled LOCALLY — no envelope', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/chrome kg' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)).toHaveLength(1);
    expect(plain(bridge)[0]).toMatchObject({ chat: 'lobby' });
    expect(plain(bridge)[0].text).toContain('attached: 127.0.0.1:9221');
  });

  it('/chrome do in a SHARED BEEPER chat is unchanged: broadcast + gate, NO envelope, kg silent', async () => {
    // `do` shares this Beeper account (account_peers) and saw the very same message, so it
    // answers through its own gate. kg must neither answer nor relay — one answer, as today.
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/chrome do' });
    await flush();
    expect(bridge.sent).toHaveLength(0);
    expect(bridge.statusPosts).toHaveLength(0);
  });

  it('/status do in a SHARED BEEPER chat stays silent on kg (the existing node gate)', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/status do' });
    await flush();
    expect(bridge.sent).toHaveLength(0);
  });

  it('bare /status is still answered by this node', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/status' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)).toHaveLength(1);
    expect(plain(bridge)[0].text).toContain('node_name: kg');
  });
});

// ── 3. NO ROUTE = A LOUD ERROR, NEVER SILENCE ──────────────────────────────────────────────
describe('origin — a node no agent can route to fails loudly', () => {
  it('/chrome mo on the shell says so in the shell, and forwards nothing', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/chrome mo' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)).toHaveLength(1);
    expect(plain(bridge)[0].chat).toBe('lobby');
    expect(plain(bridge)[0].text).toMatch(/mo/);
    expect(plain(bridge)[0].text).toMatch(/route|agent/i);
  });

  it('BEHAVIOUR CHANGE, locked: on a Beeper surface too — account_peers is what buys the silence', async () => {
    // `/chrome <node>` used to be silent for ANY non-match, anywhere. It still is for a node
    // listed in account_peers (which heard the message and answers — the test above), but an
    // unroutable, unknown node now says so instead of vanishing. On a co-account node that
    // means account_peers must actually list the siblings; the message itself says as much.
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/chrome mo' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0]).toMatchObject({ chat: '!fam' });
    expect(plain(bridge)[0].text).toMatch(/no agent routes to node "mo"/);
  });

  it('adding an agent that NAMES mo is all it takes to reach her', async () => {
    const config = KG();
    config.agents.mo = { relay_channel: 'egpt-mesh-mo', to: 'e.mo' };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/chrome mo' });
    await flush();
    const envs = envelopes(bridge);
    expect(envs).toHaveLength(1);
    expect(envs[0].chat).toBe('egpt-mesh-mo');
    expect(parseMesh(envs[0].text)).toMatchObject({ to: 'e.mo', body: '/chrome mo' });
  });
});

// ── 3b. NODE → ROUTE comes from the AGENTS block, and only from there ──────────────────────
describe('node → route derivation', () => {
  it('a SURFACE-PINNED agent wins on its own surface over an unpinned one naming the same node', async () => {
    // kg has BOTH: `carol` (unpinned multipath → don.do) and `don` (surface: shell → don.do).
    // The pin is the operator's declaration of where this relay applies, so on the shell it is
    // `don`'s channel that carries the command — not carol's two.
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/chrome do' });
    await flush();
    expect(envelopes(bridge).map((e) => e.chat)).toEqual(['egpt-mesh-do-kg']);
  });

  it('with nothing pinned, an UNPINNED multipath agent carries it through every one of its paths', async () => {
    const config = KG();
    delete config.agents.don;                                   // leave only carol (2 paths → do)
    config.agents.carol = { handles: ['carol'], paths: [
      { path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } },
      { path2: { relay_channel: 'egpt-mesh-do-kg', network: 'telegram', to: 'don.do' } },
    ] };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/chrome do' });
    await flush();
    expect(envelopes(bridge).map((e) => e.chat).sort()).toEqual(['egpt-mesh-do-kg', 'rodz1']);
    expect(bridge.statusPosts).toHaveLength(1);                 // ONE 🤔 home, first reply wins
  });

  it('an agent pinned to ANOTHER surface does not route here', async () => {
    // `don` is surface: shell. From a Beeper chat it is invisible — which is exactly why
    // /chrome do broadcasts there instead of relaying. With carol removed there is no route.
    const config = KG();
    delete config.agents.carol;
    config.account_peers = ['kg'];                              // …and do is not a co-account peer
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...FAM, body: '/chrome do' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toMatch(/no agent routes to node "do"/);
  });

  // Operator 2026-07-26: "disabling is just commenting the config. no need to have or check an
  // enabled key in this case." agentRoutes stopped consulting the key, so the routing table is
  // built from what is IN the config — an entry carrying `enabled: false` is a route like any
  // other, and only removing (commenting out) the agent removes the route.
  it('an `enabled: false` key is INERT — the agent is still a route', async () => {
    const config = KG();
    delete config.agents.carol;
    config.agents.don.enabled = false;
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/chrome do' });
    await flush();
    expect(envelopes(bridge).map((e) => e.chat)).toEqual(['egpt-mesh-do-kg']);
  });

  it('a COMMENTED-OUT (absent) agent is not a route', async () => {
    const config = KG();
    delete config.agents.carol;
    delete config.agents.don;
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/chrome do' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toMatch(/no agent routes to node "do"/);
  });
});

// ── 4. THE LOCK: lifecycle + the safe word are NOT remotely invocable ──────────────────────
describe('lock — lifecycle and STOP never travel', () => {
  it('/restart do on the shell forwards NOTHING (it is not node-addressable)', async () => {
    const { bridge, spine, exits } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/restart do' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(exits).toEqual([43]);        // local lifecycle, exactly as before
  });

  for (const line of ['/upgrade do', '/rewind do']) {
    it(`${line} forwards NOTHING`, async () => {
      const { bridge, spine } = nodeStack({ config: KG() });
      await spine.handleInbound({ ...SHELL, body: line });
      await flush();
      expect(envelopes(bridge)).toHaveLength(0);
    });
  }

  it('a multi-line body is never node-addressed (so the token strip can never cut the text)', async () => {
    const { commands } = nodeStack({ config: KG() });
    expect(commands.remoteNode({ ...SHELL, body: '/tabs do\nand more' })).toBe(null);
  });
});

describe('lock — the STOP safe word cannot be pulled from another machine', () => {
  it('an envelope carrying "stop" does NOT take the responder down', async () => {
    // Three independent reasons, all pre-existing and all preserved: the safe word is not a
    // slash command (so it is not in the node-addressable allowlist and never executes on the
    // responder); the envelope BODY the safe-word check sees is the encoded wire text, not
    // "stop"; and relay traffic is never a human turn, nor said in the Self chat.
    const pulls = [];
    const bridge = fakeBridge();
    const brain = { calls: [], async turn() { this.calls.push(1); return { text: 'ok' }; } };
    const config = DO();
    const commands = createCommands({ getConfig: () => config, send: (c, t) => bridge.send(c, t), exit: () => {} });
    const mesh = createMeshService({ bridge, brain, commands, getConfig: () => config, setTimer: () => null, clearTimer: () => {} });
    const spine = createSpine({
      bridge, brain, commands, mesh,
      identity: { build: (m) => ({ ...m }) },
      router: { resolve: () => ({ being: 'e', mention: {} }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: { open: () => ({ update() {}, fail() {}, async finish() {} }) },
      transcript: { async log() {} }, heartbeats: { runDue() {} },
      stopSwitch: { present: () => false, async pull(why) { pulls.push(why); } },
      isSelfChat: () => true,          // even in the most permissive case
      clock: { now: () => 1 },
    });
    await spine.handleInbound({
      surface: 'whatsapp', node: 'wa', chatId: 'egpt-mesh-do-kg', chatName: 'mesh', senderId: 'u-an', senderName: 'An',
      msgId: 's1', ts: 4, kind: 'text', raw: {}, authorized: true, isSender: true,
      body: encodeMesh({ by: 'An', body: 'stop', from: 'shell', from_node: 'kg', to: 'don.do', post_id: 'post-1' }),
    });
    await flush();
    expect(pulls).toEqual([]);
    expect(brain.calls).toHaveLength(1);   // ordinary relayed text
  });
});

// ── 5. THE RESPONDER: an envelope-delivered command executes locally ───────────────────────
describe('responder — an arriving envelope carrying a node-addressed command', () => {
  const request = (body, extra = {}) => ({
    surface: 'whatsapp', node: 'wa', chatId: 'egpt-mesh-do-kg', chatName: 'mesh',
    senderId: 'u-an', senderName: 'An', msgId: 'q1', ts: 3, kind: 'text', raw: {},
    authorized: true, isSender: true, ...extra,
    body: encodeMesh({ by: 'An', body, from: 'shell', from_node: 'kg', to: 'don.do', post_id: 'post-1' }),
  });

  it('DEFECT 2 FIX: runs the command (NOT the being) and posts the reply home as ONE plain send — no streaming placeholder for static tubing', async () => {
    const { bridge, brain, spine } = nodeStack({ config: DO() });
    await spine.handleInbound(request('/chrome do'));
    await flush();
    expect(brain.calls).toHaveLength(0);                       // the being never saw it
    // a static command never opens a streaming placeholder (no AI involved — nothing to stream)
    expect(bridge.streams.filter((s) => s.chat === 'egpt-mesh-do-kg')).toHaveLength(0);
    const relayReplies = bridge.sent.filter((s) => s.chat === 'egpt-mesh-do-kg' && parseMesh(s.text)?.done);
    expect(relayReplies).toHaveLength(1);
    const finalFrame = parseMesh(relayReplies[0].text);
    expect(finalFrame).toMatchObject({ by: 'don.do', re: 'shell.kg', post_id: 'post-1', done: true });
    expect(finalFrame.body).toContain('attached: 127.0.0.1:9221');
  });

  it('a NON node-addressable command falls through to the being — /restart can never arrive', async () => {
    const { brain, spine, exits } = nodeStack({ config: DO() });
    await spine.handleInbound(request('/restart do'));
    await flush();
    expect(exits).toEqual([]);                                 // the node did NOT restart
    expect(brain.calls).toHaveLength(1);                       // ordinary relayed text, as today
  });

  it('a command addressed at ANOTHER node is not executed here — and a BRAIN reply still streams (the lock: only commandReply skips the placeholder)', async () => {
    const { brain, spine, bridge } = nodeStack({ config: DO() });
    await spine.handleInbound(request('/chrome kg'));
    await flush();
    expect(brain.calls).toHaveLength(1);                       // not ours → ordinary relayed text
    const relayStream = bridge.streams.filter((s) => s.chat === 'egpt-mesh-do-kg');
    expect(relayStream).toHaveLength(1);                       // the being path DOES open the placeholder
    expect(parseMesh(relayStream[0].finals.at(-1)).body).toContain('the being answers');
  });

  it('AUTHORIZATION IS THE EXISTING ONE: an unauthorized envelope does not run the command', async () => {
    // Nothing new was invented here — this is `commands.isCommand`, the same gate a typed
    // command passes. On `do` the peer's post arrives isSender:true; on a friend's node the
    // sender's id sits in allowed_users. Strip both and the command is refused.
    const { bridge, brain, spine } = nodeStack({ config: DO() });
    await spine.handleInbound(request('/chrome do', { authorized: false, isSender: false }));
    await flush();
    expect(brain.calls).toHaveLength(0);
    const relayReplies = bridge.sent.filter((s) => s.chat === 'egpt-mesh-do-kg' && parseMesh(s.text)?.done);
    expect(relayReplies).toHaveLength(1);
    expect(parseMesh(relayReplies[0].text).body).toMatch(/not authorized/i);
  });

  it('the reply can never itself parse as a command (the flood fix holds over the mesh)', async () => {
    // `/tabs` answers with a fenced list; every reply this module emits goes out through the
    // ONE chokepoint that backticks a leading command token, so the body the ORIGIN posts into
    // its chat cannot start with '/'.
    const { bridge, spine } = nodeStack({ config: DO(), cdp: { ...LIVE_CDP, listTabs: async () => { throw new Error('no chrome'); } } });
    await spine.handleInbound(request('/tabs=do'));   // current grammar — "/tabs do" (bare positional) is not addressable for /tabs, only /chrome
    await flush();
    const relayReplies = bridge.sent.filter((s) => s.chat === 'egpt-mesh-do-kg' && parseMesh(s.text)?.done);
    const body = parseMesh(relayReplies[0].text).body;
    expect(body.trimStart().startsWith('/')).toBe(false);
  });
});

// ── 5b. THE RESPONDER'S OWN LOBBY: a room-scoped command over the mesh (bug #23 half A,
// 2026-07-27 — live failure: "/members add tab 1 c1" reported success, then a following
// "/members" showed a brand-new, empty "contact-<timestamp>" room). mesh.mjs's commandReply
// mints a FRESH private chatId (`<chat>#cmd<n>`) for EVERY command — deliberately, so captured
// replies never cross — but resolving a ROOM through that id, one call at a time, made add and
// list land in two different throwaway rooms. The fix routes a mesh-marked event's room
// resolution to the responder's own lobby instead, through the SAME resolveConvRoom seam.
class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}
const ADAPTERS = [{ name: 'chatgpt-cdp', urlMatch: /chatgpt\.com|chat\.openai\.com/, homeUrl: 'https://chatgpt.com/' }];
const oneTab = [{ id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' }];

describe("responder — a room-scoped command over the mesh resolves to THIS node's own lobby", () => {
  let base;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-mesh-room-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  const request = (body, { msgId = 'q1', postId = 'post-1' } = {}) => ({
    surface: 'whatsapp', node: 'wa', chatId: 'egpt-mesh-do-kg', chatName: 'mesh',
    senderId: 'u-an', senderName: 'An', msgId, ts: 3, kind: 'text', raw: {},
    authorized: true, isSender: true,
    body: encodeMesh({ by: 'An', body, from: 'shell', from_node: 'kg', to: 'don.do', post_id: postId }),
  });

  // A resolveConvRoom keyed EXACTLY on the (surface, chatId) pair it's called with — same shape
  // as the real one (contacts.resolve → a slug → a Room), just without the timestamp-suffixed
  // slug minting, so the test isolates the ONE thing in question: are add and list called with
  // the SAME pair, or two different ones? Records every call so a test can assert on the pairs.
  function keyedResolveConvRoom() {
    const rooms = new Map();
    const calls = [];
    const resolve = async (surface, chatId) => {
      calls.push([surface, chatId]);
      const key = `${surface}:${chatId}`;
      if (!rooms.has(key)) rooms.set(key, new TmpRoom(join(base, 'conv', surface, String(chatId)), String(chatId)));
      return rooms.get(key);
    };
    return { resolve, calls };
  }

  it('REPRODUCE-FIRST: /members=do add tab 1 c1 then /members=do over the mesh AGREE — the add is SEEN by the list', async () => {
    const { resolve, calls } = keyedResolveConvRoom();
    const { bridge, spine } = nodeStack({
      config: DO(), cdp: { ...LIVE_CDP, listTabs: async () => oneTab },
      resolveConvRoom: resolve, loadAdapters: async () => ADAPTERS,
    });

    await spine.handleInbound(request('/members=do add tab 1 c1', { msgId: 'q1', postId: 'post-1' }));
    await drain();
    await spine.handleInbound(request('/members=do', { msgId: 'q2', postId: 'post-2' }));
    await drain();

    // both room-scoped commands resolved through the SAME (surface, chatId) pair — never two.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);

    const relayReplies = bridge.sent.filter((s) => s.chat === 'egpt-mesh-do-kg' && parseMesh(s.text)?.done);
    expect(relayReplies).toHaveLength(2);
    expect(parseMesh(relayReplies[0].text)).toMatchObject({ post_id: 'post-1' });
    expect(parseMesh(relayReplies[0].text).body).toContain("added 'c1'");
    expect(parseMesh(relayReplies[1].text)).toMatchObject({ post_id: 'post-2' });   // correlation intact
    const listBody = parseMesh(relayReplies[1].text).body;
    expect(listBody).toContain('c1');
    expect(listBody).not.toContain('no members yet');
  });

  it('locks: the per-command chatId stays unique (captured replies still key off it) even though room resolution now ignores it', async () => {
    const { resolve } = keyedResolveConvRoom();
    const { bridge, spine } = nodeStack({
      config: DO(), cdp: { ...LIVE_CDP, listTabs: async () => oneTab },
      resolveConvRoom: resolve, loadAdapters: async () => ADAPTERS,
    });
    await spine.handleInbound(request('/members=do add tab 1 c1', { msgId: 'q1', postId: 'post-1' }));
    await drain();
    await spine.handleInbound(request('/members=do add tab 1 c2', { msgId: 'q2', postId: 'post-2' }));
    await drain();
    // two independent captured runs, two independent post_id-correlated replies — no cross-talk.
    const relayReplies = bridge.sent.filter((s) => s.chat === 'egpt-mesh-do-kg' && parseMesh(s.text)?.done);
    expect(relayReplies).toHaveLength(2);
    expect(parseMesh(relayReplies[0].text)).toMatchObject({ post_id: 'post-1' });
    expect(parseMesh(relayReplies[1].text)).toMatchObject({ post_id: 'post-2' });
  });

  it('locks: no contact-<timestamp> room or conversations.yaml entry is minted for the synthetic mesh chat', async () => {
    // The REAL resolver (contacts + ensureContact + fixedSlugFor), exactly what boot injects —
    // proves the fix routes room resolution to the lobby WITHOUT ever touching contacts under
    // the synthetic chat's own (surface, chatId), which is what used to mint contact-<ts>.
    let state = emptyState();
    const contacts = createContacts({
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: { rename: async () => {}, appendFile: async () => {} },
    });
    const rooms = new Map();
    const resolveConvRoom = async (surface, chatId) => {
      const slug = await contacts.resolve(surface, chatId);
      if (!slug) return null;
      if (!rooms.has(slug)) rooms.set(slug, new TmpRoom(join(base, 'conversations', surface, slug), slug));
      return rooms.get(slug);
    };
    const { bridge, spine } = nodeStack({
      config: DO(), cdp: { ...LIVE_CDP, listTabs: async () => oneTab },
      resolveConvRoom, loadAdapters: async () => ADAPTERS,
    });

    await spine.handleInbound(request('/members=do add tab 1 c1', { msgId: 'q1', postId: 'post-1' }));
    await drain();
    await spine.handleInbound(request('/members=do', { msgId: 'q2', postId: 'post-2' }));
    await drain();

    expect(state.contacts?.whatsapp ?? null).toBeNull();             // never resolved through the synthetic surface/chatId
    expect(state.contacts?.room?.lobby?.slug).toBe('lobby');          // resolved through the lobby instead
    const relayReplies = bridge.sent.filter((s) => s.chat === 'egpt-mesh-do-kg' && parseMesh(s.text)?.done);
    expect(parseMesh(relayReplies[1].text).body).toContain('c1');
  });

  it('a command that arrives on a REAL Beeper chat (not mesh) still resolves to THAT chat\'s own room, unchanged', async () => {
    const { resolve, calls } = keyedResolveConvRoom();
    const commands = createCommands({
      getConfig: () => DO(),
      send: () => {},
      cdp: { listTabs: async () => oneTab },
      loadAdapters: async () => ADAPTERS,
      resolveConvRoom: resolve,
    });
    // No `.mesh` mark — an ordinary inbound event, exactly what a real Beeper chat produces.
    await commands.run({ chatId: '!fam-chat', surface: 'whatsapp', body: '/members add tab 1 c1', authorized: true });
    await commands.run({ chatId: '!fam-chat', surface: 'whatsapp', body: '/members', authorized: true });
    expect(calls).toEqual([['whatsapp', '!fam-chat'], ['whatsapp', '!fam-chat']]);
  });
});

// ── 6. THE BROWSER FAMILY IS NODE-ADDRESSABLE (and gated by the SAME helper) ───────────────
// `=<name>` bound to the COMMAND TOKEN (operator ruling 2026-07-27, revised same day: the
// first cut let "node=<name>" float anywhere in the arguments, and `/tabs=do` typed live fell
// through to the catch-all — see the NODE_ADDRESSABLE comment in commands.mjs) is the ONE way
// to name a node for every member of the set except /chrome, whose whole argument IS the node
// (kept positional, tested separately above/in spine-commands.test.mjs).
describe('the node-addressable set — the browser family + /status + /members', () => {
  // REPRODUCE-FIRST: this is the exact line the operator typed live that fell through to the
  // unrecognized-command catch-all under the old floating "node=" scheme.
  it('REPRODUCE-FIRST: /tabs=do on the shell travels to do (not the catch-all)', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/tabs=do' });
    await flush();
    const envs = envelopes(bridge);
    expect(envs).toHaveLength(1);
    expect(envs[0].chat).toBe('egpt-mesh-do-kg');
    expect(parseMesh(envs[0].text).body).toBe('/tabs=do');
  });

  for (const [line, chat] of [['/tabs=do', 'egpt-mesh-do-kg'], ['/open=do https://x.com', 'egpt-mesh-do-kg'], ['/tab=do 1', 'egpt-mesh-do-kg'], ['/close=do 1', 'egpt-mesh-do-kg'], ['/status=do', 'egpt-mesh-do-kg'], ['/members=do', 'egpt-mesh-do-kg']]) {
    it(`${line} on the shell travels to do`, async () => {
      const { bridge, spine } = nodeStack({ config: KG() });
      await spine.handleInbound({ ...SHELL, body: line });
      await flush();
      const envs = envelopes(bridge);
      expect(envs).toHaveLength(1);
      expect(envs[0].chat).toBe(chat);
      expect(parseMesh(envs[0].text).body).toBe(line);   // forwarded VERBATIM — the target strips its own =<node> locally
    });
  }

  it('a query string is NEVER read as a node — /open https://x.com/?a=b stays local', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/open https://x.com/?a=b' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('opened: https://x.com/?a=b');
  });

  it('a trailing token that is NOT a node stays part of the command', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/open https://example.com' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('opened: https://example.com');
  });

  it('bare /tabs is unchanged — this node answers', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/tabs' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('tabs: 1');
  });

  it('a named node that IS ours runs here — /tabs=kg', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/tabs=kg' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('tabs: 1');
  });

  it('on a SHARED Beeper chat a named peer silences this node — /tabs=do', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/tabs=do' });
    await flush();
    expect(bridge.sent).toHaveLength(0);
  });

  // C3 (HANDOFF 2026-07-26): /members was the one operator command outside the set, so on a
  // shared Beeper account BOTH co-account nodes answered it — the very double-answer the gate
  // exists to end. Same gate, same allowlist, no second mechanism.
  it('REPRODUCE-FIRST: on a SHARED Beeper chat a named peer silences this node — /members=do', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/members=do' });
    await flush();
    expect(bridge.sent).toHaveLength(0);
  });

  it('bare /members is unchanged — this node still answers it', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/members' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)).toHaveLength(1);
  });
});

// ── 7. dispatch.default_node — a bare command falls back to a configured node ──────────────
describe('dispatch.default_node', () => {
  it('UNSET is a strict no-op: bare /status on the shell is unchanged (no envelope, local reply)', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/status' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('node_name: kg');
  });

  it('DEFECT 1 FIX: SET to a peer — a bare /tabs on the shell travels there with the node bound EXPLICITLY to the token', async () => {
    // Live miss (2026-07-27): the ORIGIN resolved default_node but forwarded the ORIGINAL bare
    // body — the responder's own dispatch.default_node is unset, so its nodeCommandForMe
    // re-parsed "/tabs" as unaddressed and fell through to the being. Resolution happens ONCE,
    // here, and must travel explicitly: "/tabs" becomes "/tabs=do" on the wire.
    const config = { ...KG(), dispatch: { default_node: 'do' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/tabs' });
    await flush();
    const envs = envelopes(bridge);
    expect(envs).toHaveLength(1);
    expect(envs[0].chat).toBe('egpt-mesh-do-kg');
    expect(parseMesh(envs[0].text).body).toBe('/tabs=do');   // EXPLICIT — not the bare original
  });

  it('REPRODUCE-FIRST: the explicit wire form the responder receives resolves as a command there too — the being is NEVER reached', async () => {
    // Full round trip: kg has dispatch.default_node: do; do does NOT (its own default_node is
    // unset, exactly the live config). Before the fix this reached do's being (CLAUDE Code's own
    // "/stats" answered instead of egpt); after the fix, do's own nodeCommandForMe accepts the
    // explicit "/tabs=do" on its own terms, with no knowledge of kg's config required.
    const kg = nodeStack({ config: { ...KG(), dispatch: { default_node: 'do' } } });
    await kg.spine.handleInbound({ ...SHELL, body: '/tabs' });
    await flush();
    const envs = envelopes(kg.bridge);
    expect(envs).toHaveLength(1);

    const doNode = nodeStack({ config: DO() });
    await doNode.spine.handleInbound({
      surface: 'whatsapp', node: 'wa', chatId: 'egpt-mesh-do-kg', chatName: 'mesh',
      senderId: 'u-an', senderName: 'An', msgId: 'q1', ts: 3, kind: 'text', raw: {},
      authorized: true, isSender: true, body: envs[0].text,
    });
    await flush();
    expect(doNode.brain.calls).toHaveLength(0);   // THE assertion: the brain is never called
    const relayReplies = doNode.bridge.sent.filter((s) => s.chat === 'egpt-mesh-do-kg' && parseMesh(s.text)?.done);
    expect(relayReplies).toHaveLength(1);
    expect(parseMesh(relayReplies[0].text).body).toContain('tabs: 1');
  });

  it('SET to THIS node\'s own name: identical to local — no envelope, this node answers', async () => {
    const config = { ...KG(), dispatch: { default_node: 'kg' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/tabs' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('tabs: 1');
  });

  it('bare /chrome reports (not the discovery hint) when default_node names this node', async () => {
    const config = { ...KG(), dispatch: { default_node: 'kg' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/chrome' });
    await flush();
    expect(plain(bridge)[0].text).toContain('attached: 127.0.0.1:9221');
  });

  it('/open <url> travels to default_node too — an ARGUMENT is not a node of its own, so the fallback still applies', async () => {
    // Was: "UNTOUCHED even with default_node set". Ruling 2026-07-27 corrected this — an
    // argument-bearing command that names no node of its own still falls through to
    // dispatch.default_node, exactly like a bare command does.
    const config = { ...KG(), dispatch: { default_node: 'do' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/open https://example.com' });
    await flush();
    const envs = envelopes(bridge);
    expect(envs).toHaveLength(1);
    expect(envs[0].chat).toBe('egpt-mesh-do-kg');
    expect(parseMesh(envs[0].text).body).toBe('/open=do https://example.com');   // EXPLICIT, argument carried along
  });

  it('REPRODUCE-FIRST: /members add tab 3 cgpt (arguments present) still resolves through default_node and travels explicitly', async () => {
    const config = { ...KG(), dispatch: { default_node: 'do' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/members add tab 3 cgpt' });
    await flush();
    const envs = envelopes(bridge);
    expect(envs).toHaveLength(1);
    expect(envs[0].chat).toBe('egpt-mesh-do-kg');
    expect(parseMesh(envs[0].text).body).toBe('/members=do add tab 3 cgpt');
  });

  it('UNSET is a strict no-op with arguments present too: /members add tab 3 cgpt stays local', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/members add tab 3 cgpt' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
  });

  it('SET to THIS node\'s own name behaves local for a command WITH arguments too', async () => {
    const config = { ...KG(), dispatch: { default_node: 'kg' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/members add tab 3 cgpt' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
  });

  it('an explicit =<node> on a command WITH arguments still wins over default_node', async () => {
    const config = { ...KG(), dispatch: { default_node: 'do' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/members=kg add tab 3 cgpt' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);   // kg is OUR own node — resolved locally, not forwarded
  });

  it('/chrome\'s positional-node form still wins over a DIFFERENT default_node', async () => {
    const config = { ...KG(), dispatch: { default_node: 'other' } };
    const { bridge, spine } = nodeStack({ config });
    await spine.handleInbound({ ...SHELL, body: '/chrome do' });
    await flush();
    const envs = envelopes(bridge);
    expect(envs).toHaveLength(1);
    expect(envs[0].chat).toBe('egpt-mesh-do-kg');
    expect(parseMesh(envs[0].text).body).toBe('/chrome do');   // unchanged — already explicit, not rewritten
  });
});
