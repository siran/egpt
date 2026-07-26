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
import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/spine/commands.mjs';
import { createMeshService } from '../src/spine/mesh.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

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
    carol: [{ path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } }],
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
function nodeStack({ config, cdp = LIVE_CDP } = {}) {
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

const SHELL = { surface: 'shell', node: 'sh', chatId: 'main', chatName: 'shell', senderId: 'operator', senderName: 'operator', msgId: null, ts: 1, kind: 'text', authorized: true, raw: {} };
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
    expect(bridge.statusPosts.map((p) => p.chat)).toEqual(['main']);
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

    const home = bridge.streams.filter((s) => s.chat === 'main');
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
    expect(plain(bridge)[0]).toMatchObject({ chat: 'main' });
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
    expect(plain(bridge)[0].chat).toBe('main');
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
    config.agents.carol = [
      { path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } },
      { path2: { relay_channel: 'egpt-mesh-do-kg', network: 'telegram', to: 'don.do' } },
    ];
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

  it('a DISABLED agent is not a route', async () => {
    const config = KG();
    delete config.agents.carol;
    config.agents.don.enabled = false;
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

  it('runs the command (NOT the being) and streams the reply home inside the envelope', async () => {
    const { bridge, brain, spine } = nodeStack({ config: DO() });
    await spine.handleInbound(request('/chrome do'));
    await flush();
    expect(brain.calls).toHaveLength(0);                       // the being never saw it
    const relayStream = bridge.streams.filter((s) => s.chat === 'egpt-mesh-do-kg');
    expect(relayStream).toHaveLength(1);
    const finalFrame = parseMesh(relayStream[0].finals.at(-1));
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

  it('a command addressed at ANOTHER node is not executed here', async () => {
    const { brain, spine, bridge } = nodeStack({ config: DO() });
    await spine.handleInbound(request('/chrome kg'));
    await flush();
    expect(brain.calls).toHaveLength(1);                       // not ours → ordinary relayed text
    const relayStream = bridge.streams.filter((s) => s.chat === 'egpt-mesh-do-kg');
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
    const relayStream = bridge.streams.filter((s) => s.chat === 'egpt-mesh-do-kg');
    expect(parseMesh(relayStream[0].finals.at(-1)).body).toMatch(/not authorized/i);
  });

  it('the reply can never itself parse as a command (the flood fix holds over the mesh)', async () => {
    // `/tabs` answers with a fenced list; every reply this module emits goes out through the
    // ONE chokepoint that backticks a leading command token, so the body the ORIGIN posts into
    // its chat cannot start with '/'.
    const { bridge, spine } = nodeStack({ config: DO(), cdp: { ...LIVE_CDP, listTabs: async () => { throw new Error('no chrome'); } } });
    await spine.handleInbound(request('/tabs do'));
    await flush();
    const relayStream = bridge.streams.filter((s) => s.chat === 'egpt-mesh-do-kg');
    const body = parseMesh(relayStream[0].finals.at(-1)).body;
    expect(body.trimStart().startsWith('/')).toBe(false);
  });
});

// ── 6. THE BROWSER FAMILY IS NODE-ADDRESSABLE (and gated by the SAME helper) ───────────────
describe('the node-addressable set — the browser family + /status + /members', () => {
  for (const [line, chat] of [['/tabs do', 'egpt-mesh-do-kg'], ['/open https://x.com do', 'egpt-mesh-do-kg'], ['/tab 1 do', 'egpt-mesh-do-kg'], ['/close 1 do', 'egpt-mesh-do-kg'], ['/status do', 'egpt-mesh-do-kg'], ['/members do', 'egpt-mesh-do-kg']]) {
    it(`${line} on the shell travels to do`, async () => {
      const { bridge, spine } = nodeStack({ config: KG() });
      await spine.handleInbound({ ...SHELL, body: line });
      await flush();
      const envs = envelopes(bridge);
      expect(envs).toHaveLength(1);
      expect(envs[0].chat).toBe(chat);
      expect(parseMesh(envs[0].text).body).toBe(line);
    });
  }

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

  it('a named node that IS ours runs here — /tabs kg', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/tabs kg' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('tabs: 1');
  });

  it('on a SHARED Beeper chat a named peer silences this node — /tabs do', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/tabs do' });
    await flush();
    expect(bridge.sent).toHaveLength(0);
  });

  // C3 (HANDOFF 2026-07-26): /members was the one operator command outside the set, so on a
  // shared Beeper account BOTH co-account nodes answered it — the very double-answer the gate
  // exists to end. Same gate, same allowlist, no second mechanism.
  it('REPRODUCE-FIRST: on a SHARED Beeper chat a named peer silences this node — /members do', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/members do' });
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
