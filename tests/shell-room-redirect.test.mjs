// shell-room-redirect.test.mjs — REPRODUCE-FIRST for the gap confirmed live: `/room join
// acim` typed at the shell set commands.mjs's currentRoom map, but an ordinary or `@e`
// message typed right after still dispatched on (shell, 'main') — the join had zero effect
// on where the turn actually ran, because nothing between the limb and the shared dispatch
// ever consulted currentRoom. Before this file's fix existed, none of `redirectShellToRoom`
// (boot.mjs), `commands.currentRoomOf` (commands.mjs) or `shellPort.claim` (shell-port.mjs)
// existed at all, so every assertion below that exercises them would have thrown/failed —
// that IS the reproduction; this file locks the fix in place going forward.
//
// "lobby" is sugar for "no room" (the shell's own native identity) — there is no
// `room/lobby` folder, so joining it must NOT redirect (spec, verbatim from the brief).
import { describe, it, expect } from 'vitest';
import { redirectShellToRoom, makeShellAwareBridge } from '../src/spine/boot.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { createIdentity } from '../src/spine/identity.mjs';

function makeFakeWs() {
  class FakeWS {
    constructor() { this.sent = []; this._h = {}; }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
    fire(ev, ...a) { for (const cb of (this._h[ev] || [])) cb(...a); }
    send(data) { this.sent.push(data); }
    close() {}
  }
  return FakeWS;
}

describe('redirectShellToRoom — the pure decision boot.mjs\'s shell-limb wiring makes', () => {
  const shellMsg = (body = 'hi') => ({ body, from: { chatId: 'main', chatName: 'shell', network: 'shell', userId: 'operator' } });

  it('REPRODUCE-FIRST: no room joined (currentRoomOf → null) — the message is returned UNCHANGED, still (shell, main)', () => {
    const claims = [];
    const msg = shellMsg();
    const out = redirectShellToRoom(msg, { currentRoomOf: () => null, claim: (c) => claims.push(c) });
    expect(out.from.network).toBe('shell');
    expect(out.from.chatId).toBe('main');
    expect(claims).toEqual([]);
  });

  it('a current room redirects to surface room, chatId <slug> — the fix for the live gap', () => {
    const claims = [];
    const msg = shellMsg('@e hi E. please execute translation script');
    const out = redirectShellToRoom(msg, { currentRoomOf: (surface) => (surface === 'shell' ? 'acim' : null), claim: (c) => claims.push(c) });
    expect(out.from.network).toBe('room');
    expect(out.from.chatId).toBe('acim');
    expect(out.body).toBe(msg.body);              // the text itself is untouched
    expect(claims).toEqual(['acim']);              // claimed for outbound routing back to the shell
  });

  it("'lobby' means the shell's own native identity — NOT a room/lobby folder — so it does NOT redirect", () => {
    const claims = [];
    const out = redirectShellToRoom(shellMsg(), { currentRoomOf: () => 'lobby', claim: (c) => claims.push(c) });
    expect(out.from.network).toBe('shell');
    expect(out.from.chatId).toBe('main');
    expect(claims).toEqual([]);
  });

  it('does not mutate the original message object', () => {
    const msg = shellMsg();
    const frozenFrom = { ...msg.from };
    redirectShellToRoom(msg, { currentRoomOf: () => 'acim', claim: () => {} });
    expect(msg.from).toEqual(frozenFrom);
  });

  // REPRODUCE-FIRST — the live-confirmed bug: `/room leave acim` typed at the shell while
  // a room is joined got swept into the redirect like any other message, so it dispatched
  // as surface 'room' chatId 'acim' instead of surface 'shell' chatId 'main' — commands.mjs
  // then read/wrote currentRoom['room'] instead of currentRoom['shell'], so leave silently
  // failed to clear the entry that gates the redirect and the shell got permanently wedged
  // inside the room. Commands (anything starting with '/') must NEVER be part of the
  // "prose fan-out to the current room" feature — they always keep operating on the
  // shell's own native (shell, main) identity, regardless of any joined room.
  it('REPRODUCE-FIRST: a slash command is NEVER redirected, even with a room joined — stays (shell, main)', () => {
    const claims = [];
    const msg = shellMsg('/room leave acim');
    const out = redirectShellToRoom(msg, { currentRoomOf: (surface) => (surface === 'shell' ? 'acim' : null), claim: (c) => claims.push(c) });
    expect(out.from.network).toBe('shell');
    expect(out.from.chatId).toBe('main');
    expect(claims).toEqual([]);
  });

  it('a leading/trailing-whitespace slash command is also never redirected', () => {
    const claims = [];
    const msg = shellMsg('  /status');
    const out = redirectShellToRoom(msg, { currentRoomOf: (surface) => (surface === 'shell' ? 'acim' : null), claim: (c) => claims.push(c) });
    expect(out.from.network).toBe('shell');
    expect(out.from.chatId).toBe('main');
    expect(claims).toEqual([]);
  });

  it('regression lock: non-command prose STILL redirects when a room is joined (the original fix, unaffected by the command guard)', () => {
    const claims = [];
    const msg = shellMsg('@e hi E. please execute translation script');
    const out = redirectShellToRoom(msg, { currentRoomOf: (surface) => (surface === 'shell' ? 'acim' : null), claim: (c) => claims.push(c) });
    expect(out.from.network).toBe('room');
    expect(out.from.chatId).toBe('acim');
    expect(claims).toEqual(['acim']);
  });
});

