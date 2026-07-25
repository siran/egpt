// ONE mention matcher + router FAN-OUT (operator 2026-07-25: "evict that hallucinated
// distinction between agent and persona. they're all agents, agents can have persona-lities").
//
// Before this: TWO mention systems. The BRIDGE scanned anywhere + stripped code fences but
// only ever knew the PERSONA's wake words; the ROUTER matched a LEADING @token on RAW text
// against the agents registry and returned the FIRST hit. Live consequences, both real:
//   · `@e and @don you here?` woke ONLY e — the router matched the leading token and stopped.
//   · an `@agent` mid-sentence was invisible.
// Now ONE matcher (`addressed`) runs over the node's WHOLE addressable set — every agent's
// map key + its handles — with the persona's own code-fence + word-boundary rules, and
// resolve() returns EVERY addressed agent so the spine can fan out.
import { describe, it, expect } from 'vitest';
import { createRouter, addressed } from '../src/spine/router.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { replyAllowed } from '../src/auto-mode.mjs';

const ev = (body, extra = {}) => ({
  body,
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
  ...extra,
});

// The live shape: a persona agent, a route-direct relay (`don`), a second LOCAL agent,
// a multipath list agent, a surface-pinned relay, and a disabled one.
const AGENTS = {
  egpt:  { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true },
  don:   { configuration: 'relay', relay_channel: 'egpt-mesh-do-kg', to: 'don.do' },
  wren:  { configuration: 'sonnet-high' },
  carol: [{ path1: { relay_channel: 'rodz1', network: 'whatsapp' } }, { path2: { relay_channel: 'egpt-mesh' } }],
  pinned: { configuration: 'relay', relay_channel: 'shell-only', surface: 'shell' },
  off:   { configuration: 'sonnet-high', enabled: false },
  _note: 'a comment key, never routable',
};
const arouter = createRouter({ getAgents: () => AGENTS, defaultBeing: 'egpt' });

describe('REPRODUCE-FIRST — the two live failures', () => {
  it('`@e and @don you here?` addresses BOTH — a local being AND a mesh target from one message', () => {
    const r = arouter.resolve(ev('@e and @don you here?'));
    expect(r.targets).toHaveLength(2);
    expect(r.targets[0]).toMatchObject({ being: 'egpt' });          // the persona takes its turn
    expect(r.targets[0].mesh).toBeUndefined();
    expect(r.targets[1].being).toBeNull();                          // …and don is relayed
    expect(r.targets[1].mesh).toEqual({ being: 'don', route: { room_id: 'egpt-mesh-do-kg' }, to: 'don.do' });
  });

  it('an @agent MID-SENTENCE is addressed (only a LEADING token was, before)', () => {
    const r = arouter.resolve(ev('oye @don, ¿estás?'));
    expect(r.targets.map((t) => t.mesh?.being)).toEqual(['don']);
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don', route: { room_id: 'egpt-mesh-do-kg' }, to: 'don.do' });
  });

  it('an @agent inside a CODE FENCE addresses NOBODY (the protection 47caf19 gave the persona)', () => {
    const fenced = arouter.resolve(ev('mira:\n```yaml\nagents: { don: relay }   # @don is the relay\n```\n'));
    expect(fenced.targets).toHaveLength(1);
    expect(fenced.being).toBe('egpt');      // falls through to the default agent
    expect(fenced.mesh).toBeUndefined();
    // …and an inline code span too
    const inline = arouter.resolve(ev('`@don` is how you reach him'));
    expect(inline.mesh).toBeUndefined();
    expect(inline.being).toBe('egpt');
  });
});

