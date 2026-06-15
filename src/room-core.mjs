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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';
import { sanitizeSlug, sanitizeName } from './sanitize.mjs';

// ── Member model (the Room's contribution gate) ─────────────────────────────
// A member is { kind, id, state }. `state` is the contribution gate, mirroring
// the per-chat auto-mode (GENOME §2.5): muted = nothing it says enters · mention
// = only @mentioning messages · active = everything. These primitives were moved
// here from src/rooms.mjs (Phase 1a) because they ARE part of the Room
// abstraction; rooms.mjs re-exports them so existing importers are unaffected
// (and so room-core stays cycle-free — rooms.mjs imports room-core, not vice
// versa).
export const ROOM_MEMBER_STATES = ['muted', 'mention', 'active'];
export const ROOM_MEMBER_KINDS  = ['wa-group', 'tg-group', 'brain', 'shell', 'extension'];
export const DEFAULT_MEMBER_STATE = 'muted';

// Operator-friendly aliases for the member state — `on`/`unmute` read more
// naturally than `active`, but they all mean the same input gate. Unknown → null.
const _MEMBER_STATE_ALIASES = {
  muted:    'muted',  mute:    'muted', silent: 'muted',
  mention:  'mention',
  active:   'active', on:      'active', unmute: 'active', unmuted: 'active', open: 'active',
};

export function normalizeMemberState(token) {
  const t = String(token ?? '').trim().toLowerCase();
  return _MEMBER_STATE_ALIASES[t] ?? null;
}

// Recognized — useful for the CLI to know "this looks like a state word" before
// it commits to the parse (e.g. distinguishing a state token from a member id).
export function isMemberStateAlias(token) {
  return normalizeMemberState(token) !== null;
}

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

  // ── config.yaml (shared with the heartbeat + transcription services) ───────
  // Read the whole config.yaml as a plain object ({} when absent/malformed).
  // This is the SAME file src/heartbeats.mjs (heartbeat:) and
  // src/transcription-service.mjs (transcription:) read; the member block lives
  // beside theirs, never replacing them.
  async loadConfig() {
    try {
      const doc = YAML.parse(await readFile(this.configPath, 'utf8'));
      return (doc && typeof doc === 'object') ? doc : {};
    } catch { return {}; }
  }

  // Write a single top-level block WITHOUT clobbering the operator's other blocks
  // or their comments: edit via the YAML Document API (comment-preserving) and
  // round-trip. mkdir the room folder first so a never-seen room can be written.
  async _setConfigBlock(key, value) {
    await mkdir(this.baseDir(), { recursive: true });
    let text = '';
    try { text = await readFile(this.configPath, 'utf8'); } catch { /* new file */ }
    const doc = YAML.parseDocument(text || '');
    doc.setIn([key], value);
    await writeFile(this.configPath, String(doc), 'utf8');
  }

  // ── members (the Room's contribution roster) ───────────────────────────────
  // members[] = [{ kind, id, state }]. Normalized on read; unknown kind → brain,
  // unknown state → DEFAULT_MEMBER_STATE. Extra per-member fields (brain/options/
  // emoji/bio) are preserved verbatim.
  async members() {
    const doc = await this.loadConfig();
    const raw = Array.isArray(doc.members) ? doc.members : [];
    return raw.filter((m) => m && m.id != null).map((m) => ({
      ...m,
      kind: ROOM_MEMBER_KINDS.includes(m.kind) ? m.kind : 'brain',
      id: String(m.id),
      state: normalizeMemberState(m.state) ?? DEFAULT_MEMBER_STATE,
    }));
  }

  async memberState(id) {
    const m = (await this.members()).find((x) => x.id === String(id));
    return m ? m.state : null;
  }

  // Add or update a member (by id). Persists; preserves sibling config blocks.
  async setMember({ kind = 'brain', id, state = DEFAULT_MEMBER_STATE, ...extra } = {}) {
    if (id == null || id === '') throw new Error('Room.setMember: id required');
    if (!ROOM_MEMBER_KINDS.includes(kind)) throw new Error(`Room.setMember: unknown kind "${kind}" (expected ${ROOM_MEMBER_KINDS.join('|')})`);
    const st = normalizeMemberState(state);
    if (!st) throw new Error(`Room.setMember: unknown state "${state}" (expected ${ROOM_MEMBER_STATES.join('|')})`);
    const doc = await this.loadConfig();
    const list = Array.isArray(doc.members) ? doc.members.slice() : [];
    const i = list.findIndex((m) => m && String(m.id) === String(id));
    const next = { ...(i >= 0 ? list[i] : {}), ...extra, kind, id: String(id), state: st };
    if (i >= 0) list[i] = next; else list.push(next);
    await this._setConfigBlock('members', list);
    return list.map((m) => ({ ...m }));
  }

  // Remove a member by id. Returns true iff one was removed.
  async removeMember(id) {
    const doc = await this.loadConfig();
    if (!Array.isArray(doc.members)) return false;
    const next = doc.members.filter((m) => m && String(m.id) !== String(id));
    if (next.length === doc.members.length) return false;
    await this._setConfigBlock('members', next);
    return true;
  }

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
