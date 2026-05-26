import { describe, it, expect } from 'vitest';
import {
  emptyRooms, createRoom, deleteRoom, addMember, removeMember,
  setMemberState, getRoom, listRooms, roomsForMember, sanitizeName,
  DEFAULT_MEMBER_STATE,
} from '../src/rooms.mjs';

describe('rooms data model', () => {
  it('creates a room and adds members muted by default', () => {
    let s = createRoom(emptyRooms(), 'Estudio AAS');
    expect(getRoom(s, 'estudio-aas')).toBeTruthy();
    s = addMember(s, 'estudio-aas', { kind: 'wa-group', id: '123@g.us' });
    s = addMember(s, 'estudio-aas', { kind: 'brain', id: 'e' });
    const r = getRoom(s, 'estudio-aas');
    expect(r.members).toHaveLength(2);
    expect(r.members.every(m => m.state === DEFAULT_MEMBER_STATE)).toBe(true);
    expect(DEFAULT_MEMBER_STATE).toBe('muted');
  });

  it('sanitizes names consistently', () => {
    expect(sanitizeName('Estudio AAS')).toBe('estudio-aas');
    expect(sanitizeName('  weird/Name!! ')).toBe('weird-name');
  });

  it('changes member state and rejects unknown states/kinds', () => {
    let s = addMember(createRoom(emptyRooms(), 'r'), 'r', { kind: 'wa-group', id: 'g1' });
    s = setMemberState(s, 'r', 'g1', 'active');
    expect(getRoom(s, 'r').members[0].state).toBe('active');
    expect(() => setMemberState(s, 'r', 'g1', 'loud')).toThrow();
    expect(() => addMember(s, 'r', { kind: 'sms', id: 'x' })).toThrow();
  });

  it('re-adding a member keeps its state (no reset to muted)', () => {
    let s = addMember(createRoom(emptyRooms(), 'r'), 'r', { kind: 'wa-group', id: 'g1' });
    s = setMemberState(s, 'r', 'g1', 'active');
    s = addMember(s, 'r', { kind: 'wa-group', id: 'g1' });   // re-add
    expect(getRoom(s, 'r').members[0].state).toBe('active');
    expect(getRoom(s, 'r').members).toHaveLength(1);
  });

  it('roomsForMember finds membership + state across rooms', () => {
    let s = addMember(createRoom(emptyRooms(), 'a'), 'a', { kind: 'brain', id: 'e' });
    s = createRoom(s, 'b');
    s = addMember(s, 'b', { kind: 'brain', id: 'e', state: 'active' });
    const hits = roomsForMember(s, 'e');
    expect(hits.map(h => h.name).sort()).toEqual(['a', 'b']);
    expect(hits.find(h => h.name === 'b').state).toBe('active');
  });

  it('removeMember and deleteRoom', () => {
    let s = addMember(createRoom(emptyRooms(), 'r'), 'r', { kind: 'wa-group', id: 'g1' });
    s = removeMember(s, 'r', 'g1');
    expect(getRoom(s, 'r').members).toHaveLength(0);
    s = deleteRoom(s, 'r');
    expect(getRoom(s, 'r')).toBeNull();
    expect(listRooms(s)).toHaveLength(0);
  });

  it('does not mutate the input state (pure transforms)', () => {
    const s0 = createRoom(emptyRooms(), 'r');
    const s1 = addMember(s0, 'r', { kind: 'brain', id: 'e' });
    expect(getRoom(s0, 'r').members).toHaveLength(0);
    expect(getRoom(s1, 'r').members).toHaveLength(1);
  });
});