describe('addressed() — ONE matcher over the whole addressable set', () => {
  it('returns hits in TEXT ORDER, deduped by agent, with atStart/anywhere', () => {
    const hits = addressed('@don ping, and @e too, @don again', AGENTS);
    expect(hits.map((h) => h.name)).toEqual(['don', 'egpt']);
    expect(hits[0]).toMatchObject({ atStart: true, anywhere: true });
    expect(hits[1]).toMatchObject({ atStart: false, anywhere: true });
  });

  it('matches an agent by its map KEY or any of its handles (the same set findAgent uses)', () => {
    expect(addressed('@egpt hola', AGENTS).map((h) => h.name)).toEqual(['egpt']);
    expect(addressed('@e hola', AGENTS).map((h) => h.name)).toEqual(['egpt']);
    expect(addressed('@wren hola', AGENTS).map((h) => h.name)).toEqual(['wren']);
    expect(addressed('@carol hola', AGENTS).map((h) => h.name)).toEqual(['carol']);   // list-shaped agent, by key
  });

  it('needs a real mention token: glued (me@e.com) and unknown/disabled/_note tokens never match', () => {
    expect(addressed('write me@e.com please', AGENTS)).toEqual([]);
    expect(addressed('hey@egpt', AGENTS)).toEqual([]);
    expect(addressed('@nobody @off @_note', AGENTS)).toEqual([]);
  });

  it('a hyphen/dot boundary: @don.do finds don (the token stops at the dot); @don-x finds NOBODY', () => {
    expect(addressed('@don.do do X', AGENTS).map((h) => h.name)).toEqual(['don']);
    expect(addressed('@don-x do X', AGENTS)).toEqual([]);     // not a registered agent — not `don`
  });

  it('case-insensitive', () => {
    expect(addressed('@DON and @E', AGENTS).map((h) => h.name)).toEqual(['don', 'egpt']);
  });

  it('no agents / no @ → no hits', () => {
    expect(addressed('@don ping', {})).toEqual([]);
    expect(addressed('just talking', AGENTS)).toEqual([]);
  });
});

describe('LOCKS — every current resolve() semantic survives the fan-out', () => {
  it('a bare message with no @mention still reaches the default agent, ev.mention untouched', () => {
    const m = { atEStart: false, atEAnywhere: false, replyToBot: true };
    const r = arouter.resolve(ev('hola que tal', { mention: m }));
    expect(r.being).toBe('egpt');
    expect(r.mesh).toBeUndefined();
    expect(r.mention).toBe(m);
    expect(r.targets).toHaveLength(1);
  });

  it('the DEFAULT agent keeps ev.mention; every other addressed agent carries its OWN REAL flags', () => {
    const m = { atEStart: true, atEAnywhere: true, replyToBot: false };
    const r = arouter.resolve(ev('@e and @wren and @don', { mention: m }));
    expect(r.targets.map((t) => t.being)).toEqual(['egpt', 'wren', null]);
    expect(r.targets[0].mention).toBe(m);                                                    // persona: bridge-computed, untouched
    // NOT a blanket constant (operator 2026-07-25: "respect the mode, if it's mention-direct not
    // the same as mention"): both are named MID-SENTENCE, so atEStart is honestly false.
    expect(r.targets[1].mention).toEqual({ atEStart: false, atEAnywhere: true, replyToBot: false });
    expect(r.targets[2].mention).toEqual({ atEStart: false, atEAnywhere: true, replyToBot: false });
  });

  it('a LEADING @name still yields exactly the old flags ({ atEStart: true, atEAnywhere: true })', () => {
    expect(arouter.resolve(ev('@don ping')).mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });
    expect(arouter.resolve(ev('@wren ping')).mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });
    expect(arouter.resolve(ev('@carol ping')).mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });
  });

  it('a multipath (list-shaped) agent still resolves to ALL its paths', () => {
    const r = arouter.resolve(ev('@carol hola'));
    expect(r.mesh).toEqual({
      being: 'carol',
      paths: [
        { route: { room_id: 'rodz1', network: 'whatsapp' }, label: 'path1' },
        { route: { room_id: 'egpt-mesh' }, label: 'path2' },
      ],
    });
  });

  it('a surface-PINNED agent is addressed only on its pinned surface — off it, it is not a target at all', () => {
    expect(arouter.resolve(ev('@pinned hi', { surface: 'shell' })).mesh).toEqual({ being: 'pinned', route: { room_id: 'shell-only' } });
    const off = arouter.resolve(ev('@pinned hi', { surface: 'whatsapp' }));
    expect(off.mesh).toBeUndefined();
    expect(off.being).toBe('egpt');
    expect(off.targets).toHaveLength(1);
    // and it does not swallow the OTHER agents addressed in the same message
    const mixed = arouter.resolve(ev('@pinned and @don', { surface: 'whatsapp' }));
    expect(mixed.targets.map((t) => t.mesh?.being)).toEqual(['don']);
  });

  it('an unknown / disabled @token alone still falls through to the default agent', () => {
    expect(arouter.resolve(ev('@nobody hi')).being).toBe('egpt');
    expect(arouter.resolve(ev('@off hi')).being).toBe('egpt');
  });
});

// ── the SPINE fan-out: every local being dispatched, every mesh target forwarded, from ONE
//    message. The two paths are independent — a local agent takes a turn, a relay agent posts
//    an envelope and waits — so neither sequences the other. ──
const MSG = { surface: 'wa', node: 'wa', chatId: 'CHAT', chatName: 'fam', senderId: 'u', senderName: 'An', msgId: 'm1', ts: 1, kind: 'text', raw: {} };

