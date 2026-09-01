// Phase 0b/0c (conversations↔rooms merge, GENOME §2.5): the Room ABSTRACTION.
// Characterization — it must produce BYTE-IDENTICAL paths to the legacy root (no
// behavior change), satisfy ONE identical tree, and exhibit the
// downstream-inheritance property (adding to the base flows to the implementation).
//
// 2026-08-09: there is only ONE Room KIND. An operator-named room is a conversation on
// surface `room`, so NamedRoom / Room.named / rooms.roomDir are gone.
//
// 2026-08-28 (operator): conversations/ is THE BEEPER TREE — *"voice, instagram, telegram,
// whatsapp, matrix is all under beeper, only rooms is not… rooms does belong outside
// conversations"*. A room's FOLDER therefore moves back out to rooms/<slug>/. That is the
// ONLY difference: same chatId, same ns `room/<slug>` (so every config/rooms.yaml key is
// byte-identical), same ONE member model / ONE tree, same constructor.

import { describe, it, expect } from 'vitest';
import { join, relative, sep } from 'node:path';
import { Room, ConversationRoom, CONVERSATIONS_ROOT } from '../src/room-core.mjs';
import { slugDir, slugTranscriptPath, sanitizeSlug } from '../src/conversations-state.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';

// The legacy roots derive from EGPT_HOME (the profile), NOT a hardcoded ~/.egpt: under
// the suite's isolated EGPT_HOME (tests/setup-egpt-home.mjs, 2026-07-08) that formula IS
// the byte-identical target, and it still equals join(homedir(),'.egpt',…) when unset.

describe('Room — abstract base', () => {
  it('baseDir() throws on the base (must be implemented by a subclass)', () => {
    expect(() => new Room().baseDir()).toThrow(/abstract/);
  });
});

describe('ConversationRoom — byte-identical to the legacy slugDir root', () => {
  const cases = [['whatsapp', 'diego'], ['telegram', 'Tío Jesús Palma'], ['whatsapp', 'a/b:c*d']];
  for (const [surface, slug] of cases) {
    it(`baseDir matches legacy formula + slugDir for ${surface}/${slug}`, () => {
      const room = Room.forChat(surface, slug);
      const legacy = join(EGPT_HOME, 'conversations', surface, sanitizeSlug(slug));
      expect(room.baseDir()).toBe(legacy);
      expect(slugDir(surface, slug)).toBe(legacy);           // delegation = byte-identical
      expect(room).toBeInstanceOf(ConversationRoom);
    });
  }
  it('transcriptPath matches the legacy slugTranscriptPath', () => {
    const room = Room.forChat('whatsapp', 'diego');
    expect(room.transcriptPath).toBe(slugTranscriptPath('whatsapp', 'diego'));
    expect(room.transcriptPath).toBe(join(room.baseDir(), 'transcript.md'));
  });
});

// An operator-named room is not a second KIND of Room — it is a conversation on surface
// `room`, out of the SAME constructor, with the SAME tree. It simply does not arrive
// through Beeper, so its folder sits OUTSIDE the Beeper tree (operator 2026-08-28).
describe('an operator-named room roots at rooms/<slug> — outside the Beeper tree', () => {
  for (const name of ['work', 'ChatGPT CDP', 'acim']) {
    it(`baseDir for room "${name}" is the rooms root, not conversations/room/<name>`, () => {
      const room = Room.forChat('room', name);
      expect(room.baseDir()).toBe(join(EGPT_HOME, 'rooms', sanitizeSlug(name)));
      expect(room.baseDir()).toBe(slugDir('room', name));     // delegation = byte-identical
      expect(room.baseDir()).not.toContain(join(EGPT_HOME, 'conversations'));
      expect(room).toBeInstanceOf(ConversationRoom);
    });
  }
  // THE REGRESSION GUARD: the folder moved, the NAMESPACE did not. ns() is what keys
  // config/rooms.yaml (heartbeats:/members:/access_level:) and what listEntityDirs emits —
  // a room whose ns drifted with its folder would silently lose the operator's whole block.
  for (const name of ['work', 'ChatGPT CDP', 'acim']) {
    it(`ns() for room "${name}" is still room/<slug>`, () => {
      expect(Room.forChat('room', name).ns()).toBe(`room/${sanitizeSlug(name)}`);
    });
  }
  it('a chat on any other surface still roots INSIDE conversations/', () => {
    expect(Room.forChat('whatsapp', 'x').baseDir()).toBe(join(EGPT_HOME, 'conversations', 'whatsapp', 'x'));
    expect(Room.forChat('whatsapp', 'x').ns()).toBe('whatsapp/x');
  });
  // sanitizeSlug (not the retired kebab sanitizeName) is what a room name goes through now:
  // a plain lowercase name must survive it untouched, so `/rooms create acim` and
  // resolveConvRoom('room','acim') land on the same folder.
  it('a plain room name survives sanitizeSlug unchanged', () => {
    expect(sanitizeSlug('acim')).toBe('acim');
    expect(Room.forChat('room', 'acim').baseDir()).toBe(join(EGPT_HOME, 'rooms', 'acim'));
  });
  it('filesDir is baseDir/files, same getter as any other Room', () => {
    const room = Room.forChat('room', 'work');
    expect(room.filesDir).toBe(join(room.baseDir(), 'files'));
  });
});

