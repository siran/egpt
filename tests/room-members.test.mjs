// Phase 1a (conversations↔rooms merge, GENOME §2.5): the member model on the
// Room BASE — config.yaml members[] read/write, inherited by BOTH implementations.
// Additive: nothing in dispatch calls these yet, so no behavior change. The IO
// methods use baseDir(), so they're exercised here via a temp-dir Room subclass
// (no ~/.egpt pollution); the two real impls are checked for inheritance.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Room, ConversationRoom, NamedRoom, ROOM_MEMBER_STATES } from '../src/room-core.mjs';
// Re-export parity: rooms.mjs must still expose the moved primitives.
import { normalizeMemberState as nmsFromRooms, ROOM_MEMBER_STATES as statesFromRooms } from '../src/rooms.mjs';

class TmpRoom extends Room {
  constructor(dir) { super(); this._dir = dir; }
  baseDir() { return this._dir; }
}

let dir, room;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'egpt-rm-')); room = new TmpRoom(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('Room base — members round-trip', () => {
  it('no config → members() is []', async () => {
    expect(await room.members()).toEqual([]);
  });

  it('setMember adds, members() reads back normalized', async () => {
    await room.setMember({ kind: 'brain', id: 'e', state: 'active' });
    await room.setMember({ kind: 'brain', id: 'l', state: 'mention' });
    expect(await room.members()).toEqual([
      { kind: 'brain', id: 'e', state: 'active' },
      { kind: 'brain', id: 'l', state: 'mention' },
    ]);
    expect(await room.memberState('e')).toBe('active');
    expect(await room.memberState('absent')).toBeNull();
  });

  it('setMember updates an existing member by id (no dupes)', async () => {
    await room.setMember({ id: 'e', state: 'active' });
    await room.setMember({ id: 'e', state: 'muted' });
    const ms = await room.members();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: 'e', state: 'muted', kind: 'brain' });
  });

  it('state aliases normalize (on→active, mute→muted, unmute→active)', async () => {
    await room.setMember({ id: 'e', state: 'on' });
    await room.setMember({ id: 'l', state: 'mute' });
    expect(await room.memberState('e')).toBe('active');
    expect(await room.memberState('l')).toBe('muted');
  });

  it('removeMember removes by id; returns false when absent', async () => {
    await room.setMember({ id: 'e', state: 'active' });
    expect(await room.removeMember('e')).toBe(true);
    expect(await room.members()).toEqual([]);
    expect(await room.removeMember('e')).toBe(false);
  });

  it('rejects unknown kind / state', async () => {
    await expect(room.setMember({ id: 'e', kind: 'wizard', state: 'active' })).rejects.toThrow(/unknown kind/);
    await expect(room.setMember({ id: 'e', state: 'loud' })).rejects.toThrow(/unknown state/);
    await expect(room.setMember({ state: 'active' })).rejects.toThrow(/id required/);
  });

  it('preserves a sibling config block AND its comments on write', async () => {
    writeFileSync(room.configPath, '# operator notes\nheartbeat:\n  enabled: true   # keep me\n  interval_min: 30\n');
    await room.setMember({ id: 'e', state: 'active' });
    const text = readFileSync(room.configPath, 'utf8');
    expect(text).toContain('# operator notes');
    expect(text).toContain('# keep me');
    expect(text).toContain('interval_min: 30');
    // and the heartbeat block is still parseable + intact alongside members
    const cfg = await room.loadConfig();
    expect(cfg.heartbeat).toMatchObject({ enabled: true, interval_min: 30 });
    expect(cfg.members).toEqual([{ kind: 'brain', id: 'e', state: 'active' }]);
  });

  it('extra per-member fields are preserved', async () => {
    await room.setMember({ kind: 'brain', id: 'l', state: 'active', emoji: '🦙', bio: 'local' });
    expect((await room.members())[0]).toMatchObject({ id: 'l', emoji: '🦙', bio: 'local' });
  });
});

describe('downstream-inheritance + re-export parity', () => {
  it('ConversationRoom AND NamedRoom inherit the member methods', () => {
    for (const r of [Room.forChat('whatsapp', 'x'), Room.named('y')]) {
      for (const m of ['loadConfig', 'members', 'memberState', 'setMember', 'removeMember']) {
        expect(typeof r[m]).toBe('function');
      }
    }
  });
  it('rooms.mjs still re-exports the moved member primitives', () => {
    expect(nmsFromRooms('on')).toBe('active');
    expect(statesFromRooms).toEqual(ROOM_MEMBER_STATES);
  });

  it('member state IS the full 6-state auto-mode (one gate, zero loss)', () => {
    expect(ROOM_MEMBER_STATES).toEqual(['muted', 'mention', 'active', 'mention-direct', 'off', 'accum']);
  });
});

describe('member state ↔ auto-mode normalization (lossless mapping)', () => {
  it('every auto_e_mode token maps to a canonical member state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-rm6-'));
    const r = new TmpRoom(dir);
    try {
      const map = { on: 'active', mute: 'muted', mention: 'mention', 'mention-direct': 'mention-direct', off: 'off', accum: 'accum' };
      for (const [mode, canon] of Object.entries(map)) {
        await r.setMember({ id: `m-${mode}`, state: mode });
        expect(await r.memberState(`m-${mode}`)).toBe(canon);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
