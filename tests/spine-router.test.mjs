// router.resolve — @token routing off the unified `agents:` registry (new-config-only,
// operator 2026-07-02). A leading @token matches an agent's name or any handle: a LOCAL
// agent routes to its own being, a RELAY agent to a mesh route-direct target, the PERSONA
// agent to the canonical being 'e'. A qualified @being.node reaches another machine (mesh).
// Everything else falls through to E.
import { describe, it, expect } from 'vitest';
import { createRouter, addressed } from '../src/spine/router.mjs';

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

  it('@e (persona handle) → the persona KEY "egpt", ev.mention preserved', () => {
    const m = { atEStart: true, atEAnywhere: true, replyToBot: false };
    const r = arouter.resolve(ev('@e hola', m));
    expect(r.being).toBe('egpt');    // the persona being-id IS its map key
    expect(r.mesh).toBeUndefined();
    expect(r.mention).toBe(m);       // persona keeps the bridge-computed mention
  });

  it('@egpt (persona name key) also → being "egpt"', () => {
    expect(arouter.resolve(ev('@egpt yo')).being).toBe('egpt');
  });

  it('a LOCAL agent @don-local → being "don-local" with a synthetic mention', () => {
    const r = arouter.resolve(ev('@don-local do X'));
    expect(r.being).toBe('don-local');
    expect(r.mesh).toBeUndefined();
    expect(r.mention).toEqual({ atEStart: true, atEAnywhere: true, replyToBot: false });   // a direct @name synthesizes an addressed mention
  });

  it('a RELAY agent @don → a mesh target routed by relay_channel (route-direct), no local being', () => {
    const r = arouter.resolve(ev('@don ping'));
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
    expect(r.mention).toMatchObject({ atEStart: true });
  });

  it('a RELAY agent with a network pin carries lowercased network on the mesh route (operator 2026-07-06: same name on two networks)', () => {
    const r = arouter.resolve(ev('@don-tg ping'));
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don-tg', route: { room_id: 'Rodz', network: 'telegram' } });
    // regression: an UNPINNED relay agent's route carries NO network key (asserted above via toEqual on @don)
  });

  it('case-insensitive on handles and names: @Don-Local → don-local, @DON → relay target', () => {
    expect(arouter.resolve(ev('@Don-Local hi')).being).toBe('don-local');
    expect(arouter.resolve(ev('@DON hi')).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
  });

  // Operator 2026-07-26: "disabling is just commenting the config. no need to have or check an
  // enabled key in this case." The agent-level `enabled` check was evicted as dead code — no live
  // agent ever carried the key — so an entry that does carry it is an ordinary agent. The REAL
  // disable mechanisms are still locked below: a `_`-prefixed comment key, and commenting the
  // agent out entirely (an absent key routes nowhere).
  it('an `enabled: false` key is INERT — the agent routes like any other; a _note key never routes', () => {
    expect(arouter.resolve(ev('@off hi')).being).toBe('off');
    expect(arouter.resolve(ev('@_note hi')).being).toBe('egpt');
  });

  it('an unknown @token falls through to the persona (defaultBeing)', () => {
    expect(arouter.resolve(ev('@nobody hi')).being).toBe('egpt');
  });

  it('no agents block → always defaultBeing (no local beings without a registry)', () => {
    const bare = createRouter({ defaultBeing: 'egpt' });
    expect(bare.resolve(ev('@wren do X')).being).toBe('egpt');
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
  it('persona resolution follows `default: true`, not e/egpt: key "assistant" (handles [a]) → being "assistant"', () => {
    const ag = { assistant: { configuration: 'sonnet-high', handles: ['a'], default: true }, don: { configuration: 'relay', relay_channel: 'Rodz' } };
    const r = createRouter({ getAgents: () => ag, defaultBeing: 'assistant' });
    expect(r.resolve(ev('@a hola')).being).toBe('assistant');          // matched via handle → its key (the being-id)
    expect(addressed('@assistant hola', ag)).toEqual([]);              // the KEY is not a wake token (handles declared)
    expect(r.resolve(ev('@nobody hi')).being).toBe('assistant');       // fall-through → the persona key
    expect(r.resolve(ev('@don ping')).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });  // a non-default agent still routes normally
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

  it('@carol → a mesh target carrying EVERY path (route+network pin+to+label), no local being', () => {
    const r = arouter.resolve(ev('@carol hola'));
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

  it('REGRESSION: the scalar relay @don is UNCHANGED (no paths key, single route)', () => {
    expect(arouter.resolve(ev('@don ping')).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
  });

  it('case-insensitive on a multipath agent name: @CAROL still fans out', () => {
    expect(arouter.resolve(ev('@CAROL hi')).mesh.being).toBe('carol');
  });
});

// ── SURFACE PIN (operator 2026-07-25: `@don` from the operator shell relays over the mesh, but
//    `@don` on Beeper is left alone). An agent may carry `surface: <name>` so it is treated as an
//    agent ONLY on that surface; on any OTHER surface the @mention falls through (as if unmatched).
//    CORRECTNESS, not convenience: `do` and `kg` share ONE Beeper account, so on Beeper `do` hears
//    `@don` DIRECTLY and answers it — kg must NOT also relay it. kg relays `don` ONLY from the shell
//    (which `do` can't hear), so kg pins its `don` relay agent `surface: shell`. ──
describe('router.resolve — surface-pinned relay agent (operator 2026-07-25)', () => {
  const agents = {
    egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true },
    don:  { configuration: 'relay', relay_channel: 'egpt-mesh-do-kg', to: 'don.do', surface: 'shell' },   // relay ONLY on the shell surface
  };
  const arouter = createRouter({ getAgents: () => agents, defaultBeing: 'egpt' });
  const evS = (body, surface) => ({ ...ev(body), surface });

  it('@don on the SHELL surface → the mesh relay (its pinned surface matches)', () => {
    const r = arouter.resolve(evS('@don ping', 'shell'));
    expect(r.being).toBeNull();
    expect(r.mesh).toEqual({ being: 'don', route: { room_id: 'egpt-mesh-do-kg' }, to: 'don.do' });
    expect(r.mention).toMatchObject({ atEStart: true });
  });

  it('REPRODUCE-FIRST: @don on the WHATSAPP surface does NOT relay (surface mismatch → falls through to the persona)', () => {
    // On CURRENT (pre-fix) code the agent matches regardless of surface → wrongly relays on Beeper,
    // double-answering the message `do` already heard directly. After the surface gate: falls through.
    const r = arouter.resolve(evS('@don ping', 'whatsapp'));
    expect(r.mesh).toBeUndefined();     // NOT relayed on Beeper — `do` answers @don directly
    expect(r.being).toBe('egpt');       // falls through to the persona (defaultBeing)
  });

  it('an UNPINNED relay agent is surface-agnostic (regression: no surface key → matches on any surface)', () => {
    const ag = { egpt: { handles: ['e'], default: true }, don: { configuration: 'relay', relay_channel: 'Rodz' } };
    const r = createRouter({ getAgents: () => ag, defaultBeing: 'egpt' });
    expect(r.resolve({ ...ev('@don ping'), surface: 'whatsapp' }).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
    expect(r.resolve({ ...ev('@don ping'), surface: 'shell' }).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });
  });
});

// ── EVICTION (operator 2026-07-25): `mesh.nodes` and with it the bare `@being.node` routing
//    scheme are gone. The router no longer mints a `{ being, node }` target — that shape carried
//    no route, so nothing could ever carry it. Reaching another machine is AGENT-BASED: a relay
//    agent's relay_channel IS the route. `@don.do` still works when `don` is a relay agent,
//    because the leading-@token match stops at the dot. ──
describe('router.resolve — @being.node addressing (mesh.nodes evicted)', () => {
  it('an unmatched qualified @being.node mints NO mesh target — it falls through to the persona', () => {
    const r = createRouter({ getAgents: () => ({}) }).resolve(ev('@don.do do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });

  it('a bare unknown @token → e (no mesh, no phantom)', () => {
    const r = createRouter({ getAgents: () => ({}) }).resolve(ev('@ghost do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });

  it('SURVIVES: @<relay-agent>.<node> routes route-direct through the agent (the @token stops at the dot)', () => {
    const ag = { egpt: { handles: ['e'], default: true }, don: { relay_channel: 'Rodz', to: 'don.do' } };
    const r = createRouter({ getAgents: () => ag, defaultBeing: 'egpt' }).resolve(ev('@don.do do X'));
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