// 2026-09-01 (operator): an AGENT's own conversation is the third such kind — `agent/wren`
// is a real folder-backed conversation, exactly as `room/acim` is one, but it is NOT a room:
// *"agents/wren/ holds the Room instance from wren as a conversation"*. Surface `agent`
// therefore roots at agents/<name>/, beside rooms/ and the Beeper tree, through the SAME
// surface→root map — one more branch of ONE expression, no second kind of Room.
describe('an agent roots at agents/<name> — the third entity root', () => {
  for (const name of ['wren', 'Meta Engineer']) {
    it(`baseDir for agent "${name}" is the agents root, not conversations/agent/<name>`, () => {
      const room = Room.forChat('agent', name);
      expect(room.baseDir()).toBe(join(EGPT_HOME, 'agents', sanitizeSlug(name)));
      expect(room.baseDir()).not.toContain(join(EGPT_HOME, 'conversations'));
      expect(room.baseDir()).not.toContain(join(EGPT_HOME, 'rooms'));
      expect(room).toBeInstanceOf(ConversationRoom);
    });
    // ConversationRoom.ns() derives from (surface, slug) DIRECTLY, so it needed no change —
    // this is the lock that says so: the key config/rooms.yaml is written under.
    it(`ns() for agent "${name}" is agent/<name>`, () => {
      expect(Room.forChat('agent', name).ns()).toBe(`agent/${sanitizeSlug(name)}`);
    });
  }
  it('agent/wren is a full Room: the same ONE tree, under the agents root', () => {
    const room = Room.forChat('agent', 'wren');
    expect(room.baseDir()).toBe(join(EGPT_HOME, 'agents', 'wren'));
    expect(room.transcriptPath).toBe(join(EGPT_HOME, 'agents', 'wren', 'transcript.md'));
    expect(room.filesDir).toBe(join(EGPT_HOME, 'agents', 'wren', 'files'));
    expect(room.identityDir).toBe(join(EGPT_HOME, 'agents', 'wren', 'identity.d'));
  });
});

// The INVERSE of that map: the BASE class derives ns() from baseDir() alone. The three roots
// are SIBLINGS under EGPT_HOME, so the CHECK ORDER matters — conversations/ is the
// unconditional LAST fallback, and the two prefix tests above it must be mutually exclusive
// or a folder under one root keys as `../<other>/<name>` and silently loses the operator's
// rooms.yaml block.
describe('Room base ns() — the inverse map and its check order', () => {
  class FixedRoom extends Room {
    constructor(dir) { super(); this.dir = dir; }
    baseDir() { return this.dir; }
  }

  it('a folder under the AGENTS root keys as agent/<name>, not ../agents/<name>', () => {
    const ns = new FixedRoom(join(EGPT_HOME, 'agents', 'wren')).ns();
    expect(ns).toBe('agent/wren');
    expect(ns.startsWith('..')).toBe(false);
  });
  it('a folder under the ROOMS root still keys as room/<slug> (unchanged)', () => {
    expect(new FixedRoom(join(EGPT_HOME, 'rooms', 'acim')).ns()).toBe('room/acim');
  });
  it('a folder under the Beeper tree still keys as <surface>/<slug> (unchanged)', () => {
    expect(new FixedRoom(join(EGPT_HOME, 'conversations', 'whatsapp', 'diego')).ns()).toBe('whatsapp/diego');
  });
  // path.relative is SEGMENT-aware, so a sibling that merely shares a root's name prefix is
  // not swallowed by that root's check — it falls through to the conversations/ fallback.
  it('no root swallows a sibling that merely shares its name prefix', () => {
    expect(new FixedRoom(join(EGPT_HOME, 'agents-archive', 'x')).ns()).toBe('../agents-archive/x');
    expect(new FixedRoom(join(EGPT_HOME, 'roomsx', 'y')).ns()).toBe('../roomsx/y');
  });
  it('a folder under NO root relativizes against conversations/ exactly as before', () => {
    const fixture = join(EGPT_HOME, '..', 'egpt-tmp-fixture', 'conv');
    const ns = new FixedRoom(fixture).ns();
    expect(ns).toBe(relative(CONVERSATIONS_ROOT, fixture).split(sep).join('/'));
    expect(ns.startsWith('..')).toBe(true);
  });
});

describe('the ONE identical tree (GENOME §2.5)', () => {
  const tree = {
    transcriptPath: 'transcript.md',
    mediaDir: 'media',
    filesDir: 'files',
    identityDir: 'identity.d',
    scriptsDir: 'scripts',
    transcriptsDir: 'transcripts',
  };
  for (const [label, room] of [['chat', Room.forChat('whatsapp', 'x')], ['named room', Room.forChat('room', 'y')]]) {
    for (const [getter, leaf] of Object.entries(tree)) {
      it(`${label}.${getter} = baseDir/${leaf}`, () => {
        expect(room[getter]).toBe(join(room.baseDir(), leaf));
      });
    }
  }
});

describe('downstream-inheritance: anything added to the base flows to BOTH', () => {
  it('a member added to Room.prototype is visible on a chat room AND a named room', () => {
    const conv = Room.forChat('whatsapp', 'x');
    const named = Room.forChat('room', 'y');
    Room.prototype.__probe = function () { return `probe:${this.baseDir()}`; };
    try {
      expect(conv.__probe()).toBe(`probe:${conv.baseDir()}`);
      expect(named.__probe()).toBe(`probe:${named.baseDir()}`);
    } finally {
      delete Room.prototype.__probe;
    }
  });
});
