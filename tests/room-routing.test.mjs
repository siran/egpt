import { describe, it, expect } from 'vitest';
import { planFanout, roomEnvelope, isRoomEnvelope } from '../src/room-routing.mjs';
import { emptyRooms, createRoom, addMember, setMemberState } from '../src/rooms.mjs';

function room3() {
  // room with: g1 (wa), g2 (wa), e (brain) — all muted by default.
  let s = createRoom(emptyRooms(), 'r');
  s = addMember(s, 'r', { kind: 'wa-group', id: 'g1' });
  s = addMember(s, 'r', { kind: 'wa-group', id: 'g2' });
  s = addMember(s, 'r', { kind: 'brain', id: 'e' });
  return s;
}

describe('planFanout', () => {
  it('muted sender → no fan-out (message stays local)', () => {
    const s = room3();
    expect(planFanout(s, 'g1', { atEAnywhere: false })).toEqual([]);
  });

  it('active sender → fans to all OTHER members', () => {
    let s = setMemberState(room3(), 'r', 'g1', 'active');
    const plans = planFanout(s, 'g1', {});
    expect(plans).toHaveLength(1);
    expect(plans[0].room).toBe('r');
    expect(plans[0].targets.map(t => t.id).sort()).toEqual(['e', 'g2']);
  });

  it('mention sender contributes only when the message @mentions', () => {
    let s = setMemberState(room3(), 'r', 'g1', 'mention');
    expect(planFanout(s, 'g1', { atEAnywhere: false })).toEqual([]);
    const plans = planFanout(s, 'g1', { atEAnywhere: true });
    expect(plans).toHaveLength(1);
    expect(plans[0].targets.map(t => t.id).sort()).toEqual(['e', 'g2']);
  });

  it('a member not in any room → no plans', () => {
    expect(planFanout(room3(), 'stranger', {})).toEqual([]);
  });
});

describe('roomEnvelope', () => {
  it('source-qualifies the line', () => {
    expect(roomEnvelope({ room: 'estudio', senderLabel: 'Ana', body: 'hola' }))
      .toBe('🏠 estudio · Ana: hola');
  });
});

describe('isRoomEnvelope (echo guard)', () => {
  it('flags a fanned message so it is not re-routed', () => {
    expect(isRoomEnvelope(roomEnvelope({ room: 'r', senderLabel: 'A', body: 'hi' }))).toBe(true);
    expect(isRoomEnvelope('🏠 test · An: hello')).toBe(true);
  });
  it('a normal message is not an envelope', () => {
    expect(isRoomEnvelope('hello')).toBe(false);
    expect(isRoomEnvelope('@e hola')).toBe(false);
    expect(isRoomEnvelope('')).toBe(false);
  });
});
