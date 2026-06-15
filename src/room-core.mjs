// room-core.mjs — the Room ABSTRACTION (GENOME §2.5; ROOMS-MERGE-PLAN Phase 0).
//
// A Room is a host to members, files, media, and a transcript. A surface chat
// (1:1 or group) natively fulfils that contract, so a conversation IS a Room —
// it is NOT a thing a Room points at. `Room` is the ABSTRACTION; the two roots
// are two IMPLEMENTATIONS — the unifier:
//   ConversationRoom → conversations/<surface>/<slug>/   (born from a chat, 1 host)
//   NamedRoom        → rooms/<name>/                      (operator-named, ≥1 hosts)
//
// The base owns the IDENTICAL folder tree (derived from baseDir()); the two
// subclasses override ONLY baseDir(). **Anything added to the base flows
// downstream to both** — that is the whole point of an abstraction over a shared
// helper. Behavior methods (appendTranscript / saveMedia / members / hosts /
// confine wiring) land on the base in later phases; Phase 0 introduces the tree
// + resolvers with NO behavior change, and conversations-state.slugDir /
// rooms.roomDir DELEGATE here so paths stay byte-identical.
//
// Depends only on the leaf src/sanitize.mjs (+ node builtins): it imports nothing
// from conversations-state.mjs or src/rooms.mjs, so those modules can delegate to
// it without an import cycle (that is why Phase 0a moved the sanitizers).

import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeSlug, sanitizeName } from './sanitize.mjs';

/**
 * The Room abstraction. Subclasses implement baseDir(); every path in the tree
 * derives from it, so adding a derived member here adds it to BOTH roots.
 */
export class Room {
  /** The root folder of this Room. Subclasses MUST implement this. */
  baseDir() {
    throw new Error('Room is abstract — baseDir() must be implemented by a subclass (ConversationRoom / NamedRoom)');
  }

  // ── the identical tree (GENOME §2.5) ──────────────────────────────────────
  get configPath()     { return join(this.baseDir(), 'config.yaml'); }     // members · personality · thread · heartbeat · transcription service
  get transcriptPath() { return join(this.baseDir(), 'transcript.md'); }   // first-class, rolling window (I3)
  get mediaDir()       { return join(this.baseDir(), 'media'); }           // per-room downloads (C2)
  get filesDir()       { return join(this.baseDir(), 'files'); }           // operator /inject — the shared shelf
  get identityDir()    { return join(this.baseDir(), 'identity.d'); }      // NN-*.md fed to the room's brain(s)

  // ── resolvers ─────────────────────────────────────────────────────────────
  /** Room born from a surface chat (one host). */
  static forChat(surface, slug) { return new ConversationRoom(surface, slug); }
  /** Operator-named Room (federates ≥1 hosts). */
  static named(name) { return new NamedRoom(name); }
}

/**
 * A conversation: the Room a surface chat IS. Roots at
 * ~/.egpt/conversations/<surface>/<sanitizeSlug(slug)>/. Exactly one host (the
 * chat itself). Path is byte-identical to the legacy conversations-state.slugDir.
 */
export class ConversationRoom extends Room {
  constructor(surface, slug) {
    super();
    this.surface = surface;
    this.slug = slug;
  }
  baseDir() {
    return join(homedir(), '.egpt', 'conversations', this.surface, sanitizeSlug(this.slug));
  }
}

/**
 * An operator-named Room. Roots at ~/.egpt/rooms/<sanitizeName(name)>/. May
 * federate ≥1 hosts across surfaces. Path is byte-identical to the legacy
 * rooms.roomDir.
 */
export class NamedRoom extends Room {
  constructor(name) {
    super();
    this.name = name;
  }
  baseDir() {
    return join(homedir(), '.egpt', 'rooms', sanitizeName(this.name));
  }
}
