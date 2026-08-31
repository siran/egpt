// router.resolve — @token routing off the unified `agents:` registry (new-config-only,
// operator 2026-07-02). A leading @token matches an agent's name or any handle: a LOCAL
// agent routes to its own being, a RELAY agent to a mesh route-direct target, the PERSONA
// agent to the canonical being 'e'. A qualified @being.node reaches another machine (mesh).
// Everything else falls through to E.
import { describe, it, expect } from 'vitest';
import { SHELL_SURFACE } from '../src/spine/identity.mjs';
import { createRouter, addressed, voiceWakeTokens, fallbackWake, wakeTokens } from '../src/spine/router.mjs';
// THE REAL GATE + THE REAL BRIDGE COMPUTATION — the fallback_handle-on-the-persona block at the
// end of this file asserts on a REPLY, not just a route, so it needs both: mentionStatus is what
// the limb runs over the persona wake set to produce ev.mention, replyAllowed is what
// gating.decide runs over the ROUTED mention to decide whether the reply is emitted at all.
import { mentionStatus, replyAllowed } from '../src/auto-mode.mjs';

const ev = (body, mention) => ({
  body,
  mention: mention ?? { atEStart: false, atEAnywhere: false, replyToBot: false },
});

describe('router.resolve — agents registry (operator 2026-07-02)', () => {
  // The operator's exact shape: a persona agent (handles e/egpt) + a relay agent, plus
  // a local (non-persona) agent to prove being = its own name.
  const agents = {
    egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true },   // persona (default:true)
    don:  { configuration: 'relay', relay_channel: 'Rodz' },          // relay → chat "Rodz"
    'don-tg': { configuration: 'relay', relay_channel: 'Rodz', network: 'Telegram' },   // relay → chat "Rodz" pinned to telegram
    'don-local': { configuration: 'sonnet-high', name: 'Don' },       // local being, hyphenated name
    off:  { configuration: 'sonnet-high', enabled: false },           // `enabled` is INERT — routes like any other
    _note: 'a comment key, never routable',
  };
  // boot injects defaultBeing = the default agent's KEY ('egpt' here). The persona routes to
  // its own key now (operator 2026-07-10 — no hardcoded 'e').
  const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });

  it('@e (persona handle) → the persona KEY "egpt", ev.mention preserved', async () => {
    const m = { atEStart: true, atEAnywhere: true, replyToBot: false };
    const r = await arouter.resolve(ev('@e hola', m));
    expect(r.being).toBe('egpt');    // the persona being-id IS its map key
    expect(r.mesh).toBeUndefined();
    expect(r.mention).toBe(m);       // persona keeps the bridge-computed mention
  });

  it('@egpt (persona name key) also → being "egpt"', async () => {
    expect((await arouter.resolve(ev('@egpt yo'))).being).toBe('egpt');
  });

  it('a LOCAL agent @don-local → being "don-local" with a synthetic mention', async () => {
    const r = await arouter.resolve(ev('@don-local do X'));
    expect(r.being).toBe('don-local');
    expect(r.mesh).toBeUndefined();
    expect(r.mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });   // a direct @name synthesizes an addressed mention
  });

  it('a RELAY agent @don → a mesh target routed by relay_channel (route-direct), no local being', async () => {
    const r = await arouter.resolve(ev('@don ping'));
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
    expect(r.mention).toMatchObject({ atEStart: true });
  });

  it('a RELAY agent with a network pin carries lowercased network on the mesh route (operator 2026-07-06: same name on two networks)', async () => {
    const r = await arouter.resolve(ev('@don-tg ping'));
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don-tg', route: { room_id: 'Rodz', network: 'telegram' } });
    // regression: an UNPINNED relay agent's route carries NO network key (asserted above via toEqual on @don)
  });

  it('case-insensitive on handles and names: @Don-Local → don-local, @DON → relay target', async () => {
    expect((await arouter.resolve(ev('@Don-Local hi'))).being).toBe('don-local');
    expect((await arouter.resolve(ev('@DON hi'))).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
  });

  // Operator 2026-07-26: "disabling is just commenting the config. no need to have or check an
  // enabled key in this case." The agent-level `enabled` check was evicted as dead code — no live
  // agent ever carried the key — so an entry that does carry it is an ordinary agent. The REAL
  // disable mechanisms are still locked below: a `_`-prefixed comment key, and commenting the
  // agent out entirely (an absent key routes nowhere).
  it('an `enabled: false` key is INERT — the agent routes like any other; a _note key never routes', async () => {
    expect((await arouter.resolve(ev('@off hi'))).being).toBe('off');
    expect((await arouter.resolve(ev('@_note hi'))).being).toBe('egpt');
  });

  it('an unknown @token falls through to the persona (defaultBeing)', async () => {
    expect((await arouter.resolve(ev('@nobody hi'))).being).toBe('egpt');
  });

  it('no agents block → always defaultBeing (no local beings without a registry)', async () => {
    const bare = createRouter({ defaultBeing: 'egpt' });
    expect((await bare.resolve(ev('@wren do X'))).being).toBe('egpt');
  });

  // KEY-AS-BEING (operator 2026-07-10): the resolved persona being IS the default agent's
  // KEY, matched by the `default: true` marker — NOT the 'e'/'egpt' strings. A config whose
  // persona is keyed `assistant` (handles [a]) resolves to `assistant`; a renamed key routes
  // to the new key.
  //
  // UPDATED 2026-07-26 (handles are the wake list, the key is not): `@assistant` is no longer a
  // WAKE token — the persona declares handles [a], so [a] is the complete list. It is asserted on
  // `addressed` (which sees the real miss) rather than on resolve(), where an unmatched @token
  // falls through to the persona and would make the assertion vacuous. The key is still the
  // BEING-ID every hit resolves TO.
  it('persona resolution follows `default: true`, not e/egpt: key "assistant" (handles [a]) → being "assistant"', async () => {
    const ag = { assistant: { configuration: 'sonnet-high', handles: ['a'], default: true }, don: { configuration: 'relay', relay_channel: 'Rodz' } };
    const r = createRouter({ getAgents: () => ag, defaultBeing: 'assistant' });
    expect((await r.resolve(ev('@a hola'))).being).toBe('assistant');          // matched via handle → its key (the being-id)
    expect(addressed('@assistant hola', ag)).toEqual([]);              // the KEY is not a wake token (handles declared)
    expect((await r.resolve(ev('@nobody hi'))).being).toBe('assistant');       // fall-through → the persona key
    expect((await r.resolve(ev('@don ping'))).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });  // a non-default agent still routes normally
  });
});

