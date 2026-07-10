// router.resolve — @token routing off the unified `agents:` registry (new-config-only,
// operator 2026-07-02). A leading @token matches an agent's name or any handle: a LOCAL
// agent routes to its own being, a RELAY agent to a mesh route-direct target, the PERSONA
// agent to the canonical being 'e'. A qualified @being.node reaches another machine (mesh).
// Everything else falls through to E.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';

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
    off:  { configuration: 'sonnet-high', enabled: false },           // disabled → not routable
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

  it('a disabled agent falls through (→ defaultBeing); a _note key never routes', () => {
    expect(arouter.resolve(ev('@off hi')).being).toBe('egpt');
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
  it('persona resolution follows `default: true`, not e/egpt: key "assistant" (handles [a]) → being "assistant"', () => {
    const ag = { assistant: { configuration: 'sonnet-high', handles: ['a'], default: true }, don: { configuration: 'relay', relay_channel: 'Rodz' } };
    const r = createRouter({ getAgents: () => ag, defaultBeing: 'assistant' });
    expect(r.resolve(ev('@a hola')).being).toBe('assistant');          // matched via handle → its key
    expect(r.resolve(ev('@assistant hola')).being).toBe('assistant');  // matched via key
    expect(r.resolve(ev('@nobody hi')).being).toBe('assistant');       // fall-through → the persona key
    expect(r.resolve(ev('@don ping')).mesh).toEqual({ being: 'don', route: { room_id: 'Rodz' } });  // a non-default agent still routes normally
  });
});

// ── MULTIPATH (operator 2026-07-06: multipath is configuration — an agent is a LIST of paths,
//    every message through every path). A list agent's elements are SINGLE-KEY maps { <label>:
//    { relay_channel, network?, to? } }. The router resolves it to a mesh target carrying ALL
//    paths; the scalar (non-list) relay shape stays byte-for-byte unchanged (regression above). ──
describe('router.resolve — multi-path relay agent (operator 2026-07-06)', () => {
  const agents = {
    carol: [
      { path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } },
      { path2: { relay_channel: 'egpt-mesh', network: 'telegram', to: 'don.do' } },
    ],
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

  it('case-insensitive on a list agent name: @CAROL still fans out', () => {
    expect(arouter.resolve(ev('@CAROL hi')).mesh.being).toBe('carol');
  });
});

describe('router.resolve — cross-node mesh targets (Phase 4b)', () => {
  const mrouter = createRouter({ getAgents: () => ({}), getNode: () => 'kg', meshEnabled: () => true });

  it('a qualified @being.node on another node → mesh target { being, node }, no local being', () => {
    const r = mrouter.resolve(ev('@don.do do X'));
    expect(r.being).toBeNull();
    expect(r.mesh).toMatchObject({ being: 'don', node: 'do', target: 'don.do' });
    expect(r.mention).toMatchObject({ atEStart: true });     // it IS addressed → gates as a mention
  });

  it('a same-node qualified @being.node is NOT a mesh target → falls through to e', () => {
    const r = mrouter.resolve(ev('@e.kg do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });

  it('a bare unknown @token → e (no mesh, no phantom)', () => {
    const r = mrouter.resolve(ev('@ghost do X'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });

  it('mesh disabled (default): a qualified @being.node is NOT a mesh target', () => {
    const r = createRouter({ getAgents: () => ({}) }).resolve(ev('@don.do hi'));
    expect(r.mesh).toBeUndefined();
    expect(r.being).toBe('e');
  });
});
