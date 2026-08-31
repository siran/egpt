// tunnel-origin-gating.test.mjs — A TUNNELLED MESSAGE KEEPS ITS ORIGIN FOR GATING.
//
// Since 8227b99 a wa-group's message re-enters the room it was invited to as a turn, addressed
// `{network:'room', chatId:<room>}`. That address is right for IDENTITY — the room's thread, warm
// process, queue and access_level (a569ada) — and NOTHING here moves it. It is wrong for GATING.
//
// THE LIVE FAILURE (operator 2026-08-31): `@e` in "perrito traducciones" is Rodz's to answer, and
// kg's fallback_handle guard gets that right — it sees the +1347 account present in that GROUP and
// stays quiet. The tunnelled copy then presents as a ROOM event; a room has no roster, the router
// reads that as a DEFINITE absence (correctly, for a real room), so the fallback applies and kg's E
// wakes anyway. ONE message, TWO turns, from two visibly different accounts.
//
// The same re-addressing breaks the OTHER gate that asks "where did this arrive": kg pins its `don`
// relay to `surface: shell` precisely because on Beeper `do` hears @don directly — and a WhatsApp
// line tunnelled onto surface `room` started matching that pin.
//
// The fix is not a new gate (there is ONE membership guard, router.mjs's `unlessPresent`, and it
// stays the only one). It is `ev.origin`, carried across the re-addressing the way `fromNode` and
// `fromMember` already are, and read by exactly those two existing post-match filters.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createIdentity, SHELL_SURFACE } from '../src/spine/identity.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';

// kg's live agents block: the persona is addressable as @ekg/@egptkg, and BORROWS `@e` only where
// the peer account (do, on the second Beeper account "Rodz") is not a participant. Plus the
// shell-pinned relay whose whole reason to exist is that `do` hears @don itself on Beeper.
const KG = {
  egpt: { default: true, handles: ['ekg', 'egptkg'], fallback_handle: { handle: 'e', unless_present: '+13472576794' } },
  don: { configuration: 'relay', relay_channel: 'egpt-mesh-do-kg', to: 'don.do', surface: 'shell' },
};
const PEER = '+13472576794';
const GROUP = '!perrito-traducciones';
const ROOM = 'acim';

// THE membership seam boot wires to bridge.chatHasParticipant: the peer IS in the group, and any
// other chat is unknown to it. Records every chat it was asked about — that list IS the assertion
// for "which conversation did the gate ask about".
function presenceSeam() {
  const asked = [];
  const isPresent = async (identity, ev) => {
    asked.push({ identity, surface: ev?.surface, chatId: ev?.chatId });
    return ev?.chatId === GROUP ? true : null;         // present in the group; unknown elsewhere
  };
  return { isPresent, asked };
}

const identity = createIdentity({ now: () => 1000 });
// The genuine arrival: `@e` typed by a person in the WhatsApp group. The bridge's own wake words
// are the DECLARED handles only (boot.mjs, via wakeTokens), so `e` is NOT among them — atE=false,
// exactly as the live log showed.
const inGroup = (body = '@e traducime esto') => identity.build({
  body,
  from: { network: 'whatsapp', chatId: GROUP, chatName: 'perrito traducciones', userId: 'u-x', senderName: 'Vero', msgKey: 'g1' },
});

// THE TUNNEL, built by the real room relay: one fanOut with a `tunnelRooms` roster, capturing the
// synthetic payload it re-enters — so the shape under test is the one production produces, not a
// hand-written approximation of it.
async function tunnelled(ev) {
  const seen = [];
  const roster = [];
  Object.defineProperty(roster, 'tunnelRooms', { value: [ROOM], enumerable: false });
  const relay = createRoomRelay({
    resolveMembers: async () => roster,
    adapterOf: async () => null,
    streamFromTab: async () => '',
    openStream: () => ({ update() {}, finish: async () => {}, fail: async () => {} }),
  });
  await relay.fanOut(ev, { reenter: async (payload) => { seen.push(payload); } });
  expect(seen).toHaveLength(1);
  return { payload: seen[0], ev: identity.build(seen[0]) };
}