// ── MULTIPATH (operator 2026-07-06: multipath is configuration — an agent declares a LIST of
//    paths under `paths:`, every message through every path). Each element is a SINGLE-KEY map
//    { <label>: { relay_channel, network?, to? } }. The router resolves it to a mesh target
//    carrying ALL paths; the scalar (no-`paths:`) relay shape stays byte-for-byte unchanged
//    (regression below). The agent itself is an ordinary MAP since 2026-07-26 — the list used to
//    be the agent VALUE, which left it nowhere to declare `handles:`. ──
describe('router.resolve — multi-path relay agent (operator 2026-07-06)', () => {
  const agents = {
    carol: { paths: [
      { path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } },
      { path2: { relay_channel: 'egpt-mesh', network: 'telegram', to: 'don.do' } },
    ] },
    egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'] },
    don:  { configuration: 'relay', relay_channel: 'Rodz' },   // scalar relay — regression neighbor
  };
  const arouter = createRouter({ getAgents: () => agents });

  it('@carol → a mesh target carrying EVERY path (route+network pin+to+label), no local being', async () => {
    const r = await arouter.resolve(ev('@carol hola'));
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({
      being: 'carol',
      paths: [
        { route: { room_id: 'rodz1', network: 'whatsapp' }, to: 'don.do', label: 'path1' },
        { route: { room_id: 'egpt-mesh', network: 'telegram' }, to: 'don.do', label: 'path2' },
      ],
    });
    expect(r.mention).toMatchObject({ atEStart: true });
  });

  it('REGRESSION: the scalar relay @don is UNCHANGED (no paths key, single route)', async () => {
    expect((await arouter.resolve(ev('@don ping'))).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
  });

  it('case-insensitive on a multipath agent name: @CAROL still fans out', async () => {
    expect((await arouter.resolve(ev('@CAROL hi'))).mesh.being).toBe('carol');
  });
});

