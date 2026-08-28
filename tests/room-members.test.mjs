// Phase 1a (conversations↔rooms merge, GENOME §2.5): the member model on the
// Room BASE — config.yaml members[] read/write, inherited by BOTH implementations.
// Additive: nothing in dispatch calls these yet, so no behavior change. The IO
// methods use baseDir(), so they're exercised here via a temp-dir Room subclass
// (no ~/.egpt pollution); the two real impls are checked for inheritance.

import { describe, it, expect, beforeEach, afterEach , vi } from 'vitest';
// A PRIVATE profile for this file. The ROOM RUNG is now ONE shared file
// (config/rooms.yaml), so files running in parallel against the suite's shared
// throwaway profile would race on it. egpt-home.mjs freezes EGPT_HOME at module
// load, so this must run BEFORE the imports — vi.hoisted is what does that.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-room-members-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { Room, ROOM_MEMBER_STATES, normalizeMemberState, isMemberStateAlias } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { ROOMS_FILE } from '../src/rooms-file.mjs';
import { rmSync as _rmRooms } from 'node:fs';

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

  it('setMemberState changes ONLY the state, preserving the brain extras', async () => {
    // a brain member carries adapter/url/targetId — a mode flip must not clobber them
    await room.setMember({ kind: 'brain', id: 'chatgpt', state: 'muted', adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1' });
    await room.setMemberState('chatgpt', 'mention');
    expect(await room.memberState('chatgpt')).toBe('mention');
    expect((await room.members())[0]).toMatchObject({ id: 'chatgpt', state: 'mention', adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1' });
  });

  it('setMemberState errors on an absent member and on an unknown state', async () => {
    await room.setMember({ id: 'e', state: 'active' });
    await expect(room.setMemberState('ghost', 'muted')).rejects.toThrow(/no member/);
    await expect(room.setMemberState('e', 'loud')).rejects.toThrow(/unknown state/);
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
    // The rung is config/rooms.yaml now, keyed by ns — a member write must not
    // disturb the operator's other blocks in that room's row, nor their comments.
    mkdirSync(dirname(ROOMS_FILE), { recursive: true });
    writeFileSync(ROOMS_FILE,
      `# operator notes
rooms:
  ${room.ns()}:
    heartbeat:
      enabled: true   # keep me
      interval_min: 30
`);
    await room.setMember({ id: 'e', state: 'active' });
    const text = readFileSync(ROOMS_FILE, 'utf8');
    expect(text).toContain('# operator notes');
    expect(text).toContain('# keep me');
    expect(text).toContain('interval_min: 30');
    const cfg = await room.loadConfig();
    expect(cfg.heartbeat).toMatchObject({ enabled: true, interval_min: 30 });
    expect(cfg.members).toEqual([{ kind: 'brain', id: 'e', state: 'active' }]);
  });

  it('extra per-member fields are preserved', async () => {
    await room.setMember({ kind: 'brain', id: 'l', state: 'active', emoji: '🦙', bio: 'local' });
    expect((await room.members())[0]).toMatchObject({ id: 'l', emoji: '🦙', bio: 'local' });
  });
});

describe('downstream-inheritance', () => {
  it('a chat room AND an operator-named room inherit the member methods', () => {
    for (const r of [Room.forChat('whatsapp', 'x'), Room.forChat('room', 'y')]) {
      for (const m of ['loadConfig', 'members', 'memberState', 'setMember', 'removeMember']) {
        expect(typeof r[m]).toBe('function');
      }
    }
  });

  it('member state IS the full 6-state auto-mode (one gate, zero loss)', () => {
    expect(ROOM_MEMBER_STATES).toEqual(['muted', 'mention', 'active', 'mention-direct', 'off', 'accum']);
  });
});

// The folder moved out of conversations/ (operator 2026-08-28) — the MEMBER MODEL did not.
// The 2026-08-09 @chatgpt bug was TWO paths for one room: /members wrote one file, the relay
// read another. These lock that shut across the move: ONE folder (the new root), ONE roster
// (add/read/remove through instances from the SAME constructor), ONE rung row (still keyed
// `room/<slug>`, so an operator's heartbeats:/members:/access_level: block is still found).
describe('an operator-named room after the move — ONE folder, ONE roster, ONE rung key', () => {
  const NAME = 'acim';
  let acim;
  beforeEach(() => {
    rmSync(ROOMS_FILE, { force: true });                                 // fixed ns → no row leaks
    acim = Room.forChat('room', NAME);
    rmSync(acim.baseDir(), { recursive: true, force: true });
  });
  afterEach(() => { rmSync(acim.baseDir(), { recursive: true, force: true }); });

  it('roots at rooms/<slug> and keys its rung row room/<slug>', async () => {
    expect(acim.baseDir()).toBe(join(EGPT_HOME, 'rooms', NAME));
    expect(acim.ns()).toBe(`room/${NAME}`);
  });

  it('add → read → remove: a member written here is read back by a SEPARATE instance', async () => {
    await acim.setMember({ kind: 'brain', id: 'chatgpt', state: 'active', adapter: 'chatgpt-cdp' });
    // the relay's read side: a fresh Room from the SAME (surface, slug) constructor
    expect(await Room.forChat('room', NAME).members()).toMatchObject([{ id: 'chatgpt', state: 'active', adapter: 'chatgpt-cdp' }]);
    // ONE row, in the ONE rung file, under the ns key — not a second file beside it
    const rows = YAML.parse(readFileSync(ROOMS_FILE, 'utf8')).rooms;
    expect(Object.keys(rows)).toEqual([`room/${NAME}`]);
    expect(rows[`room/${NAME}`].members).toHaveLength(1);
    expect(await acim.removeMember('chatgpt')).toBe(true);
    expect(await Room.forChat('room', NAME).members()).toEqual([]);
  });

  it('an operator block already written under room/<slug> survives the move (same key)', async () => {
    mkdirSync(dirname(ROOMS_FILE), { recursive: true });
    writeFileSync(ROOMS_FILE, `rooms:\n  room/${NAME}:\n    heartbeats:\n      - every: 30m\n    access_level: all\n`);
    const cfg = await acim.loadConfig();
    expect(cfg.access_level).toBe('all');
    expect(cfg.heartbeats).toEqual([{ every: '30m' }]);
    await acim.setMember({ id: 'e', state: 'active' });                  // a write keeps the row
    const row = YAML.parse(readFileSync(ROOMS_FILE, 'utf8')).rooms[`room/${NAME}`];
    expect(row.access_level).toBe('all');
    expect(row.heartbeats).toEqual([{ every: '30m' }]);
    expect(row.members).toEqual([{ kind: 'brain', id: 'e', state: 'active' }]);
  });

  it('the whole tree follows the new baseDir', () => {
    for (const [getter, leaf] of Object.entries({
      transcriptPath: 'transcript.md', mediaDir: 'media', filesDir: 'files',
      identityDir: 'identity.d', scriptsDir: 'scripts', transcriptsDir: 'transcripts',
    })) expect(acim[getter]).toBe(join(EGPT_HOME, 'rooms', NAME, leaf));
  });
});

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
