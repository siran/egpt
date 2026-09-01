// list-entity-dirs.test.mjs — THE walk (src/spine/boot.mjs listEntityDirs).
//
// It is the ONE enumeration of entity folders: it feeds the config resolver, which serves
// every per-entity reader (heartbeats, warm, transcription, /radio). Adding a second walk
// anywhere is the bug it replaced — so when a room's folder moved OUT of conversations/
// (operator 2026-08-28: conversations/ is the BEEPER tree, "rooms does belong outside
// conversations"), this walk had to grow the second ROOT, not a second walk.
//
// The ns it emits must stay `room/<slug>` — byte-identical to ConversationRoom.ns(), which
// is what keys config/rooms.yaml. A room whose ns drifted with its folder would lose the
// operator's heartbeats:/members:/access_level: block silently.
//
// 2026-09-01: the THIRD root, agents/<name>/ (ns `agent/<name>`) — an agent's own
// conversation is not a room, so it roots beside rooms/ — joined the SAME walk for the same
// reason: a third enumeration anywhere would be that bug again.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file: the walk reads the REAL EGPT_HOME, and egpt-home.mjs
// freezes it at module load, so this must run BEFORE the imports below (vi.hoisted).
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-entity-walk-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listEntityDirs } from '../src/spine/boot.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';

beforeAll(() => {
  expect(join(EGPT_HOME)).toBe(join(TEST_HOME));     // tripwire: never the live profile
  expect(EGPT_HOME).not.toBe(join(homedir(), '.egpt'));
  rmSync(TEST_HOME, { recursive: true, force: true });
  for (const p of [
    ['conversations', 'whatsapp', 'diego'],
    ['conversations', 'telegram', 'tio-jesus'],
    ['rooms', 'acim'],
    ['rooms', 'dj-son'],
    ['agents', 'wren'],
    ['agents', 'carol'],
  ]) mkdirSync(join(EGPT_HOME, ...p), { recursive: true });
  writeFileSync(join(EGPT_HOME, 'rooms', 'notes.md'), 'not an entity\n');
});
afterAll(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });

describe('listEntityDirs — one walk, three roots', () => {
  it('yields every room folder from the NEW root with ns room/<name>', async () => {
    const out = await listEntityDirs();
    for (const name of ['acim', 'dj-son']) {
      expect(out).toContainEqual({ dir: join(EGPT_HOME, 'rooms', name), ns: `room/${name}` });
      // the ns is the SAME string the Room computes — the config/rooms.yaml key
      expect(Room.forChat('room', name).ns()).toBe(`room/${name}`);
    }
  });

  it('yields every agent folder from the agents root with ns agent/<name>', async () => {
    const out = await listEntityDirs();
    for (const name of ['wren', 'carol']) {
      expect(out).toContainEqual({ dir: join(EGPT_HOME, 'agents', name), ns: `agent/${name}` });
      // the ns is the SAME string the Room computes — the config/rooms.yaml key
      expect(Room.forChat('agent', name).ns()).toBe(`agent/${name}`);
      expect(Room.forChat('agent', name).baseDir()).toBe(join(EGPT_HOME, 'agents', name));
    }
  });

  it('still yields conversations/<surface>/<slug> unchanged', async () => {
    const out = await listEntityDirs();
    expect(out).toContainEqual({ dir: join(EGPT_HOME, 'conversations', 'whatsapp', 'diego'), ns: 'whatsapp/diego' });
    expect(out).toContainEqual({ dir: join(EGPT_HOME, 'conversations', 'telegram', 'tio-jesus'), ns: 'telegram/tio-jesus' });
  });

  it('emits each entity exactly ONCE (one walk, not two)', async () => {
    const out = await listEntityDirs();
    expect(new Set(out.map((e) => e.ns)).size).toBe(out.length);
    expect(out).toHaveLength(6);
  });

  it('a plain file under rooms/ is not an entity', async () => {
    const out = await listEntityDirs();
    expect(out.map((e) => e.ns)).not.toContain('room/notes.md');
  });

  it('a missing rooms/ root is tolerated (a fresh profile has none)', async () => {
    rmSync(join(EGPT_HOME, 'rooms'), { recursive: true, force: true });
    const out = await listEntityDirs();
    expect(out.map((e) => e.ns).sort()).toEqual(['agent/carol', 'agent/wren', 'telegram/tio-jesus', 'whatsapp/diego']);
    mkdirSync(join(EGPT_HOME, 'rooms', 'acim'), { recursive: true });     // restore for the rest
    mkdirSync(join(EGPT_HOME, 'rooms', 'dj-son'), { recursive: true });
    writeFileSync(join(EGPT_HOME, 'rooms', 'notes.md'), 'not an entity\n');
  });

  it('a missing agents/ root is tolerated (a fresh profile has none)', async () => {
    rmSync(join(EGPT_HOME, 'agents'), { recursive: true, force: true });
    const out = await listEntityDirs();
    expect(out.map((e) => e.ns).sort()).toEqual(['room/acim', 'room/dj-son', 'telegram/tio-jesus', 'whatsapp/diego']);
    mkdirSync(join(EGPT_HOME, 'agents', 'wren'), { recursive: true });    // restore for the rest
    mkdirSync(join(EGPT_HOME, 'agents', 'carol'), { recursive: true });
  });
});