// ── SURFACE PIN (operator 2026-07-25: `@don` from the operator shell relays over the mesh, but
//    `@don` on Beeper is left alone). An agent may carry `surface: <name>` so it is treated as an
//    agent ONLY on that surface; on any OTHER surface the @mention falls through (as if unmatched).
//    CORRECTNESS, not convenience: `do` and `kg` share ONE Beeper account, so on Beeper `do` hears
//    `@don` DIRECTLY and answers it — kg must NOT also relay it. kg relays `don` ONLY from the shell
//    (which `do` can't hear), so kg pins its `don` relay agent `surface: shell`.
//    The pin names a NETWORK; since 2026-08-28 the shell network resolves to surface `room`,
//    and BOTH sides of the comparison go through that one map — so the operator's config is
//    unchanged and still matches. ──
describe('router.resolve — surface-pinned relay agent (operator 2026-07-25)', () => {
  const agents = {
    egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true },
    don:  { configuration: 'relay', relay_channel: 'egpt-mesh-do-kg', to: 'don.do', surface: 'shell' },   // relay ONLY on the shell surface
  };
  const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
  const evS = (body, surface) => ({ ...ev(body), surface });

  it('@don on the SHELL surface → the mesh relay (its pinned surface matches)', async () => {
    const r = await arouter.resolve(evS('@don ping', SHELL_SURFACE));   // the surface the shell network resolves to
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don', route: { room_id: 'egpt-mesh-do-kg' }, to: 'don.do' });
    expect(r.mention).toMatchObject({ atEStart: true });
  });

  it('REPRODUCE-FIRST: @don on the WHATSAPP surface does NOT relay (surface mismatch → falls through to the persona)', async () => {
    // On CURRENT (pre-fix) code the agent matches regardless of surface → wrongly relays on Beeper,
    // double-answering the message `do` already heard directly. After the surface gate: falls through.
    const r = await arouter.resolve(evS('@don ping', 'whatsapp'));
    expect(r.mesh).toBeUndefined();     // NOT relayed on Beeper — `do` answers @don directly
    expect(r.being).toBe('egpt');       // falls through to the persona (defaultBeing)
  });

  it('an UNPINNED relay agent is surface-agnostic (regression: no surface key → matches on any surface)', async () => {
    const ag = { egpt: { handles: ['e'], default: true }, don: { configuration: 'relay', relay_channel: 'Rodz' } };
    const r = createRouter({ getAgents: () => ag, defaultBeing: 'egpt' });
    expect((await r.resolve({ ...ev('@don ping'), surface: 'whatsapp' })).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
    expect((await r.resolve({ ...ev('@don ping'), surface: 'shell' })).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
  });
});

// ── EVICTION (operator 2026-07-25): `mesh.nodes` and with it the bare `@being.node` routing
//    scheme are gone. The router no longer mints a `{ being, node }` target — that shape carried
//    no route, so nothing could ever carry it. Reaching another machine is AGENT-BASED: a relay
//    agent's relay_channel IS the route. `@don.do` still works when `don` is a relay agent,
//    because the leading-@token match stops at the dot. ──
describe('router.resolve — @being.node addressing (mesh.nodes evicted)', () => {
  it('an unmatched qualified @being.node mints NO mesh target — it falls through to the persona', async () => {
    const r = await createRouter({ getAgents: () => ({}) }).resolve(ev('@don.do do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });

  it('a bare unknown @token → e (no mesh, no phantom)', async () => {
    const r = await createRouter({ getAgents: () => ({}) }).resolve(ev('@ghost do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });

  it('SURVIVES: @<relay-agent>.<node> routes route-direct through the agent (the @token stops at the dot)', async () => {
    const ag = { egpt: { handles: ['e'], default: true }, don: { relay_channel: 'Rodz', to: 'don.do' } };
    const r = await createRouter({ getAgents: () => ag, defaultBeing: 'egpt' }).resolve(ev('@don.do do X'));
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' }, to: 'don.do' });
    expect(r.mention).toMatchObject({ atEStart: true });     // it IS addressed → gates as a mention
  });
});

// ── WAKE VOCABULARY (operator 2026-07-26: "don must not wake or respond with 'egpt'" … "the key
//    has no bearing … the yaml key can be discarded, an agent reacts if its handle is invoked").
//
//    THE RULE: if `handles:` is declared it is the COMPLETE wake list and the map KEY is NOT a
//    token; if `handles:` is absent the key serves as the handle.
//
//    The key remains the BEING-ID — it keys warm sessions and the per-conversation entry[<being>]
//    thread blocks, and renaming it is a new identity (config-schema). ONLY the wake vocabulary
//    changed here.
//
//    THE LIVE BUG this reproduces: both spines answered ONE `@egpt` in a WhatsApp group — kg
//    stamped `egpt`, DOLLY stamped `don`. DOLLY's persona DISPLAYS as "don" but is still KEYED
//    `egpt`, and the key was a wake token alongside the handles, so `@egpt` woke both nodes. ──
describe('addressed() — handles are the wake list, the map key is not (operator 2026-07-26)', () => {
  // DOLLY's REAL shape: keyed `egpt`, wakes on [d, don], displays as "don".
  const DOLLY = { egpt: { configuration: 'egpt', handles: ['d', 'don'], default: true, name: 'don' } };
  // kg's REAL shape: keyed `egpt`, wakes on [e, egpt] — the key happens to BE a handle here.
  const KG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, name: 'egpt' } };

  it('REPRODUCE-FIRST: DOLLY (key `egpt`, handles [d, don]) does NOT wake on @egpt', () => {
    expect(addressed('@egpt hola', DOLLY)).toEqual([]);
  });

  it('DOLLY still wakes on its OWN handles @d and @don', () => {
    expect(addressed('@d hola', DOLLY).map((h) => h.name)).toEqual(['egpt']);       // handle → its BEING-ID (the key)
    expect(addressed('@don hola', DOLLY).map((h) => h.name)).toEqual(['egpt']);
  });

  it('kg (key `egpt`, handles [e, egpt]) still wakes on @e and @egpt — the key is in its handles', () => {
    expect(addressed('@e hola', KG).map((h) => h.name)).toEqual(['egpt']);
    expect(addressed('@egpt hola', KG).map((h) => h.name)).toEqual(['egpt']);
  });

  it('an agent with NO handles is addressed BY KEY (kg\'s relay agents, unchanged)', () => {
    const ag = { egpt: { handles: ['e', 'egpt'], default: true }, wren: { relay_channel: 'rodz3', to: 'ed.do' } };
    expect(addressed('@wren hola', ag).map((h) => h.name)).toEqual(['wren']);
  });

  // A MULTIPATH agent is an ARRAY of single-key path maps — there is nowhere to hang an
  // agent-level `handles:` key, so the key-as-handle fallback is LOAD-BEARING for `carol`
  // on the live kg node, not a back-compat courtesy. `[].handles` is undefined → fallback.
  it('a LIST-shaped multipath agent (no place for handles) still wakes by its KEY', () => {
    const ag = {
      egpt: { handles: ['e', 'egpt'], default: true },
      carol: [
        { path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } },
        { path2: { relay_channel: 'egpt-mesh-do-kg', network: 'telegram', to: 'don.do' } },
      ],
    };
    expect(addressed('@carol hola', ag).map((h) => h.name)).toEqual(['carol']);
  });

  // `handles: []` — DECIDED (this chunk): an EXPLICITLY EMPTY list is a COMPLETE wake list that
  // happens to be empty, so the agent is addressable by NO @token at all. It is not "absent":
  // absent means "undeclared, fall back to the key". Falling back on empty would make `handles: []`
  // silently mean the same as `handles: [<key>]` — reviving the very key-as-token bug this rule
  // removes — and would leave the operator no way to say "this agent has no @address".
  it('`handles: []` (explicitly empty) is addressable by NOTHING — not by its key either', () => {
    const ag = { egpt: { handles: ['e'], default: true }, silent: { configuration: 'sonnet-high', handles: [] } };
    expect(addressed('@silent hola', ag)).toEqual([]);
    expect(addressed('@egpt hola', ag)).toEqual([]);          // the persona's key is not a token either
    expect(addressed('@e hola', ag).map((h) => h.name)).toEqual(['egpt']);
  });
});

// ── A BARE HANDLE AT THE START ADDRESSES (operator 2026-07-27: "the '@' is not necessary at
//    the beginning … 'e ', 'd ', 'egpt ', 'don ', they are all handles, and it's easy to
//    write" … "d, must triger, but 'donde' must not" … "note: it work like mention direct --
//    the message has to start with keyword").
//
//    Nothing here is a second matcher: `addressed` still runs THE one scan (auto-mode.mjs
//    mentionHits) over the node's whole wake vocabulary, and the bare form reuses that
//    scan's existing _NOT_GLUED boundary. So the agent registry inherits the rule for free,
//    with every protection the @ form has (code fences, longest-token-first, the glued-token
//    rule) and the SAME per-agent { atStart, anywhere } flags the modes rest on. ──
describe('addressed() — a bare handle opening the message (operator 2026-07-27)', () => {
  const DOLLY = { egpt: { configuration: 'egpt', handles: ['d', 'don'], default: true, name: 'don' } };
  // kg's REAL live shape (config.yaml agents block): persona [e, egpt] + relay agents
  // carol / wren / cara / don, the last pinned `surface: shell`.
  const KG = {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, name: 'egpt' },
    carol: { handles: ['carol'], paths: [{ path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } }] },
    wren: { handles: ['wren'], relay_channel: 'rodz3', to: 'ed.do' },
    cara: { handles: ['cara'], relay_channel: 'rodz1', to: 'ed.do' },
    don: { handles: ['don'], surface: 'shell', to: 'don.do', relay_channel: 'egpt-mesh-do-kg', network: 'whatsapp' },
  };

  it('REPRODUCE-FIRST: `d hola` addresses DOLLY`s persona, atStart — same as @d hola', () => {
    expect(addressed('d hola', DOLLY)).toEqual([{ name: 'egpt', agent: DOLLY.egpt, atStart: true, anywhere: true }]);
    expect(addressed('d hola', DOLLY)).toEqual(addressed('@d hola', DOLLY));
  });
  it('REPRODUCE-FIRST: `d, ya vi` addresses it — a comma is a boundary', () => {
    expect(addressed('d, ya vi', DOLLY).map((h) => h.name)).toEqual(['egpt']);
  });
  it('REPRODUCE-FIRST: `donde está el archivo` addresses NOBODY', () => {
    expect(addressed('donde está el archivo', DOLLY)).toEqual([]);
  });
  it('REPRODUCE-FIRST: a bare handle mid-sentence addresses nobody (`vamos d luego`)', () => {
    expect(addressed('vamos d luego', DOLLY)).toEqual([]);
  });
  it('REPRODUCE-FIRST: `@d hola` is unchanged', () => {
    expect(addressed('@d hola', DOLLY)).toEqual([{ name: 'egpt', agent: DOLLY.egpt, atStart: true, anywhere: true }]);
  });

  it('longest-token-first across AGENTS: on kg `don ...` picks the don relay, not the persona`s e', () => {
    expect(addressed('don qué opinás', KG).map((h) => h.name)).toEqual(['don']);
    expect(addressed('e mirá esto', KG).map((h) => h.name)).toEqual(['egpt']);
    expect(addressed('egpt mirá esto', KG).map((h) => h.name)).toEqual(['egpt']);
    expect(addressed('wren ping', KG).map((h) => h.name)).toEqual(['wren']);
    expect(addressed('carol ping', KG).map((h) => h.name)).toEqual(['carol']);
  });

  it('a bare handle produces the SAME routing target as the @ form (mention included)', async () => {
    const router = createRouter({ getAgents: () => DOLLY, defaultBeing: 'egpt' });
    const bare = await router.resolve(ev('d hola'));
    const at = await router.resolve(ev('@d hola'));
    expect(bare.being).toBe('egpt');
    expect(bare.mention).toEqual(at.mention);
    expect(bare.targets).toEqual(at.targets);
  });

  it('a surface-pinned agent still drops out: kg`s `don Pedro…` on beeper falls through to the persona', async () => {
    const router = createRouter({ getAgents: () => KG, defaultBeing: 'egpt' });
    const beeper = await router.resolve({ ...ev('don Pedro me dijo que sí'), surface: 'beeper' });
    expect(beeper.targets).toEqual([{ being: 'egpt', mention: ev('x').mention }]);   // unmentioned persona → gated silent
    const shell = await router.resolve({ ...ev('don Pedro me dijo que sí'), surface: SHELL_SURFACE });
    expect(shell.mesh?.being).toBe('don');
  });

  // ── THE SWITCH (operator 2026-07-27: "this addressing without the '@' must be an option, easy
  //    to turn on/off globally") — `dispatch.address_without_at`, node rung, DEFAULT TRUE.
  //
  //    The agent registry is the matcher's OTHER caller, and it receives the flag by the SAME
  //    route as its wake list: boot injects it into createRouter beside getAgents, and resolve()
  //    hands it straight to `addressed`. Nothing is read from a config inside either function. ──
  describe('address_without_at: false — the bare form is OFF at the agent registry too', () => {
    const OFF = { addressWithoutAt: false };

    it('REPRODUCE-FIRST: `d hola` addresses NOBODY with the flag off; `@d hola` still does', () => {
      expect(addressed('d hola', DOLLY, OFF)).toEqual([]);
      expect(addressed('d, ya vi', DOLLY, OFF)).toEqual([]);
      expect(addressed('@d hola', DOLLY, OFF))
        .toEqual([{ name: 'egpt', agent: DOLLY.egpt, atStart: true, anywhere: true }]);
      expect(addressed('@d hola', DOLLY, OFF)).toEqual(addressed('@d hola', DOLLY));
    });
    it('REPRODUCE-FIRST: the ROUTER carries it — `wren ping` falls through to the persona, `@wren ping` does not', async () => {
      const off = createRouter({ getAgents: () => KG, defaultBeing: 'egpt', addressWithoutAt: false });
      expect((await off.resolve(ev('wren ping'))).targets).toEqual([{ being: 'egpt', mention: ev('x').mention }]);
      expect((await off.resolve(ev('@wren ping'))).mesh?.being).toBe('wren');
      // …and ON (the default) is untouched: no option = today's live behaviour.
      const on = createRouter({ getAgents: () => KG, defaultBeing: 'egpt' });
      expect((await on.resolve(ev('wren ping'))).mesh?.being).toBe('wren');
    });
  });
});

// ── ALLOWED_USERS GATE (operator 2026-08-15): a being's OWN reachability allow-list — replaces
//    the evicted TYPE-FILE `dangerous:true` reachability mechanism (meta-engineer.yaml, gone; see
//    brainpool.mjs's confinementFor for what `dangerously_skip_permissions` still means — a
//    CAPABILITY tier only, never a reachability gate any more). Two-tier: a GLOBAL default lives NESTED under
//    agents.<handle>.conversation_defaults.allowed_users in config.yaml (already sitting on
//    hit.agent — no extra wiring); a PER-CONVERSATION override lives FLAT under conversations.yaml
//    agents.<being>.allowed_users (read via getBeing off an injected `loadState`, mirroring
//    gating.mjs) and REPLACES — never merges with — the global default when set. UNSET at both
//    tiers = no restriction (today's default, an ordinary agent reachable by anyone). Independent
//    of ev.authorized (the existing, different, network-level allowed_users/isSender concept). No
//    refusal text on a failed match — same silent-fallthrough convention the surface pin uses. ──
describe('router.resolve — allowed_users gate (operator 2026-08-15)', () => {
  const agents = {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
    wren: { configuration: 'egpt', handles: ['wren'], conversation_defaults: { allowed_users: ['boss'] } },   // global allow-list
    don:  { configuration: 'sonnet-high', handles: ['don'] },      // ordinary local agent — regression neighbor
  };

  it('REPRODUCE-FIRST: a sender NOT on the GLOBAL allowed_users is dropped — falls through exactly like an unmatched @token', async () => {
    const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
    const r = await arouter.resolve({ ...ev('@wren do X'), senderId: 'stranger' });
    expect(r.being).toBe('egpt');                                  // falls through to the persona
    expect(r.targets).toEqual([{ being: 'egpt', mention: ev('x').mention }]);   // no refusal, no trace of @wren
  });

  it('a sender ON the GLOBAL allowed_users reaches the being directly', async () => {
    const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
    const r = await arouter.resolve({ ...ev('@wren do X'), senderId: 'boss' });
    expect(r.being).toBe('wren');
    expect(r.mesh).toBeUndefined();
  });

  // WILDCARD (operator 2026-08-16): the literal "*" entry is an explicit "reachable by anyone"
  // escape hatch — the pairing an access_level:'all' being needs (see brainpool.mjs's
  // ACCESS-LEVEL/ALLOWED-USERS gate). Without this, "*" would just be an entry no real sender id
  // ever equals, denying EVERYONE — the opposite of the intent (the bug this fix closes).
  it('REPRODUCE-FIRST: allowed_users: ["*"] is a wildcard — ANY sender reaches the being', async () => {
    const ag = { egpt: agents.egpt, wren: { configuration: 'egpt', handles: ['wren'], conversation_defaults: { allowed_users: ['*'] } } };
    const arouter = createRouter({ getAgents: () => ag, defaultBeing: 'egpt' });
    expect((await arouter.resolve({ ...ev('@wren hi'), senderId: 'anyone-at-all' })).being).toBe('wren');
    expect((await arouter.resolve({ ...ev('@wren hi'), senderId: null })).being).toBe('wren');
  });

  // REGRESSION: an ordinary, non-wildcard list still gates exactly as before — only 'boss'
  // reaches wren, everyone else falls through to the persona (same shape as the wildcard test
  // above, proving the "*" branch didn't loosen the plain-list case).
  it('REGRESSION: allowed_users: ["boss"] (no wildcard) still gates on the exact entry — others are denied', async () => {
    const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
    expect((await arouter.resolve({ ...ev('@wren hi'), senderId: 'boss' })).being).toBe('wren');
    expect((await arouter.resolve({ ...ev('@wren hi'), senderId: 'someone-else' })).being).toBe('egpt');
  });

  it('shortChatId normalizes both sides: a legacy full-form config entry matches a short delivered sender id', async () => {
    const ag = { egpt: agents.egpt, wren: { configuration: 'egpt', handles: ['wren'], conversation_defaults: { allowed_users: ['!abc:beeper.local'] } } };
    const arouter = createRouter({ getAgents: () => ag, defaultBeing: 'egpt' });
    expect((await arouter.resolve({ ...ev('@wren hi'), senderId: 'abc' })).being).toBe('wren');
    expect((await arouter.resolve({ ...ev('@wren hi'), senderId: 'someone-else' })).being).toBe('egpt');
  });

  it('REGRESSION: a being with NEITHER tier set is reachable by anyone — today\'s ordinary default', async () => {
    const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
    expect((await arouter.resolve({ ...ev('@don hi'), senderId: 'nobody-in-particular' })).being).toBe('don');
    expect((await arouter.resolve({ ...ev('@don hi'), senderId: null })).being).toBe('don');
  });

  it('a PER-CONVERSATION allowed_users override REPLACES (never merges with) the global default and wins', async () => {
    const state = { contacts: { whatsapp: { CHAT: { slug: 'chat', agents: { wren: { allowed_users: ['other'] } } } } } };
    const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt', loadState: async () => state });
    const base = { ...ev('@wren hi'), surface: 'whatsapp', chatId: 'CHAT' };
    // 'boss' is on the GLOBAL list, but this conversation's override REPLACED it — not merged.
    expect((await arouter.resolve({ ...base, senderId: 'boss' })).being).toBe('egpt');
    // 'other' is on the per-conversation override list.
    expect((await arouter.resolve({ ...base, senderId: 'other' })).being).toBe('wren');
  });

  it('other addressed targets in the SAME message survive: a dropped @wren hit does not affect a co-addressed @don hit', async () => {
    const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
    const r = await arouter.resolve({ ...ev('@wren and @don, both please'), senderId: 'stranger' });
    expect(r.targets.map((t) => t.being)).toEqual(['don']);
  });

  it('no loadState injected (default) → per-conversation overrides are never consulted, only the global tier — today\'s behaviour for a caller that supplies nothing', async () => {
    const bare = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
    expect((await bare.resolve({ ...ev('@wren hi'), senderId: 'boss' })).being).toBe('wren');
    expect((await bare.resolve({ ...ev('@wren hi'), senderId: 'stranger' })).being).toBe('egpt');
  });
});

// voiceWakeTokens — the SPOKEN counterpart to wakeTokens (operator 2026-08-09). UNLIKE
// wakeTokens, there is NO map-key fallback: an agent with no `voice_handles` (or an explicit
// empty list) wakes on NO spoken alias — silence-by-default.
describe('voiceWakeTokens — voice_handles, no map-key fallback (silence-by-default)', () => {
  it('declared voice_handles are lowercased and returned', () => {
    expect(voiceWakeTokens({ voice_handles: ['Perrito', 'Perro'] })).toEqual(['perrito', 'perro']);
  });
  it('ABSENT voice_handles → empty list — unlike wakeTokens, no map-key fallback', () => {
    expect(voiceWakeTokens({ handles: ['e', 'egpt'] })).toEqual([]);
    expect(voiceWakeTokens({})).toEqual([]);
    expect(voiceWakeTokens(undefined)).toEqual([]);
  });
  it('an EXPLICIT empty voice_handles is also silence, same as absent', () => {
    expect(voiceWakeTokens({ voice_handles: [] })).toEqual([]);
  });
  it('blank/falsy entries are filtered, matching wakeTokens\' own behaviour', () => {
    expect(voiceWakeTokens({ voice_handles: ['perrito', '', null, undefined] })).toEqual(['perrito']);
  });
});

// ── addressed({ isVoice }) — a NON-persona agent's voice_handles reach the router (bug fix).
//    Before this: voice-wake was wired in exactly ONE place (boot.mjs's persona-only
//    voiceWakeWords, gating ONLY the bridge's own mentionStatus call) — the REAL per-being
//    router (addressed(), here) never looked at voice at all, so no non-persona agent ever
//    had a path to wake by spoken alias, config or no config. `addressed()` now accepts
//    `isVoice` and, when true, ALSO runs each candidate agent's voiceWakeTokens through
//    mentionHitsAnywhere (the SAME matcher the persona's own voice case already uses via
//    mentionStatus' alsoAnywhere) and merges the hits into the SAME { name, agent, atStart,
//    anywhere } shape — a voice-only hit carries atStart:false, anywhere:true, mirroring
//    mentionStatus' own OR-into-atEAnywhere-never-atEStart convention. ──
describe('addressed({ isVoice }) — non-persona voice_handles reach the router (operator 2026-08-30)', () => {
  const agents = {
    egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true },   // persona, NO voice_handles
    wren: { configuration: 'sonnet-high', handles: ['wren'], voice_handles: ['wren', 'ren'] },   // non-persona, spoken alias 'ren'
  };

  it('REPRODUCE-FIRST: a spoken-only alias ("ren", not in handles) wakes the non-persona agent when isVoice:true', () => {
    const hits = addressed('so anyway ren can you check that', agents, { isVoice: true });
    expect(hits).toEqual([{ name: 'wren', agent: agents.wren, atStart: false, anywhere: true }]);
  });

  it('the same text with isVoice:false (or omitted) addresses NOBODY — "ren" is not a handle', () => {
    expect(addressed('so anyway ren can you check that', agents, { isVoice: false })).toEqual([]);
    expect(addressed('so anyway ren can you check that', agents)).toEqual([]);
  });

  it('the router itself wakes the non-persona being on a spoken alias when resolve() is handed isVoice:true', async () => {
    const router = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
    const r = await router.resolve({ body: 'so anyway ren can you check that', isVoice: true });
    expect(r.being).toBe('wren');
  });

  it('a text handle (@wren) and a voice alias (ren) in the same message dedup to ONE entry, atStart true (the OR convention)', () => {
    const hits = addressed('@wren and also ren are you there', agents, { isVoice: true });
    expect(hits).toEqual([{ name: 'wren', agent: agents.wren, atStart: true, anywhere: true }]);
  });

  it('REGRESSION: isVoice omitted/false is byte-identical to today for every existing shape — an @/bare handle still works, voice_handles never consulted', () => {
    expect(addressed('@wren ping', agents)).toEqual([{ name: 'wren', agent: agents.wren, atStart: true, anywhere: true }]);
    expect(addressed('@wren ping', agents, { isVoice: false })).toEqual([{ name: 'wren', agent: agents.wren, atStart: true, anywhere: true }]);
    expect(addressed('ren ping', agents, { isVoice: false })).toEqual([]);
    expect(addressed('ren ping', agents)).toEqual([]);
  });
});

// ── fallback_handle — ONE conditional wake token, gated on CHAT MEMBERSHIP (operator 2026-08-31).
//
//    THE PRODUCTION PROBLEM: kg and do stopped sharing one Beeper account. `do` now runs on a
//    second account (+1 347…, "Rodz") and carries a relay agent `e` forwarding to ekg.kg — so @e is
//    ANSWERED by kg's brain but POSTED from a visibly different account, which is the whole point.
//    The cost: `e` became a handle on do ONLY, so in every chat the 347 account is not a member of
//    — most of the operator's chats, and EVERY room, which is not a Beeper chat at all — @e reached
//    nobody and he had to type @ekg.
//
//    THE RULE: the agent additionally wakes on its fallback handle, but ONLY where `unless_present`
//    is NOT a participant. Where that identity IS present the token belongs to the other account's
//    agent and this node stays silent — which is what stops one @e waking two spines. Membership
//    (static, knowable locally) not liveness ("did do answer?", a timeout on every message).
//
//    The token flows through THE ONE matcher (wakeTokens/addressed), never a parallel one; the
//    guard is applied in resolve() beside the surface pin and the allowed_users gate, which are the
//    other two post-match filters. ──
describe('fallback_handle — a conditional wake token gated on membership (operator 2026-08-31)', () => {
  // The persona is `assistant` so a MISSED @e falls through to IT, not to the agent under test —
  // otherwise the fall-through would make every assertion vacuous (kg's real persona IS the agent
  // carrying the fallback, so this fixture separates them deliberately; the real shape is asserted
  // on addressed() below, where the miss is visible).
  const AGENTS = {
    assistant: { configuration: 'sonnet-high', handles: ['a'], default: true },
    egpt: { configuration: 'sonnet-high', handles: ['ekg', 'egptkg'], fallback_handle: { handle: 'e', unless_present: '+13472576794' } },
  };
  const chat = (body, extra = {}) => ({ body, surface: 'whatsapp', chatId: '!grp', senderId: 'op', ...extra });
  // A spy for the injected membership seam: records what was asked, answers what the test says.
  const seam = (answer) => {
    const asked = [];
    return { asked, fn: async (identity, ev) => { asked.push({ identity, chatId: ev?.chatId }); return typeof answer === 'function' ? answer(identity, ev) : answer; } };
  };

  it('REPRODUCE-FIRST: @e in a chat the peer is NOT in wakes the local agent (it reached nobody before)', async () => {
    const s = seam(false);
    const r = await createRouter({ getAgents: () => AGENTS, defaultBeing: 'assistant', isPresent: s.fn }).resolve(chat('@e can you check this'));
    expect(r.being).toBe('egpt');                       // the fallback handle woke the agent…
    expect(r.targets).toHaveLength(1);                  // …and nothing else
    expect(s.asked).toEqual([{ identity: '+13472576794', chatId: '!grp' }]);   // asked EXACTLY the declared identity
  });

  it('REPRODUCE-FIRST: @e in a chat the peer IS in does NOT wake it — the token is the other account\'s', async () => {
    const s = seam(true);
    const r = await createRouter({ getAgents: () => AGENTS, defaultBeing: 'assistant', isPresent: s.fn }).resolve(chat('@e can you check this'));
    expect(r.being).toBe('assistant');                  // dropped exactly as if the @token never matched
    expect(r.targets).toHaveLength(1);
    expect(s.asked).toHaveLength(1);                    // the membership question WAS asked (it is not asked at all today)
  });

  it('A ROOM has no participants, so the peer is DEFINITELY absent: @e works there with NO membership call', async () => {
    const s = seam(() => { throw new Error('a room must never reach the membership seam'); });
    const r = await createRouter({ getAgents: () => AGENTS, defaultBeing: 'assistant', isPresent: s.fn })
      .resolve({ body: '@e can you please execute translation script?', surface: SHELL_SURFACE, chatId: 'acim', senderId: 'op' });
    expect(r.being).toBe('egpt');
    expect(s.asked).toEqual([]);   // decided locally — a room is not a Beeper chat, there is nothing to query
  });

  it('the DECLARED handles are unconditional — @ekg never consults membership', async () => {
    const s = seam(true);   // peer present: irrelevant to a real handle
    const r = await createRouter({ getAgents: () => AGENTS, defaultBeing: 'assistant', isPresent: s.fn }).resolve(chat('@ekg ping'));
    expect(r.being).toBe('egpt');
    expect(s.asked).toEqual([]);
  });

  // FAILURE MODE (justified at the guard in router.mjs): UNKNOWN ⇒ SILENT. The token belongs to the
  // other account's agent and is only borrowed; on no evidence it goes back to its owner, because
  // the opposite failure re-creates the live two-spines-answer-one-@egpt bug, loudly, in a group.
  it('membership UNKNOWN (null) ⇒ the agent does NOT wake, and the reason is logged loudly', async () => {
    const lines = [];
    const r = await createRouter({ getAgents: () => AGENTS, defaultBeing: 'assistant', isPresent: async () => null, onLog: (m) => lines.push(m) }).resolve(chat('@e hola'));
    expect(r.being).toBe('assistant');
    expect(lines.join('\n')).toMatch(/fallback_handle.*NOT woken.*\+13472576794/s);
  });

  it('a THROWING membership lookup is the same unknown — silent, logged, never a crashed resolve', async () => {
    const lines = [];
    const r = await createRouter({ getAgents: () => AGENTS, defaultBeing: 'assistant', isPresent: async () => { throw new Error('beeper down'); }, onLog: (m) => lines.push(m) }).resolve(chat('@e hola'));
    expect(r.being).toBe('assistant');
    expect(lines.join('\n')).toMatch(/beeper down/);
    expect(lines.join('\n')).toMatch(/NOT woken/);
  });

  it('ONE membership answer per resolve() call, never per hit — two guarded agents, one lookup', async () => {
    const two = {
      assistant: { configuration: 'sonnet-high', handles: ['a'], default: true },
      egpt: { handles: ['ekg'], fallback_handle: { handle: 'e', unless_present: '+13472576794' } },
      wren: { handles: ['wren'], fallback_handle: { handle: 'w', unless_present: '+13472576794' } },
    };
    const s = seam(false);
    const r = await createRouter({ getAgents: () => two, defaultBeing: 'assistant', isPresent: s.fn }).resolve(chat('@e and @w both'));
    expect(r.targets.map((t) => t.being)).toEqual(['egpt', 'wren']);
    expect(s.asked).toHaveLength(1);   // memoized for the whole call, like the conv-state read
  });

  it('no guarded token in the message ⇒ NO membership lookup at all (the gate is the token, not the config)', async () => {
    const s = seam(false);
    const router = createRouter({ getAgents: () => AGENTS, defaultBeing: 'assistant', isPresent: s.fn });
    await router.resolve(chat('just talking'));
    await router.resolve(chat('@a hola'));
    await router.resolve(chat('@nobody hola'));
    expect(s.asked).toEqual([]);
  });

  it('the guard runs LAST — a hit already dropped by allowed_users costs no lookup', async () => {
    const gated = {
      assistant: { configuration: 'sonnet-high', handles: ['a'], default: true },
      egpt: { handles: ['ekg'], fallback_handle: { handle: 'e', unless_present: '+13472576794' }, conversation_defaults: { allowed_users: ['someone-else'] } },
    };
    const s = seam(false);
    const r = await createRouter({ getAgents: () => gated, defaultBeing: 'assistant', isPresent: s.fn }).resolve(chat('@e hola'));
    expect(r.being).toBe('assistant');
    expect(s.asked).toEqual([]);
  });

  it('a DECLARED handle beats another agent\'s fallback for the same token (unconditional wins over conditional)', async () => {
    const clash = {
      assistant: { configuration: 'sonnet-high', handles: ['a'], default: true },
      egpt: { handles: ['ekg'], fallback_handle: { handle: 'e', unless_present: '+13472576794' } },
      ed: { handles: ['e'] },   // owns @e outright
    };
    const s = seam(false);
    const r = await createRouter({ getAgents: () => clash, defaultBeing: 'assistant', isPresent: s.fn }).resolve(chat('@e hola'));
    expect(r.being).toBe('ed');
    expect(s.asked).toEqual([]);
  });

  // fallbackWake — BOTH fields required. A `handle` with no `unless_present` would be an
  // unconditional extra wake token, which is what `handles:` is for; promoting a half-written
  // declaration to one is how a second spine starts answering. Fail closed.
  it('a half-written declaration is IGNORED, never half-honoured', async () => {
    expect(fallbackWake(AGENTS.egpt)).toEqual({ handle: 'e', unlessPresent: '+13472576794' });
    expect(fallbackWake({ fallback_handle: { handle: 'e' } })).toBeNull();
    expect(fallbackWake({ fallback_handle: { unless_present: '+1347' } })).toBeNull();
    expect(fallbackWake({ fallback_handle: 'e' })).toBeNull();
    expect(fallbackWake({ fallback_handle: ['e'] })).toBeNull();
    expect(fallbackWake({})).toBeNull();
    const half = { assistant: { handles: ['a'], default: true }, egpt: { handles: ['ekg'], fallback_handle: { handle: 'e' } } };
    const s = seam(false);
    expect((await createRouter({ getAgents: () => half, defaultBeing: 'assistant', isPresent: s.fn }).resolve(chat('@e hola'))).being).toBe('assistant');
    expect(s.asked).toEqual([]);
  });

  // kg's REAL shape, asserted on addressed() where the miss is visible (on resolve() the persona
  // fall-through would answer @e either way and prove nothing).
  const KG = { egpt: { configuration: 'sonnet-high', handles: ['ekg', 'egptkg'], fallback_handle: { handle: 'e', unless_present: '+13472576794' }, default: true } };

  it('the fallback token rides THE ONE matcher: withFallback:true puts @e in the vocabulary, carrying its guard', () => {
    expect(addressed('@e hola', KG, { withFallback: true }))
      .toEqual([{ name: 'egpt', agent: KG.egpt, atStart: true, anywhere: true, unlessPresent: '+13472576794' }]);
    // …and it inherits every protection a real handle has (bare form, mid-sentence, glued-token, case)
    expect(addressed('e hola', KG, { withFallback: true }).map((h) => h.name)).toEqual(['egpt']);
    expect(addressed('please @E look', KG, { withFallback: true }).map((h) => h.name)).toEqual(['egpt']);
    expect(addressed('write me@e.com please', KG, { withFallback: true })).toEqual([]);
    expect(addressed('e hola', KG, { withFallback: true, addressWithoutAt: false })).toEqual([]);
  });

  it('withFallback is OPT-IN: mesh.mjs / heartbeat-loader.mjs (which have no chat, so cannot answer the guard) see the vocabulary unchanged', () => {
    expect(addressed('@e hola', KG)).toEqual([]);
    expect(addressed('@e hola', KG, { withFallback: false })).toEqual([]);
    expect(addressed('@ekg hola', KG).map((h) => h.name)).toEqual(['egpt']);   // declared handles unaffected
  });

  // ── THE REGRESSION LOCK: an agent with NO fallback_handle must resolve EXACTLY as it did before
  //    this feature existed — same targets, and NO added IO. This is the main risk of the change. ──
  it('REGRESSION: an agents block with no fallback_handle never touches the membership seam and resolves identically', async () => {
    const plain = {
      egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true },
      don: { configuration: 'relay', relay_channel: 'Rodz' },
      wren: { configuration: 'sonnet-high', handles: ['wren'] },
    };
    const s = seam(() => { throw new Error('no fallback_handle is declared — nothing may ask about membership'); });
    const wired = createRouter({ getAgents: () => plain, defaultBeing: 'egpt', isPresent: s.fn });
    const bare = createRouter({ getAgents: () => plain, defaultBeing: 'egpt' });   // the pre-change router
    for (const body of ['@e hola', '@egpt hola', 'e hola', '@wren ping', '@don ping', '@e and @wren and @don', '@nobody hi', 'just talking', '']) {
      expect(await wired.resolve(chat(body)), body).toEqual(await bare.resolve(chat(body)));
    }
    expect(s.asked).toEqual([]);
    // …and the matcher itself is untouched with or without the flag when nothing declares a fallback
    for (const body of ['@e hola', '@wren ping', 'just talking']) {
      expect(addressed(body, plain, { withFallback: true })).toEqual(addressed(body, plain));
    }
  });
});

// ── fallback_handle ON THE PERSONA — the guard's verdict has to reach the GATE (operator
//    2026-08-31). Every test above puts the fallback on a NON-persona agent, where targetFor's
//    local-agent branch mints the mention from the matcher's own per-agent findings. kg's LIVE
//    config puts it on the PERSONA, which is the one branch that keeps the BRIDGE's ev.mention —
//    and the bridge computes atE from `wakeWords` (boot.mjs, wakeTokens: DECLARED handles only),
//    which cannot know the fallback token exists.
//
//    THE LIVE FAILURE: `@ekg estás?` in a 1:1 was answered, `@e estás?` in the SAME chat was
//    silent, logged `(atE=false)` — with the membership guard having already said the peer is
//    absent. resolve() returned `{ being: 'egpt', mention: <atE=false> }` either way, so a
//    guard-PASSED hit and a guard-DROPPED fall-through were indistinguishable: the feature was a
//    no-op for the persona, and invisibly so.
//
//    So these assert the thing that actually matters — does the message PRODUCE A REPLY — by
//    running the routed mention through the REAL gate (auto-mode replyAllowed, the same call
//    gating.decide makes), with ev.mention built by the REAL bridge chain rather than hardcoded. ──
describe('fallback_handle on the PERSONA — from the bridge\'s atE to the reply gate (operator 2026-08-31)', () => {
  const PEER = '+13472576794';
  // kg's LIVE shape: the persona ITSELF carries the fallback, and it is also the defaultBeing.
  const KG = { egpt: { configuration: 'sonnet-high', handles: ['ekg', 'egptkg'], fallback_handle: { handle: 'e', unless_present: PEER }, default: true } };

  // ev.mention exactly as it is built LIVE, never hardcoded: boot.mjs hands the limb
  // wakeTokens(persona) — declared handles only — the limb runs mentionStatus over it
  // (beeper.mjs), and identity.mjs stamps the result as ev.mention. Reproducing the chain here
  // means these break if any rung of it changes shape, instead of silently testing a fiction.
  const inbound = (body, { chatId = '!dm', surface = 'whatsapp', replyToBot = false } = {}) => {
    const st = mentionStatus(body, wakeTokens('egpt', KG.egpt));
    return { body, surface, chatId, senderId: 'op', mention: { atEStart: st.atEStart, atEAnywhere: st.atEAnywhere, replyToBot } };
  };
  // Route it, then ask the REAL gate whether a reply is emitted, in the node's default mode.
  const ask = async (body, { present = false, agents = KG, mode = 'mention', ...evOpts } = {}) => {
    const asked = [];
    const isPresent = async (identity, e) => { asked.push({ identity, chatId: e?.chatId }); return typeof present === 'function' ? present(identity, e) : present; };
    const ev = inbound(body, evOpts);
    const r = await createRouter({ getAgents: () => agents, defaultBeing: 'egpt', isPresent }).resolve(ev);
    return { being: r.being, mention: r.mention, replies: replyAllowed(mode, r.mention ?? {}), asked, ev };
  };

  it('REPRODUCE-FIRST: the bridge alone judges @e unaddressed — this is the atE=false in the live log', () => {
    expect(inbound('@e estás?').mention).toEqual({ atEStart: false, atEAnywhere: false, replyToBot: false });
    expect(inbound('@ekg estás?').mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });
  });

  it('REPRODUCE-FIRST: @e in a 1:1 the peer is NOT in reaches the persona AND produces a reply', async () => {
    const r = await ask('@e estás?', { present: false });
    expect(r.being).toBe('egpt');
    expect(r.asked).toEqual([{ identity: PEER, chatId: '!dm' }]);   // the guard was consulted…
    expect(r.replies).toBe(true);                                    // …and its YES reached the gate
    expect(r.mention).toMatchObject({ atEStart: true, atEAnywhere: true, replyToBot: false });
  });

  it('THE DOUBLE-ANSWER LOCK: @e in a GROUP the peer IS in must not wake the persona', async () => {
    const r = await ask('@e estás?', { present: true, chatId: '!grp' });
    expect(r.replies).toBe(false);            // silent — the token is the other account's here
    expect(r.mention).toEqual({ atEStart: false, atEAnywhere: false, replyToBot: false });
    expect(r.asked).toHaveLength(1);
  });

  it('@ekg is UNAFFECTED in both — a declared handle is unconditional and costs no lookup', async () => {
    for (const present of [false, true]) {
      const r = await ask('@ekg estás?', { present, chatId: present ? '!grp' : '!dm' });
      expect(r.being, `present=${present}`).toBe('egpt');
      expect(r.replies, `present=${present}`).toBe(true);
      expect(r.asked, `present=${present}`).toEqual([]);
      expect(r.mention, `present=${present}`).toBe(r.ev.mention);   // the SAME object the bridge built
    }
  });

  it('membership UNKNOWN ⇒ silent, exactly like the peer being present (the token goes back to its owner)', async () => {
    const r = await createRouter({ getAgents: () => KG, defaultBeing: 'egpt', isPresent: async () => null })
      .resolve(inbound('@e estás?', { chatId: '!grp' }));
    expect(replyAllowed('mention', r.mention ?? {})).toBe(false);
  });

  it('A ROOM is a definite absence: @e wakes the persona there with NO membership call', async () => {
    const r = await ask('@e can you please execute translation script?', {
      surface: SHELL_SURFACE, chatId: 'acim',
      present: () => { throw new Error('a room must never reach the membership seam'); },
    });
    expect(r.being).toBe('egpt');
    expect(r.replies).toBe(true);
    expect(r.asked).toEqual([]);
  });

  it('the flags are the matcher\'s REAL findings, so mention-direct keeps its meaning', async () => {
    expect((await ask('@e estás?')).mention).toMatchObject({ atEStart: true });
    expect(replyAllowed('mention-direct', (await ask('@e estás?')).mention)).toBe(true);
    // mid-sentence: anywhere, never atStart — so a mention-direct chat still stays silent
    const mid = await ask('hola gente @e mira esto');
    expect(mid.mention).toMatchObject({ atEStart: false, atEAnywhere: true });
    expect(replyAllowed('mention', mid.mention)).toBe(true);
    expect(replyAllowed('mention-direct', mid.mention)).toBe(false);
  });

  it('the fallback OR-s onto the bridge\'s mention, never replaces it — replyToBot survives', async () => {
    const r = await ask('@e estás?', { replyToBot: true });
    expect(r.mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: true });
    // and a quote-reply with NO handle at all is still the bridge's own object, untouched
    const plain = await ask('sí, dale', { replyToBot: true });
    expect(plain.mention).toBe(plain.ev.mention);
    expect(replyAllowed('mention', plain.mention)).toBe(true);
  });

  // ── THE REGRESSION LOCK: a persona with NO fallback_handle must route byte-identically and add
  //    no IO — the same lock the non-persona block above carries, on the branch this change edits. ──
  it('REGRESSION: a persona with no fallback_handle returns the bridge\'s OWN mention object, and asks nothing', async () => {
    const plain = { egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true }, wren: { handles: ['wren'] } };
    const boom = async () => { throw new Error('no fallback_handle is declared — nothing may ask about membership'); };
    const wired = createRouter({ getAgents: () => plain, defaultBeing: 'egpt', isPresent: boom });
    const bare = createRouter({ getAgents: () => plain, defaultBeing: 'egpt' });   // the pre-change router
    for (const body of ['@e hola', '@egpt hola', 'e hola', '@wren ping', '@nobody hi', 'just talking', '']) {
      const evb = { body, surface: 'whatsapp', chatId: '!dm', senderId: 'op', mention: { atEStart: true, atEAnywhere: true, replyToBot: false } };
      const w = await wired.resolve(evb);
      expect(w, body).toEqual(await bare.resolve(evb));
      if (w.being === 'egpt') expect(w.mention, body).toBe(evb.mention);   // the identical object, not a copy
    }
  });
});