describe('REPRODUCE-FIRST — one message, two turns', () => {
  it("the ROSTER gate asks the GROUP the message arrived in, not the room's absence", async () => {
    const { asked, isPresent } = presenceSeam();
    const router = createRouter({ getAgents: () => KG, defaultBeing: 'egpt', isPresent });

    // 1. The genuine arrival in the group: the peer IS there, so the fallback token stays its
    //    owner's and kg's E is NOT woken. (This half already worked — it is the control.)
    const direct = await router.resolve(inGroup());
    expect(direct.being).toBe('egpt');                          // the un-addressed fall-through…
    expect(direct.mention.atEAnywhere).toBe(false);             // …NOT the fallback's wake

    // 2. The tunnelled copy of that SAME message. On HEAD the room short-circuits to "absent" and
    //    the fallback fires, handing the gate atEAnywhere:true — the second turn.
    const { ev } = await tunnelled(inGroup());
    const viaRoom = await router.resolve(ev);
    expect(viaRoom.mention.atEAnywhere).toBe(false);
    // …and BOTH resolves asked about the GROUP, with the group's surface — never room/acim
    // (the presence cache is per resolve() call, so two calls make two lookups).
    expect(asked).toEqual([
      { identity: PEER, surface: 'whatsapp', chatId: GROUP },
      { identity: PEER, surface: 'whatsapp', chatId: GROUP },
    ]);
  });

  it('a SHELL-PINNED agent does not match a message that arrived on WhatsApp', async () => {
    const { isPresent } = presenceSeam();
    const router = createRouter({ getAgents: () => KG, defaultBeing: 'egpt', isPresent });
    const { ev } = await tunnelled(inGroup('@don ¿estás?'));
    // The turn still RUNS in the room…
    expect(ev.surface).toBe(SHELL_SURFACE);
    expect(ev.chatId).toBe(ROOM);
    // …but @don's `surface: shell` pin is measured against WHATSAPP, where it does not apply, so
    // the message falls through to the persona instead of being relayed to do a second time.
    expect(ev.origin).toEqual({ surface: 'whatsapp', chatId: GROUP, chatName: 'perrito traducciones' });
    const r = await router.resolve(ev);
    expect(r.targets).toHaveLength(1);
    expect(r.being).toBe('egpt');
    expect(r.mesh).toBeUndefined();
  });
});

describe('the tunnel carries the origin, and nothing else changes', () => {
  it('tunnelOf stamps { surface, chatId, chatName } beside fromMember/fromNode, and re-addresses as before', async () => {
    const { payload, ev } = await tunnelled(inGroup());
    expect(payload.from).toMatchObject({
      network: 'room', chatId: ROOM, chatName: ROOM,           // a569ada's identity — unchanged
      fromMember: { id: GROUP, kind: 'wa-group' },
      origin: { surface: 'whatsapp', chatId: GROUP, chatName: 'perrito traducciones' },
    });
    // The body and the speaker stay the ORIGIN's, exactly as before.
    expect(ev.body).toBe('@e traducime esto');
    expect(ev.senderName).toBe('Vero');
  });

  it('identity.build carries `origin` through, and it is null on every genuine bridge inbound', () => {
    expect(inGroup().origin).toBeNull();
    expect(identity.build({ body: 'x', from: { network: 'whatsapp', chatId: 'c', origin: { surface: 'telegram', chatId: 't' } } }).origin)
      .toEqual({ surface: 'telegram', chatId: 't' });
  });

  it('a REAL room message (no origin) still gets the room shortcut — the fallback applies there', async () => {
    // The case the shortcut exists for (operator 2026-08-31): a `~/.egpt/rooms/<name>` conversation
    // is not a Beeper chat, so the peer account provably is not in it. Must stay a DEFINITE absence.
    const { asked, isPresent } = presenceSeam();
    const router = createRouter({ getAgents: () => KG, defaultBeing: 'egpt', isPresent });
    const ev = identity.build({ body: '@e can you please…', from: { network: 'shell', chatId: 'lobby', chatName: 'lobby', userId: 'u-an' } });
    const r = await router.resolve(ev);
    expect(r.mention.atEAnywhere).toBe(true);      // woken by the fallback, no lookup at all
    expect(asked).toEqual([]);
  });
});

describe('BYTE-IDENTICAL — a conversation in no room (no `origin`)', () => {
  it('both gates read the identical object they always read: same targets, same lookups', async () => {
    const AGENTS = { ...KG, wren: { configuration: 'sonnet-high' }, tg: { configuration: 'relay', relay_channel: 'x', to: 'y.do', surface: 'telegram' } };
    const cases = [
      identity.build({ body: '@wren hola', from: { network: 'whatsapp', chatId: '!c1', chatName: 'fam', userId: 'u' } }),
      identity.build({ body: '@tg hola', from: { network: 'telegram', chatId: 'tg1', chatName: 'tgchat', userId: 'u' } }),
      identity.build({ body: '@tg hola', from: { network: 'whatsapp', chatId: '!c2', chatName: 'fam', userId: 'u' } }),
      identity.build({ body: '@e hola', from: { network: 'whatsapp', chatId: '!c3', chatName: 'fam', userId: 'u' } }),
      identity.build({ body: 'sin nadie', from: { network: 'whatsapp', chatId: '!c4', chatName: 'fam', userId: 'u' } }),
    ];
    const run = async () => {
      const { asked, isPresent } = presenceSeam();
      const router = createRouter({ getAgents: () => AGENTS, defaultBeing: 'egpt', isPresent });
      const out = [];
      for (const ev of cases) out.push(await router.resolve(ev));
      return { out, asked };
    };
    const a = await run();
    // Every one of them carries origin: null, so `org` IS `ev` — the resolution below is literally
    // the pre-change one. Locked field by field rather than by re-running the old code.
    expect(cases.every((c) => c.origin === null)).toBe(true);
    expect(a.out.map((r) => [r.being, r.mesh?.being ?? null])).toEqual([
      ['wren', null], [null, 'tg'], ['egpt', null], ['egpt', null], ['egpt', null],
    ]);
    // @e in a whatsapp 1:1 → the guard ran against THAT chat and got `null` (unknown) → silent.
    expect(a.asked).toEqual([{ identity: PEER, surface: 'whatsapp', chatId: '!c3' }]);
    expect(a.out[3].mention.atEAnywhere).toBe(false);
  });
});
