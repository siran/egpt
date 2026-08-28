// room-core.mjs — the Room ABSTRACTION (GENOME §2.5; ROOMS-MERGE-PLAN Phase 0).
//
// A Room is a host to members, files, media, and a transcript. A surface chat
// (1:1 or group) natively fulfils that contract, so a conversation IS a Room —
// it is NOT a thing a Room points at. There is ONE implementation now:
//   ConversationRoom → conversations/<surface>/<slug>/, and rooms/<slug>/ for
//   surface `room`.
// An operator-named room is NOT a second kind: `/room create acim` mints a
// contact on surface `room` (chatId = the name) through the SAME ensureContact
// every Beeper chat goes through, so every path keyed by (surface, chatId)
// reaches it for free (2026-08-09 — the chatId-less NamedRoom subclass is gone,
// and with it the split that let /members write one file while the relay read
// another).
// Its FOLDER, though, sits outside conversations/ (operator 2026-08-28): *"voice,
// instagram, telegram, whatsapp, matrix is all under beeper, only rooms is not…
// rooms does belong outside conversations"* — conversations/ IS the Beeper tree.
// That is the ONLY difference: same chatId, same ns `room/<slug>` (so every
// config/rooms.yaml key is byte-identical), same ONE member model, ONE rung, ONE
// tree, same constructor.
//
// The base owns the folder tree (derived from baseDir()); the subclass overrides
// ONLY baseDir(). **Anything added to the base flows downstream** — that is the
// whole point of an abstraction over a shared helper. conversations-state.slugDir
// DELEGATES here so paths stay byte-identical.
//
// Depends only on the leaf src/sanitize.mjs (+ node builtins): it imports nothing
// from conversations-state.mjs, so that module can delegate to it without an
// import cycle (that is why Phase 0a moved the sanitizers).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';
import { EGPT_HOME } from "./egpt-home.mjs";
import { homedir } from 'node:os';
import * as YAML from 'yaml';
import { sanitizeSlug } from './sanitize.mjs';
import { readRoomConfig, setRoomConfigBlock } from './rooms-file.mjs';

// ── THE surface → filesystem-root map ───────────────────────────────────────
// The ONLY place in the codebase that decides which root a surface's folders
// live under. conversations/ is the BEEPER tree; surface `room` is the one
// surface that does not arrive through Beeper, so it roots beside it (operator
// 2026-08-28). Exported for the two ENUMERATORS that walk a root rather than
// address one folder — boot.listEntityDirs (THE walk) and commands.listRoomNames
// — so neither re-derives a root of its own.
export const CONVERSATIONS_ROOT = join(EGPT_HOME, 'conversations');
export const ROOMS_ROOT = join(EGPT_HOME, 'rooms');

// ── Member model (the Room's contribution gate) ─────────────────────────────
// A member is { kind, id, state }. `state` is the contribution gate, mirroring
// the per-chat auto-mode (GENOME §2.5): muted = nothing it says enters · mention
// = only @mentioning messages · active = everything. These primitives were moved
// here from src/rooms.mjs (Phase 1a) because they ARE part of the Room
// abstraction; that module and its roster-file model are gone (2026-08-09), so
// this is their ONE home.
// The member state IS the per-chat auto-mode (GENOME §2.5; operator 2026-06-15
// "one gate, zero loss"): the full 6-state enum so a brain member (incl. E) can
// carry its exact reply behavior. Canonical words keep the room vocabulary
// (active/muted) with the auto-mode tokens (on/mute) as aliases, so the seeding
// resolver can normalize an auto_e_mode straight into a member state losslessly:
//   muted          — nothing it contributes is emitted (still heard/logged)
//   off            — no participation at all (stronger than muted; cf C5.2)
//   mention        — replies only when @mentioned
//   mention-direct — replies only when addressed at the start / a reply to it
//   active         — replies on every turn ("on")
//   accum          — accumulate; reply on a batched cadence
export const ROOM_MEMBER_STATES = ['muted', 'mention', 'active', 'mention-direct', 'off', 'accum'];
export const ROOM_MEMBER_KINDS  = ['wa-group', 'tg-group', 'brain', 'shell', 'extension'];
export const DEFAULT_MEMBER_STATE = 'muted';