function fanoutSpine({ router = arouter, mayReply = true, mode = null, gating = null } = {}) {
  const bridge = { sent: [], onMessage() {}, send(chat, text) { this.sent.push({ chat, text }); }, stop() {} };
  const brain = { calls: [], async turn(being, e) { this.calls.push({ being, body: e.body }); return { text: `↩ ${e.body}`, sessionId: 's1' }; } };
  const transcript = { entries: [], async log(e, r, opts = {}) { this.entries.push({ ev: e, r, opts }); } };
  const mesh = {
    handled: [], forwarded: [],
    isEnvelope: (e) => String(e.body).startsWith('ENV:'),
    async handle(e) { this.handled.push(e); },
    async forward(e, t) { this.forwarded.push({ ev: e, t }); return true; },
    async onEdit() { return false; },
  };
  const spine = createSpine({
    bridge, brain, mesh, transcript,
    identity: { build: (m) => ({ ...m }) },
    router,
    defaultBeing: 'egpt',
    // `mode` runs the REAL mode semantics (auto-mode.replyAllowed) over whatever mention each
    // target was handed — the seam that proves the fan-out feeds honest per-agent flags into
    // machinery that already knows what they mean. ONE mode governs every addressed agent here
    // and only the flags differ; `gating` swaps in the REAL gating service when a test needs
    // each agent to resolve its OWN mode. Without either: a flat mayReply.
    gating: gating ?? {
      async decide(being, e, mention) {
        if (!mode) return { mode: 'on', receives: true, mayReply, sendToEgpt: 'mode' };
        return { mode, receives: mode !== 'off', mayReply: replyAllowed(mode, mention ?? {}), sendToEgpt: 'mode' };
      },
      surfaces: (d) => d.mayReply,
    },
    sender: { open() { return { update() {}, activate() {}, fail() {}, async finish(reply, { surface = true } = {}) { const t = typeof reply === 'string' ? reply : reply?.text; if (surface && t) bridge.send('CHAT', t); } }; } },
    heartbeats: { runDue() {} },
    clock: { now: () => 1 },
  });
  return { spine, bridge, brain, transcript, mesh };
}

describe('spine — FAN OUT to every addressed agent', () => {
  it('REPRODUCE-FIRST: `@e and @don you here?` runs the local being AND forwards the mesh target', async () => {
    const { spine, brain, mesh } = fanoutSpine();
    await spine.handleInbound({ ...MSG, body: '@e and @don you here?' });
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(mesh.forwarded).toHaveLength(1);
    expect(mesh.forwarded[0].t).toMatchObject({ being: 'don', route: { room_id: 'egpt-mesh-do-kg' } });
  });

  it('two LOCAL agents in one message → BOTH beings take a turn', async () => {
    const { spine, brain } = fanoutSpine();
    await spine.handleInbound({ ...MSG, body: '@e and @wren, thoughts?' });
    expect(brain.calls.map((c) => c.being).sort()).toEqual(['egpt', 'wren']);
  });

  it('the inbound message is recorded ONCE, however many agents it addressed', async () => {
    const { spine, transcript } = fanoutSpine();
    await spine.handleInbound({ ...MSG, body: '@e and @wren and @don' });
    // one inbound append (the spine's single ingestion point), then one append per reply
    expect(transcript.entries.filter((e) => e.r == null)).toHaveLength(1);
    expect(transcript.entries[0].r).toBeUndefined();     // …and it is the FIRST thing written
  });

  it('LOCK: a bare message still runs exactly the default agent, once', async () => {
    const { spine, brain, mesh } = fanoutSpine();
    await spine.handleInbound({ ...MSG, body: 'just a normal message' });
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(mesh.forwarded).toHaveLength(0);
  });

  it('LOCK: a mesh ENVELOPE bypasses the matcher entirely — addressing already happened at the origin node', async () => {
    const { spine, brain, mesh, transcript } = fanoutSpine();
    await spine.handleInbound({ ...MSG, body: 'ENV: @e and @don and @wren — relay traffic' });
    expect(mesh.handled).toHaveLength(1);
    expect(mesh.forwarded).toHaveLength(0);      // the @don in the envelope body never routed
    expect(brain.calls).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);
  });

  // THE CRUX of the fan-out (operator 2026-07-25: "'router returns all addressed' respect the
  // mode, if it's mention-direct not the same as mention. nothing has changed"). The flags are
  // real per agent, so the EXISTING mode vocabulary keeps its meaning: fanning out must not turn
  // a mention-direct chat into a mention chat for the agents named after the first word.
  // (the persona's own flags still ride in on ev.mention — the bridge computes them from its
  //  wake words, by the SAME rules; only the other agents' flags come from the router's matcher)
  const AT_HEAD = { atEStart: true, atEAnywhere: true, replyToBot: false };
  const MID     = { atEStart: false, atEAnywhere: true, replyToBot: false };

  it('MODE-HONEST: in a mention-direct chat, `@e and @don` wakes ONLY the agent named at the head', async () => {
    const { spine, brain, mesh } = fanoutSpine({ mode: 'mention-direct' });
    await spine.handleInbound({ ...MSG, body: '@e and @don you here?', mention: AT_HEAD });
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);   // @e leads → mention-direct admits it
    expect(mesh.forwarded).toHaveLength(0);                      // @don mid-sentence → it does NOT
  });

  it('MODE-HONEST: the mirror — `@don and @e` in the SAME mention-direct chat wakes don, not e', async () => {
    const { spine, brain, mesh } = fanoutSpine({ mode: 'mention-direct' });
    await spine.handleInbound({ ...MSG, body: '@don and @e you here?', mention: MID });
    expect(mesh.forwarded).toHaveLength(1);
    expect(brain.calls).toHaveLength(0);
  });

  it('MODE-HONEST: the same message in a plain `mention` chat wakes BOTH (anywhere is enough)', async () => {
    const { spine, brain, mesh } = fanoutSpine({ mode: 'mention' });
    await spine.handleInbound({ ...MSG, body: '@e and @don you here?', mention: AT_HEAD });
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(mesh.forwarded).toHaveLength(1);
  });

  it('LOCK: gated out (mayReply=false) → nothing is dispatched and nothing is forwarded', async () => {
    const { spine, brain, mesh } = fanoutSpine({ mayReply: false });
    await spine.handleInbound({ ...MSG, body: '@e and @don you here?' });
    expect(brain.calls).toHaveLength(0);
    expect(mesh.forwarded).toHaveLength(0);
  });
});

