// Phase 0b/0c (conversations↔rooms merge, GENOME §2.5): the Room ABSTRACTION
// and its two implementations. Characterization — the new layer must produce
// BYTE-IDENTICAL paths to the legacy roots (no behavior change), satisfy ONE
// identical tree, and exhibit the downstream-inheritance property (adding to the
// base flows to BOTH implementations).

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Room, ConversationRoom, NamedRoom } from '../src/room-core.mjs';
import { slugDir, slugTranscriptPath, sanitizeSlug } from '../conversations-state.mjs';
import { roomDir, roomFilesDir, sanitizeName } from '../src/rooms.mjs';

const HOME = homedir();

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
      const legacy = join(HOME, '.egpt', 'conversations', surface, sanitizeSlug(slug));
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

describe('NamedRoom — byte-identical to the legacy roomDir root', () => {
  for (const name of ['work', 'ChatGPT CDP', '']) {
    it(`baseDir matches legacy formula + roomDir for "${name}"`, () => {
      const room = Room.named(name);
      const legacy = join(HOME, '.egpt', 'rooms', sanitizeName(name));
      expect(room.baseDir()).toBe(legacy);
      expect(roomDir(name)).toBe(legacy);                    // delegation = byte-identical
      expect(room).toBeInstanceOf(NamedRoom);
    });
  }
  it('filesDir matches the legacy roomFilesDir', () => {
    const room = Room.named('work');
    expect(room.filesDir).toBe(roomFilesDir('work'));
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
  };
  for (const room of [Room.forChat('whatsapp', 'x'), Room.named('y')]) {
    for (const [getter, leaf] of Object.entries(tree)) {
      it(`${room.constructor.name}.${getter} = baseDir/${leaf}`, () => {
        expect(room[getter]).toBe(join(room.baseDir(), leaf));
      });
    }
  }
});

describe('downstream-inheritance: anything added to the base flows to BOTH', () => {
  it('a member added to Room.prototype is visible on ConversationRoom AND NamedRoom', () => {
    const conv = Room.forChat('whatsapp', 'x');
    const named = Room.named('y');
    Room.prototype.__probe = function () { return `probe:${this.baseDir()}`; };
    try {
      expect(conv.__probe()).toBe(`probe:${conv.baseDir()}`);
      expect(named.__probe()).toBe(`probe:${named.baseDir()}`);
    } finally {
      delete Room.prototype.__probe;
    }
  });
});
