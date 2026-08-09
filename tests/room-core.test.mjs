// Phase 0b/0c (conversations↔rooms merge, GENOME §2.5): the Room ABSTRACTION.
// Characterization — it must produce BYTE-IDENTICAL paths to the legacy root (no
// behavior change), satisfy ONE identical tree, and exhibit the
// downstream-inheritance property (adding to the base flows to the implementation).
//
// 2026-08-09: there is only ONE root now. An operator-named room is a conversation
// on surface `room` (conversations/room/<slug>/), so NamedRoom / Room.named /
// rooms.roomDir are gone and the old rooms/<name>/ characterization goes with them.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Room, ConversationRoom } from '../src/room-core.mjs';
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

// The old rooms/<name>/ root is GONE (2026-08-09). An operator-named room is not a second
// kind of Room: it is a conversation on surface `room`, so it roots under the SAME
// conversations tree and comes out of the SAME constructor. These were the roomDir
// characterization cases, rewritten against the new path.
describe('an operator-named room roots at conversations/room/<slug> — ONE kind, ONE formula', () => {
  for (const name of ['work', 'ChatGPT CDP', 'acim']) {
    it(`baseDir for room "${name}" is the conversations root, not rooms/<name>`, () => {
      const room = Room.forChat('room', name);
      expect(room.baseDir()).toBe(join(EGPT_HOME, 'conversations', 'room', sanitizeSlug(name)));
      expect(room.baseDir()).toBe(slugDir('room', name));     // delegation = byte-identical
      expect(room.baseDir()).not.toContain(join(EGPT_HOME, 'rooms'));
      expect(room).toBeInstanceOf(ConversationRoom);
    });
  }
  // sanitizeSlug (not the retired kebab sanitizeName) is what a room name goes through now:
  // a plain lowercase name must survive it untouched, so `/room create acim` and
  // resolveConvRoom('room','acim') land on the same folder.
  it('a plain room name survives sanitizeSlug unchanged', () => {
    expect(sanitizeSlug('acim')).toBe('acim');
    expect(Room.forChat('room', 'acim').baseDir()).toBe(join(EGPT_HOME, 'conversations', 'room', 'acim'));
  });
  it('filesDir is baseDir/files, same getter as any other Room', () => {
    const room = Room.forChat('room', 'work');
    expect(room.filesDir).toBe(join(room.baseDir(), 'files'));
  });
});

describe('the ONE identical tree (GENOME §2.5)', () => {
  const tree = {
    configPath: 'config.yaml',
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
