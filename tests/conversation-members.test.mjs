// Phase 1b-ii (conversations↔rooms merge): the pure seeding resolver that bridges
// the legacy residents_per_chat + per-being auto-mode into the unified members[].
// Locks the EXACT legacy roster logic (so 1b-iii wiring is behavior-preserving)
// and the lossless auto-mode→member-state seed.

import { describe, it, expect } from 'vitest';
import { resolveRoster, seedMembers, resolveMembers, residentsFromMembers } from '../src/conversation-members.mjs';

const CHAT = '!c:beeper.local';

describe('resolveRoster — exact reproduction of the legacy residents logic', () => {
  it('per-chat override wins over the global list', () => {
    expect(resolveRoster({
      chatId: CHAT,
      residentsPerChat: { [CHAT]: ['l'] },
      globalResidents: ['e', 'l'],
    })).toEqual(['l']);
  });

  it('falls back to the global list, then to the persona alone', () => {
    expect(resolveRoster({ chatId: CHAT, residentsPerChat: {}, globalResidents: ['e', 'l'] })).toEqual(['e', 'l']);
    expect(resolveRoster({ chatId: CHAT, residentsPerChat: {}, globalResidents: null, personaBeing: 'e' })).toEqual(['e']);
  });

  it('drops disabled siblings; if that empties it, falls back to the persona', () => {
    expect(resolveRoster({
      chatId: CHAT, residentsPerChat: { [CHAT]: ['e', 'v', 'do'] },
      siblings: { v: { enabled: false }, do: { enabled: false } },
    })).toEqual(['e']);
    expect(resolveRoster({
      chatId: CHAT, residentsPerChat: { [CHAT]: ['v'] },
      siblings: { v: { enabled: false } }, personaBeing: 'e',
    })).toEqual(['e']);
  });

  it('accepts the toggle-map / enable-map resident forms (via normalizeResidents)', () => {
    expect(resolveRoster({ chatId: CHAT, residentsPerChat: { [CHAT]: { e: true, l: false } } })).toEqual(['e']);
  });
});

describe('seedMembers — roster + modeFor → brain members (lossless state)', () => {
  it('maps each being\'s auto-mode into a canonical member state', () => {
    const modeFor = (b) => ({ e: 'on', l: 'mention', x: 'mute', y: 'off', z: 'accum', w: 'mention-direct' }[b]);
    expect(seedMembers({ roster: ['e', 'l', 'x', 'y', 'z', 'w'], modeFor })).toEqual([
      { kind: 'brain', id: 'e', state: 'active' },        // on → active
      { kind: 'brain', id: 'l', state: 'mention' },
      { kind: 'brain', id: 'x', state: 'muted' },         // mute → muted
      { kind: 'brain', id: 'y', state: 'off' },
      { kind: 'brain', id: 'z', state: 'accum' },
      { kind: 'brain', id: 'w', state: 'mention-direct' },
    ]);
  });

  it('falls back to the default member state when modeFor yields nothing usable', () => {
    expect(seedMembers({ roster: ['e'], modeFor: () => undefined })).toEqual([{ kind: 'brain', id: 'e', state: 'muted' }]);
  });
});

describe('resolveMembers — explicit members[] wins over the seed', () => {
  const roster = ['e', 'l'];
  const modeFor = () => 'on';
  it('uses the explicit config.yaml members[] when present (seed ignored)', () => {
    const explicit = [{ kind: 'brain', id: 'e', state: 'mention' }];
    expect(resolveMembers({ explicitMembers: explicit, roster, modeFor })).toBe(explicit);
  });
  it('seeds from the legacy config when there is no explicit members[]', () => {
    expect(resolveMembers({ explicitMembers: [], roster, modeFor })).toEqual([
      { kind: 'brain', id: 'e', state: 'active' },
      { kind: 'brain', id: 'l', state: 'active' },
    ]);
  });
});

describe('residentsFromMembers — the dispatch roster (receives = state != off)', () => {
  it('includes every brain member except off; muted still receives', () => {
    const members = [
      { kind: 'brain', id: 'e', state: 'active' },
      { kind: 'brain', id: 'l', state: 'muted' },     // receives (lurks), still a resident
      { kind: 'brain', id: 'x', state: 'off' },       // excluded
      { kind: 'wa-group', id: '!g', state: 'active' },// not a brain → excluded
    ];
    expect(residentsFromMembers(members)).toEqual(['e', 'l']);
  });
});
