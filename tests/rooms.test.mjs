import { describe, it, expect } from 'vitest';
import {
  emptyRooms, createRoom, deleteRoom, addMember, removeMember,
  setMemberState, getRoom, listRooms, roomsForMember, sanitizeName,
  sessionsMapFromMembers, DEFAULT_MEMBER_STATE,
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

describe('brain members carry their session (sessions→members unification)', () => {
  it('addMember stores brain + options + emoji for a brain member', () => {
    let s = createRoom(emptyRooms(), 'r');
    s = addMember(s, 'r', { kind: 'brain', id: 'cgpt1', brain: 'chatgpt-cdp', options: { targetId: 'ABC' }, emoji: '🦊' });
    const m = getRoom(s, 'r').members[0];
    expect(m).toMatchObject({ kind: 'brain', id: 'cgpt1', brain: 'chatgpt-cdp', emoji: '🦊', state: 'muted' });
    expect(m.options).toEqual({ targetId: 'ABC' });
  });

  it('re-adding a brain merges session fields but keeps state', () => {
    let s = addMember(createRoom(emptyRooms(), 'r'), 'r', { kind: 'brain', id: 'cgpt1', brain: 'chatgpt-cdp', options: { targetId: 'OLD' } });
    s = setMemberState(s, 'r', 'cgpt1', 'active');
    s = addMember(s, 'r', { kind: 'brain', id: 'cgpt1', options: { targetId: 'NEW' } });   // /attach updates the tab
    const m = getRoom(s, 'r').members[0];
    expect(m.state).toBe('active');                  // state preserved
    expect(m.brain).toBe('chatgpt-cdp');             // untouched field kept
    expect(m.options).toEqual({ targetId: 'NEW' });  // updated
    expect(getRoom(s, 'r').members).toHaveLength(1);
  });

  it('non-brain members ignore brain/options fields', () => {
    const s = addMember(createRoom(emptyRooms(), 'r'), 'r', { kind: 'wa-group', id: 'g1', brain: 'x', options: { y: 1 } });
    const m = getRoom(s, 'r').members[0];
    expect(m.brain).toBeUndefined();
    expect(m.options).toBeUndefined();
  });

  it('sessionsMapFromMembers reconstructs the sessions map from brain members only', () => {
    let s = createRoom(emptyRooms(), 'r');
    s = addMember(s, 'r', { kind: 'wa-group', id: 'g1' });                                  // skipped (not a session)
    s = addMember(s, 'r', { kind: 'brain', id: 'cgpt1', brain: 'chatgpt-cdp', options: { targetId: 'T1' }, emoji: '🦊' });
    s = addMember(s, 'r', { kind: 'brain', id: 'e', brain: 'ccode', options: {} });
    const map = sessionsMapFromMembers(s, 'r');
    expect(Object.keys(map).sort()).toEqual(['cgpt1', 'e']);
    expect(map.cgpt1).toEqual({ brain: 'chatgpt-cdp', options: { targetId: 'T1' }, emoji: '🦊' });
    expect(map.e).toEqual({ brain: 'ccode', options: {} });
  });

  it('sessionsMapFromMembers returns {} for an unknown room', () => {
    expect(sessionsMapFromMembers(emptyRooms(), 'nope')).toEqual({});
  });
});

import { normalizeMemberState, isMemberStateAlias } from '../src/rooms.mjs';

describe('normalizeMemberState — operator-friendly aliases', () => {
  it('maps the canonical words to themselves', () => {
    expect(normalizeMemberState('muted')).toBe('muted');
    expect(normalizeMemberState('mention')).toBe('mention');
    expect(normalizeMemberState('active')).toBe('active');
  });
  it('maps active aliases to "active"', () => {
    for (const a of ['on', 'unmute', 'unmuted', 'open', 'ACTIVE', '  on  '])
      expect(normalizeMemberState(a)).toBe('active');
  });
  it('maps muted aliases to "muted"', () => {
    for (const a of ['mute', 'silent', 'MUTED'])
      expect(normalizeMemberState(a)).toBe('muted');
  });
  it('returns null for unknown tokens', () => {
    expect(normalizeMemberState('whatever')).toBe(null);
    expect(normalizeMemberState('')).toBe(null);
    expect(normalizeMemberState(null)).toBe(null);
  });
  it('isMemberStateAlias is true for known + false for unknown', () => {
    expect(isMemberStateAlias('on')).toBe(true);
    expect(isMemberStateAlias('whatever')).toBe(false);
  });
});