describe('the live gap, reproduced end to end: /room join acim → currentRoomOf → redirect → identity.build', () => {
  it('a bare identity.build (no redirect) stays on (shell, main) — the ORIGINAL bug, still true of the raw inbound frame', () => {
    const identity = createIdentity();
    const ev = identity.build({ body: '@e hi E', from: { chatId: 'main', chatName: 'shell', network: 'shell', userId: 'operator', authorized: true } });
    expect(ev.surface).toBe('shell');
    expect(ev.chatId).toBe('main');
  });

  it('after /room join acim, the SAME message redirected + identity.build lands on (room, acim) — E now runs confined to that room', async () => {
    const sent = [];
    const commands = createCommands({
      getConfig: () => ({}),
      send: async (chatId, text) => sent.push({ chatId, text }),
    });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room join acim', authorized: true });
    expect(sent[0].text).toBe("joined 'acim' — now current.");
    expect(commands.currentRoomOf('shell')).toBe('acim');

    const identity = createIdentity();
    const inbound = { body: '@e hi E. please execute translation script', from: { chatId: 'main', chatName: 'shell', network: 'shell', userId: 'operator', authorized: true, atEStart: true, atEAnywhere: true } };
    const redirected = redirectShellToRoom(inbound, { currentRoomOf: commands.currentRoomOf, claim: () => {} });
    const ev = identity.build(redirected);
    expect(ev.surface).toBe('room');
    expect(ev.chatId).toBe('acim');
  });

  it('/room join lobby restores native (shell, main) routing for subsequent messages', async () => {
    const sent = [];
    const commands = createCommands({ getConfig: () => ({}), send: async (chatId, text) => sent.push({ chatId, text }) });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room join acim', authorized: true });
    expect(commands.currentRoomOf('shell')).toBe('acim');
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room join lobby', authorized: true });
    expect(commands.currentRoomOf('shell')).toBe('lobby');

    const identity = createIdentity();
    const inbound = { body: 'hola', from: { chatId: 'main', chatName: 'shell', network: 'shell', userId: 'operator', authorized: true } };
    const redirected = redirectShellToRoom(inbound, { currentRoomOf: commands.currentRoomOf, claim: () => {} });
    const ev = identity.build(redirected);
    expect(ev.surface).toBe('shell');
    expect(ev.chatId).toBe('main');
  });

  it('/room leave acim ALSO restores native routing (curRoomName clears the map entirely, same as before this fix)', async () => {
    const sent = [];
    const commands = createCommands({ getConfig: () => ({}), send: async (chatId, text) => sent.push({ chatId, text }) });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room join acim', authorized: true });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room leave acim', authorized: true });
    expect(commands.currentRoomOf('shell')).toBe(null);
    const out = redirectShellToRoom({ body: 'hola', from: { chatId: 'main', network: 'shell' } }, { currentRoomOf: commands.currentRoomOf, claim: () => {} });
    expect(out.from.network).toBe('shell');
  });

  // REPRODUCE-FIRST, the exact live sequence from the bug report: join a room, then send
  // `/room leave acim` through the SAME redirect + identity.build pipeline shellPort.onMessage
  // actually runs it through. Before the fix, this landed on (room, acim), so commands.run
  // (keyed by surfaceOf(ev) = ev.surface) read/wrote currentRoom['room'] instead of
  // currentRoom['shell'] and the leave silently failed to clear the entry that gates the
  // redirect — the shell got permanently wedged inside the room.
  it('/room join acim then /room leave acim through redirect+identity.build lands on (shell, main), not (room, acim) — the exact live bug', async () => {
    const sent = [];
    const commands = createCommands({ getConfig: () => ({}), send: async (chatId, text) => sent.push({ chatId, text }) });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room join acim', authorized: true });
    expect(commands.currentRoomOf('shell')).toBe('acim');

    const identity = createIdentity();
    const leaveMsg = { body: '/room leave acim', from: { chatId: 'main', chatName: 'shell', network: 'shell', userId: 'operator', authorized: true } };
    const redirected = redirectShellToRoom(leaveMsg, { currentRoomOf: commands.currentRoomOf, claim: () => {} });
    const ev = identity.build(redirected);
    expect(ev.surface).toBe('shell');
    expect(ev.chatId).toBe('main');

    // and now commands.run actually sees the real surface, so the leave clears the RIGHT entry
    await commands.run(ev);
    expect(commands.currentRoomOf('shell')).toBe(null);
  });
});