// ── a RELAY agent resolves its OWN mode (operator 2026-07-25: per-agent mode in config.yaml) ──
//
// REPRODUCE-FIRST. A mesh target routes with `being: null`, so the spine gated it as the PERSONA
// (`t.being ?? defaultBeing`): `@don` could not have a mode of its own — it borrowed @e's. The
// router already carries the relay agent's NAME on the mesh descriptor (`t.mesh.being`), so the
// gate now asks for THAT agent's mode. Real gating service, real config: the modes below are the
// per-agent rung, nothing per-conversation.
describe('spine — a RELAY target is gated as its OWN agent', () => {
  const gatingWith = (agents) => createGating({ getConfig: () => ({ agents }), loadState: null, defaultKey: 'egpt' });
  const MID_M = { atEStart: false, atEAnywhere: true, replyToBot: false };

  it('e:mention + don:mention-direct — a MID-SENTENCE @don stays silent while the MID-SENTENCE @e answers', async () => {
    const gating = gatingWith({ egpt: { default: true, mode: 'mention' }, don: { relay_channel: 'egpt-mesh-do-kg', mode: 'mention-direct' } });
    const { spine, brain, mesh } = fanoutSpine({ gating });
    await spine.handleInbound({ ...MSG, body: 'oye @e y @don, ¿están?', mention: MID_M });
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);   // e is 'mention' → mid-sentence is enough
    expect(mesh.forwarded).toHaveLength(0);                      // don is 'mention-direct' → it is NOT
  });

  it('…and with @don at the HEAD of the same chat, don wakes and e still answers', async () => {
    const gating = gatingWith({ egpt: { default: true, mode: 'mention' }, don: { relay_channel: 'egpt-mesh-do-kg', mode: 'mention-direct' } });
    const { spine, brain, mesh } = fanoutSpine({ gating });
    await spine.handleInbound({ ...MSG, body: '@don y @e, ¿están?', mention: MID_M });
    expect(mesh.forwarded).toHaveLength(1);
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('the PRIMARY target too: a muted relay agent is not forwarded even when named at the head', async () => {
    const gating = gatingWith({ egpt: { default: true, mode: 'mention' }, don: { relay_channel: 'egpt-mesh-do-kg', mode: 'mute' } });
    const { spine, brain, mesh } = fanoutSpine({ gating });
    await spine.handleInbound({ ...MSG, body: '@don ping', mention: { atEStart: false, atEAnywhere: false, replyToBot: false } });
    expect(mesh.forwarded).toHaveLength(0);
    expect(brain.calls).toHaveLength(0);
  });
});