// Operator-friendly aliases for the member state — `on`/`unmute` read more
// naturally than `active`, etc. — all normalize to a canonical state. The
// auto-mode tokens (on→active, mute→muted) are aliases so an auto_e_mode maps in
// losslessly. Unknown → null.
const _MEMBER_STATE_ALIASES = {
  muted:    'muted',  mute:    'muted', silent: 'muted',
  mention:  'mention',
  active:   'active', on:      'active', unmute: 'active', unmuted: 'active', open: 'active',
  'mention-direct': 'mention-direct', direct: 'mention-direct',
  off:      'off',
  accum:    'accum', accumulate: 'accum',
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
    throw new Error('Room is abstract — baseDir() must be implemented by a subclass (ConversationRoom)');
  }

  // ── the identical tree (GENOME §2.5) ──────────────────────────────────────
  // The ROOM RUNG's key in config/rooms.yaml — `<surface>/<slug>`, the same
  // namespace listEntityDirs and the resolver already compute. DERIVED from
  // baseDir(), so every subclass (including a test's own) has one for free.
  // Operator 2026-08-24: a conversation folder belongs to the BEING and carries
  // no operator config; the rung moved to a registry file the operator owns.
  // A folder under the ROOMS root maps back to `room/<slug>` — the INVERSE of the
  // one surface→root map above — so the base cannot key a room-rooted folder as
  // `../rooms/<slug>` and silently lose the operator's block (2026-08-28). A
  // folder under NEITHER root (a test fixture in a temp dir) relativizes against
  // conversations/ exactly as before.
  ns() {
    const rel = relative(ROOMS_ROOT, this.baseDir());
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return `room/${rel.split(sep).join('/')}`;
    return relative(CONVERSATIONS_ROOT, this.baseDir()).split(sep).join('/');
  }
  // First-class (I3). NOT a rolling window — nothing truncates or ages it out. It rotates with
  // the THREAD: a reset archives it to transcripts/<old-thread-id>.md (2026-07-26).
  get transcriptPath() { return join(this.baseDir(), 'transcript.md'); }
  get mediaDir()       { return join(this.baseDir(), 'media'); }           // per-room downloads (C2)
  get filesDir()       { return join(this.baseDir(), 'files'); }           // operator /inject — the shared shelf
  get identityDir()    { return join(this.baseDir(), 'identity.d'); }      // NN-*.md fed to the room's brain(s)
  get scriptsDir()     { return join(this.baseDir(), 'scripts'); }         // *.x.md TEXTECUTABLES the room's brain(s) can be asked to carry out
  get transcriptsDir() { return join(this.baseDir(), 'transcripts'); }     // finished threads: transcript.md is archived here as <thread_id>.md when the thread changes

  // ── the tree, ENSURED (ONE owner) ─────────────────────────────────────────
  // The list used to be written out twice — /room create's mkdir loop (spine/commands.mjs)
  // and seedIdentityLayers (conversations-state.mjs) — and the two copies had ALREADY
  // drifted: create made media/ + files/, seeding did not, so a NamedRoom's identity.d was
  // born empty while a conversation's was seeded, and a conversation never got the shelf.
  // The list lives HERE now, beside the getters that define it: one edit gives BOTH
  // implementations the folder, which is the whole point of the abstraction (operator
  // 2026-07-26: "the work is for the Room abstraction, it is then for free in a room or
  // conversation on any network").
  //
  // transcripts/ JOINED the list on 2026-07-26, which is what ENDS that dead end: it is where
  // a changed thread's transcript.md gets archived (conversations-state.rollTranscript — see
  // its header, not wired yet), so the pointers card lands E in a folder that exists.
  //
  // ALL FIVE dirs, for both roots. media/ and files/ were NamedRoom-only in practice, but a
  // conversation IS a Room: the shipped pointers card already tells every brain to look in
  // ./media/, and /inject's shelf must land somewhere in a conversation too. An empty folder
  // is the honest answer ("nothing here yet") — the same reasoning that created scripts/
  // eagerly; a card naming a folder nothing creates is the ./transcripts/ dead-end of
  // 2026-07-25.
  treeDirs() {
    return [this.baseDir(), this.mediaDir, this.filesDir, this.identityDir, this.scriptsDir, this.transcriptsDir];
  }

  // Create the tree. Idempotent (mkdir -p on every call). `io.mkdir` is the seam both
  // callers already thread so their tests stay in-memory; absent, real fs/promises.
  // Deliberately does NOT swallow: /room create wants an fs failure to reach the operator,
  // and seedIdentityLayers already runs inside its own never-throw try/catch — so error
  // behavior at each call site is exactly what it was.
  async ensureTree({ io = {} } = {}) {
    const mkdirFn = io.mkdir ?? mkdir;
    for (const dir of this.treeDirs()) await mkdirFn(dir, { recursive: true });
  }

  // ── config.yaml (shared with the heartbeat + transcription services) ───────
  // Read the whole config.yaml as a plain object ({} when absent/malformed).
  // This file is the NEAREST rung of the config resolver (src/spine/config-resolver.mjs):
  // config/config.yaml < config/conversations.yaml < THIS. `members:` is the one block with
  // no rung above it, which is why this reader still opens the file directly — there is
  // nothing to layer, and reading through the resolver's cached set would only add
  // staleness between a /members write and the next read.
  async loadConfig() { return readRoomConfig(this.ns()); }

  // Write a single top-level block WITHOUT clobbering the operator's other blocks
  // or their comments: edit via the YAML Document API (comment-preserving) and
  // round-trip. mkdir the room folder first so a never-seen room can be written.
  async _setConfigBlock(key, value) {
    // The FOLDER still IS the room — /room members and friends test existence
    // with stat(baseDir()). Writing the rung no longer touches the folder, so
    // materialize it here as the config write used to.
    await mkdir(this.baseDir(), { recursive: true });
    await setRoomConfigBlock(this.ns(), key, value);
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

  // Change ONLY a member's state (its contribution mode), preserving every other
  // field — kind, id, and the brain extras (adapter / url / targetId). setMember
  // defaults an omitted state to muted, so a mode flip must NOT go through it (that
  // would clobber the state you're trying to keep for the OTHER fields); this touches
  // state alone. Errors if no member has that id. Returns the roster.
  async setMemberState(id, state) {
    const st = normalizeMemberState(state);
    if (!st) throw new Error(`Room.setMemberState: unknown state "${state}" (expected ${ROOM_MEMBER_STATES.join('|')})`);
    const doc = await this.loadConfig();
    const list = Array.isArray(doc.members) ? doc.members.slice() : [];
    const i = list.findIndex((m) => m && String(m.id) === String(id));
    if (i < 0) throw new Error(`Room.setMemberState: no member "${id}"`);
    list[i] = { ...list[i], state: st };
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

  // ── radio (WhatsApp-voice-note-to-station relay, config + command only) ────────────
  // Set (or clear, via a falsy radioName) the ONE key `/radio` owns: radio.join, the
  // radio (a key in this node's radio_service map, config/config-schema.mjs) THIS room
  // relays to. Preserves every other key in the `radio:` block — especially `hosts`
  // (sender-id -> station-speaker name), which is operator-maintained by hand and must
  // NEVER be written by this command. Used for both /radio join (radioName = the radio
  // being joined) and /radio leave (radioName = null).
  async setRadioJoin(radioName) {
    const doc = await this.loadConfig();
    const radio = (doc.radio && typeof doc.radio === 'object') ? { ...doc.radio } : {};
    if (radioName) radio.join = radioName; else delete radio.join;
    await this._setConfigBlock('radio', radio);
  }

  // ── resolver ──────────────────────────────────────────────────────────────
  /** THE Room constructor: a Room is always (surface, slug). */
  static forChat(surface, slug) { return new ConversationRoom(surface, slug); }
}

/**
 * A conversation: the Room a surface chat IS. Roots at
 * ~/.egpt/conversations/<surface>/<sanitizeSlug(slug)>/ — except surface `room`,
 * which roots at ~/.egpt/rooms/<sanitizeSlug(slug)>/ (the one surface that does
 * not arrive through Beeper). An operator-named room is one of these on surface
 * `room`: same kind, same tree, same members, different root.
 */
export class ConversationRoom extends Room {
  constructor(surface, slug) {
    super();
    this.surface = surface;
    this.slug = slug;
  }
  // THE surface→root decision, made once, here (see the map at the top of the
  // file). A room differs from every other chat in this ONE line and nowhere else.
  baseDir() {
    const slug = sanitizeSlug(this.slug);
    return this.surface === 'room' ? join(ROOMS_ROOT, slug) : join(CONVERSATIONS_ROOT, this.surface, slug);
  }
  // From (surface, slug) DIRECTLY, never derived from baseDir(): a Room whose
  // folder is not under EGPT_HOME (a test fixture in a temp dir) would otherwise
  // relativize to `../../tmp-xxxx/conv` and write junk rows into rooms.yaml.
  ns() { return `${this.surface}/${sanitizeSlug(this.slug)}`; }
}