describe('outbound routing: the redirect must claim() the room chatId, or a reply never finds its way back to the shell socket', () => {
  it('REPRODUCE-FIRST: before claim(), the room chatId is NOT shell-owned — a reply would be handed to the wrong bridge', () => {
    const port = createShellPort({ WebSocket: makeFakeWs() });
    expect(port.owns('acim')).toBe(false);
  });

  it('claim() registers the chatId — owns() then recognizes it, exactly like an id actually seen inbound', () => {
    const port = createShellPort({ WebSocket: makeFakeWs() });
    port.claim('acim');
    expect(port.owns('acim')).toBe(true);
  });

  it('end to end: makeShellAwareBridge routes a send for the claimed room chatId to the shell socket, not the raw bridge', async () => {
    const port = createShellPort({ WebSocket: makeFakeWs() });
    const beeperSends = [];
    const rawBridge = { send: async (c, t) => { beeperSends.push({ c, t }); return null; } };

    const commands = createCommands({ getConfig: () => ({}), send: async () => {} });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room join acim', authorized: true });

    const bridge = makeShellAwareBridge(rawBridge, port);
    // BEFORE the redirect ever claims 'acim', a send targeting it falls through to beeper (wrong bridge)
    await bridge.send('acim', 'unclaimed');
    expect(beeperSends).toHaveLength(1);

    redirectShellToRoom({ body: 'x', from: { chatId: 'main', network: 'shell' } }, { currentRoomOf: commands.currentRoomOf, claim: port.claim });
    // AFTER claim, the same chatId routes to the shell port instead
    await bridge.send('acim', 'claimed');
    expect(beeperSends).toHaveLength(1);   // unchanged — the second send did NOT go to beeper
  });
});

// REPRODUCE-FIRST — the smaller bug surfaced by the redirect fix above: even once
// redirectShellToRoom stops mis-routing, a bare `/room leave` (no slug) still just prints
// ROOM_USAGE and does nothing, forcing the operator to retype the slug of the room they're
// already in. `/room leave` with no argument should leave whatever room is current.
describe('bare /room leave (no slug) — leaves the current room without retyping it', () => {
  it('current room set (join acim) + bare /room leave → leaves it', async () => {
    const sent = [];
    const commands = createCommands({ getConfig: () => ({}), send: async (chatId, text) => sent.push({ chatId, text }) });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room join acim', authorized: true });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room leave', authorized: true });
    expect(commands.currentRoomOf('shell')).toBe(null);
    expect(sent[sent.length - 1].text).toBe("left 'acim' — no current room.");
  });

  it('no current room joined + bare /room leave → short no-op message, NOT the full ROOM_USAGE line', async () => {
    const sent = [];
    const commands = createCommands({ getConfig: () => ({}), send: async (chatId, text) => sent.push({ chatId, text }) });
    await commands.run({ chatId: 'main', surface: 'shell', body: '/room leave', authorized: true });
    expect(sent[0].text).not.toMatch(/^usage:/);
    expect(sent[0].text).not.toContain('/room create');
  });
});
