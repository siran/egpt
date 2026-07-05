// conversations-state.mjs — pure-logic module for @e's per-contact
// conversation registry and personalities.
//
// Per-contact (NOT per-JID) model: each human or group gets ONE
// contact entry, keyed by a slug (e.g., "diego", "premise-driven-bitcoin").
// Multiple WA JIDs can map to one contact (lid + phone-number form for
// the same person) — they all live in the entry's `jids` array, share
// one `threadId`, one personality.
//
// Operator (2026-05-19): registry is YAML for human readability,
// personalities are markdown files shipped with egpt + overridable in
// ~/.egpt/personalities/, all timestamps ISO 8601.
//
// This file: pure functions only — no fs/io side effects EXCEPT in
// explicit read/write helpers at the bottom that take paths. Easy to
// test, easy to call from any host.

import { readFile, writeFile, mkdir, stat, rename, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import * as YAML from 'yaml';
import { sanitizeSlug } from './src/sanitize.mjs';
import { Room } from './src/room-core.mjs';
import { EGPT_HOME } from './src/egpt-home.mjs';
import { makeSerialByKey } from './src/serial-by-key.mjs';

const _here = dirname(fileURLToPath(import.meta.url));
const PERSONALITIES_SHIPPED_DIR  = join(_here, 'config', 'personalities');
const PERSONALITIES_OPERATOR_DIR = join(EGPT_HOME, 'personalities');
// Identities are FLAT markdown files now (operator 2026-07-03: "identities are .md
// files not directories with a 00-file inside… an identity file 'egpt.md'"). A
// conversation's kickoff feed = its identity file + the SHARED pointers + rules (the
// "room template" — same content/order as the retired 00/30/40 trio, identity first).
//   - identity: EGPT_HOME/config/identities/<name>.md (profile).
//   - shared pointers/rules: config/skeletons/room/{30-pointers,40-rules}.md — the
//     profile's seeded copy wins, the repo's shipped template is the fallback.
//   - a name with no profile identity file falls back to the room template's
//     00-identity.md (the shipped eGPT default). No repo-root identities/ back-read.
const IDENTITIES_PROFILE_DIR    = join(EGPT_HOME, 'config', 'identities');
const ROOM_TEMPLATE_PROFILE_DIR = join(EGPT_HOME, 'config', 'skeletons', 'room');
const ROOM_TEMPLATE_SHIPPED_DIR = join(_here, 'config', 'skeletons', 'room');
// The `mode: auto` operator-role instruction layer (a top-level skeleton, seeded
// copy-if-missing like the room template). Appended to an auto conversation's kickoff
// feed — NOT part of readIdentityFeed (which every conversation gets), so it reaches
// ONLY auto chats. Profile-seeded copy wins; the repo's shipped file is the fallback.
const SKELETONS_PROFILE_DIR     = join(EGPT_HOME, 'config', 'skeletons');
const SKELETONS_SHIPPED_DIR     = join(_here, 'config', 'skeletons');
// Canonical location of the per-contact YAML registry (operator 2026-07-03: MOVED under
// config/). Exported so daemon + slashes + tools all agree. The registry sits OUTSIDE the
// per-conversation dirs so conversation-e (cwd-locked to its own slug dir) can't read it.
export const CONV_YAML_PATH = join(EGPT_HOME, 'config', 'conversations.yaml');

// Known surfaces — used as the first dir level under conversations/
// and the first key level under contacts: in the YAML. Adding a new
// surface = add it here + wire its bridge in egpt.mjs.
export const KNOWN_SURFACES = ['whatsapp', 'telegram', 'shell', 'signal'];

// Per-conversation directory. Each contact gets its own folder; that
// folder is the only filesystem location conversation-e is given
// access to via --cwd / --add-dir. Layout:
//
//   ~/.egpt/conversations/<surface>/<slug>/
//     transcript.md                ← per-thread play-script log
//     daily-YYYY-MM-DD.md (opt)    ← optional daily summaries written by @e
//     media/                       ← per-chat media downloads
//
// Surface separation lets WA / TG / Signal / shell each be backed up,
// wiped, or moved without touching the others. Pre-2026-05-21 the
// layout was a flat conversations/<slug>/ (everything WA) — see
// migrateToSurfaceLayout() for the one-shot migration.
export function slugDir(surface, slug) {
  if (!surface || !KNOWN_SURFACES.includes(surface)) {
    throw new Error(`slugDir: unknown surface "${surface}" (expected one of ${KNOWN_SURFACES.join('|')})`);
  }
  // A conversation IS a Room (GENOME §2.5): delegate the path to the
  // ConversationRoom implementation so this root and the rooms root share ONE
  // tree definition. Byte-identical to the legacy formula (Phase 0c). The
  // surface check stays here (the Room API is permissive; slugDir's contract is
  // to reject unknown surfaces).
  return Room.forChat(surface, slug).baseDir();
}
export function slugTranscriptPath(surface, slug) {
  return join(slugDir(surface, slug), 'transcript.md');
}

// Render a path msys-style: C:\Users\an → /c/Users/an (drive-letter lowercased,
// backslashes → forward slashes). Pure; an already-posix or UNC path is left alone.
// Used for the self-describing `home_dir` + the absolute-fallback conversation_path.
export function toMsysPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  const m = s.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : s;
}

// The user home rendered msys-style — the default `home_dir` stamped on every entry.
export function homeDirMsys() {
  return toMsysPath(homedir());
}

// Per-entry STORED conversation path (operator 2026-07-02): home-relative and INCLUDING
// the profile dir name — `<profile>/conversations/<surface>/<slug>` — paired with
// `home_dir` so each conversation is INDIVIDUALLY RELOCATABLE (move a folder + rewrite the
// two keys). RESOLUTION still runs through EGPT_HOME/slugDir (readers unchanged); this is a
// self-describing POINTER, not the resolver (a later feature may honor per-entry overrides
// — intent only, not built here). When EGPT_HOME is not under the user home (a non-standard
// install), it can't be expressed home-relative, so we fall back to the absolute msys path.
export function conversationPathOf(surface, slug) {
  const abs = slugDir(surface, slug);
  const rel = relative(homedir(), abs);
  if (rel && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel)) {
    return rel.split(/[\\/]/).join('/');
  }
  return toMsysPath(abs);
}

// Deterministic engine defaults (operator 2026-07-02: "don't do 'null means inherit the
// login default' — make it deterministic"). A type def that omits model/effort snapshots
// these CONCRETE values into `readonly` (brainpool), and the vocabulary migration backfills
// existing null snapshots to them — ONE source so the frozen snapshot and the actual run
// always agree.
export const DETERMINISTIC_MODEL = 'sonnet';
export const DETERMINISTIC_EFFORT = 'high';

// The canonical explicit allowed_tools list (operator 2026-07-03: "list tools
// explicitly" + "better to reject 'all'"). egpt never ships, defaults to, or writes
// `allowed_tools: all` — this is the fallback when a type omits allowed_tools. Defined
// in the tool-args leaf (src/claude-args.mjs), re-exported here so existing importers
// (brainpool, commands) keep their path. A literal 'all' is REJECTED at the spawn
// boundary — coerced to this list, never a bypass/full grant.
export { DEFAULT_ALLOWED_TOOLS, READONLY_ALLOWED_TOOLS } from './src/claude-args.mjs';

// The per-surface stats ROOT (operator 2026-07-04). stats used to live INSIDE
// conversations/<surface>/<slug>/ — the warm claude process's CONFINED cwd, which is the
// being's OWN writable sandbox: its file tools can read, tamper with, or race the spine's
// bookkeeping there. Stats are SPINE-owned records, so they must sit OUTSIDE the being's
// writable space — under state/ (the same root as spine.pid / alive.txt / ingest/, built
// the same way: join(EGPT_HOME, 'state', <name>)), a location no conversation's
// --cwd/--add-dir grant ever reaches.
export function statsDir(surface) {
  return join(EGPT_HOME, 'state', 'stats', surface);
}

// The per-CHAT stats file under state/stats/<surface>/ (operator 2026-07-04: filenames must
// be HUMAN-READABLE — <chat display name>.yaml, not the opaque chat id). RESOLVES the current
// on-disk basename via resolveStatFilename, so it's async now (resolution reads the surface
// dir). Pass `name` (the chat display name) to compute the human basename; omit it for a read
// that only needs to LOCATE the file. Reader default is rename:false (locate-but-don't-move —
// only the live WRITERS self-heal a filename). Body chat_id is the identity anchor, so this
// finds the file even when it sits under a stale/renamed basename.
export async function statsPath(surface, chatId, { name, io = {}, rename = false } = {}) {
  const { path } = await resolveStatFilename({ dir: statsDir(surface), idField: 'chat_id', id: chatId, name, io, rename });
  return path;
}

// Filename-safe key for a SENDER id (the per-contact stats file's basename). A sender id
// is a Matrix user id like "@anrodriguez:beeper.com" or "26087681749235@lid" and is NEVER
// shortened (a user can live on another homeserver) — so it can carry ':' etc., invalid in
// a Windows filename component (< > : " / \ | ? * + control chars). NOT sanitizeSlug: that
// collapses illegal chars + whitespace runs to a single space, so "a:b" and "a b" would
// fuse into ONE file — lossy/colliding for a MACHINE key. Instead, a percent-style escape
// with '~' as the sentinel: escape a literal '~' FIRST (so real input can't forge an
// escape), then each illegal char -> '~' + its 2-hex code. Collision-free, deterministic,
// reversible, and human-readable enough ("@anrodriguez:beeper.com" -> "@anrodriguez~3abeeper.com").
const _WIN_ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
export function sanitizeStatKey(id) {
  return String(id ?? '')
    .replace(/~/g, '~7e')
    .replace(_WIN_ILLEGAL, (c) => '~' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

// Inverse of sanitizeStatKey — recovers the real (unsanitized) id from a stats filename's
// base. Safe because the escape is unambiguous: every escape is the literal '~' + exactly 2
// lowercase hex digits, and a real '~' in the input was itself escaped to '~7e' by
// sanitizeStatKey, so a single global pass fully reverses it. Used by the stats backfill to
// recover a contact file's real sender id from its sanitized filename.
export function unsanitizeStatKey(s) {
  return String(s ?? '').replace(/~([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// The stats FILENAME base for a KNOWN display name (operator 2026-07-04: filenames must be
// human-readable). Reuses sanitizeSlug (Windows-illegal→space, collapse whitespace, trim
// leading/trailing dot+space, reserved-device guard CON/PRN/…) with a ~120 cap — the first
// 40-cap cut real group names mid-word ('…esclavos del p.yaml', operator: "is this really the
// best we can do?"), and the Windows path budget is fine at 120. When a name still exceeds the
// cap, cut at a WORD BOUNDARY (the last space at/before the cap; a single spaceless token
// longer than the cap falls back to a hard cut), then re-run sanitizeSlug so a cut landing on
// a dot/space/reserved-name is re-trimmed (the same trick sanitizeSlug uses internally). Empty
// (name sanitizes to nothing) → '' so the caller falls back to the id-based base.
const STAT_NAME_CAP = 120;
export function sanitizeStatName(name) {
  const s = sanitizeSlug(name, Infinity);   // char rules only — the cap is applied below
  if (s.length <= STAT_NAME_CAP) return s;
  const cut = s.lastIndexOf(' ', STAT_NAME_CAP);
  return sanitizeSlug(cut > 0 ? s.slice(0, cut) : s.slice(0, STAT_NAME_CAP), Infinity);
}

// Shared name + name-change-history helper (operator 2026-07-04: NAME-FOLLOWS-RENAME). Given a
// stats body, an OBSERVED name, and the observation timestamp, returns the `{ name, former_names }`
// fields to SPREAD onto the merged body — ONE code path for both chat and contact files:
//   - observed name absent, or equal to the stored name → no change (returns the current fields
//     as-is so the spread is a no-op; the common per-message re-observation must NOT grow history).
//   - observed name differs from a PRIOR stored name → set name to the new value AND append the
//     OUTGOING (previous) name to former_names with `until` = the observation time (NOT a claim
//     about when the rename happened, just when it was NOTICED). A→B→A yields two entries.
//   - first-ever name (no prior stored) → just set name; not a transition, no history entry.
//   - former_names capped at `cap` (~20; renames are rare — a guard, not a feature), oldest
//     dropped on overflow.
export function mergeNameHistory(existing = {}, name, isoTs, { cap = 20 } = {}) {
  const prevName = existing?.name;
  const prevHist = Array.isArray(existing?.former_names) ? existing.former_names : [];
  if (!name || name === prevName) {
    const out = {};
    if (prevName != null) out.name = prevName;
    if (prevHist.length) out.former_names = prevHist;
    return out;
  }
  let hist = prevHist;
  if (prevName != null && prevName !== '') {
    hist = [...prevHist, { name: prevName, until: isoTs }];
    if (hist.length > cap) hist = hist.slice(hist.length - cap);   // drop oldest on overflow
  }
  const out = { name };
  if (hist.length) out.former_names = hist;
  return out;
}

// Resolve the on-disk stats file for one logical entity (a chat or a contact) on a surface.
// FILENAMES are cosmetic/human-readable and may drift or collide; the file's BODY id (chat_id /
// sender_id) is the ONLY identity anchor, so resolution NEVER trusts a filename alone. Steps:
//   1. canonical = the sanitized name-based basename when a name is known, else the id-based
//      fallback (<chatId> for a chat — already filename-safe; sanitizeStatKey(senderId) for a
//      contact).
//   2. FAST PATH: canonical exists AND its body id == id → that's the file (no dir scan).
//   3. else SCAN the (small, flat, ~30-file) surface dir, reading each *.yaml's body id, to find
//      whichever file currently holds this id. This scan only runs on the miss/foreign path.
//   4. target = canonical, UNLESS canonical is occupied by a genuinely DIFFERENT entity (foreign
//      body id) → disambiguate with <name>-<idPart>.yaml (idPart = the raw chatId / the
//      sanitizeStatKey(senderId)).
//   5. when allowRename && the entity's file was found under a non-target basename → RENAME it to
//      the target (swallow-never-throw; a rename failure logs one line and keeps the found path).
// CRITICAL TRAP: a NAMELESS caller (name undefined/empty) must NEVER demote an already
// nicely-named file back to the id-only fallback — it LOCATES but never renames. Renaming only
// ever moves a file TOWARD a newly-*known*, better name. A read-only resolve (allowRename=false)
// likewise locates without moving. Returns { path, isNew, renamedFrom }.
export async function resolveStatFilename({ dir, idField, id, name, io = {}, rename: allowRename = true }) {
  const readFileFn = io.readFile ?? readFile;
  const readdirFn = io.readdir ?? readdir;
  const renameFn = io.rename ?? rename;                    // the module fs/promises rename
  const existsSyncFn = io.existsSync ?? existsSync;

  const idFallbackBase = idField === 'chat_id' ? String(id) : sanitizeStatKey(id);
  const sanitizedName = name ? sanitizeStatName(name) : '';
  const nameKnown = !!sanitizedName;
  const canonicalBase = nameKnown ? sanitizedName : idFallbackBase;
  const canonicalPath = join(dir, `${canonicalBase}.yaml`);

  const bodyIdOf = async (fp) => {
    try { return YAML.parse(await readFileFn(fp, 'utf8'))?.[idField] ?? null; } catch { return null; }
  };

  // FAST PATH: canonical is on disk and self-identifies as this entity.
  const canonicalExists = existsSyncFn(canonicalPath);
  if (canonicalExists && (await bodyIdOf(canonicalPath)) === id) {
    return { path: canonicalPath, isNew: false, renamedFrom: null };
  }
  // canonicalExists reaching here ⇒ occupied by a DIFFERENT/unstamped entity (foreign name).
  const canonicalForeign = canonicalExists;

  // SCAN the surface dir for whichever file currently carries this body id.
  let names = [];
  try { names = await readdirFn(dir); } catch { names = []; }
  let foundPath = null;
  for (const n of names) {
    if (!n.endsWith('.yaml')) continue;
    const fp = join(dir, n);
    if (fp === canonicalPath) continue;                    // already checked on the fast path
    if ((await bodyIdOf(fp)) === id) { foundPath = fp; break; }
  }

  // Brand-new entity: nothing on disk holds this id yet.
  if (!foundPath) {
    const targetBase = (nameKnown && canonicalForeign) ? `${sanitizedName}-${idFallbackBase}` : canonicalBase;
    return { path: join(dir, `${targetBase}.yaml`), isNew: true, renamedFrom: null };
  }

  // Found the entity under `foundPath`. A nameless caller (or a read-only resolve) returns the
  // CURRENT location untouched — never demote toward the id-only fallback, never move on read.
  if (!nameKnown || !allowRename) {
    return { path: foundPath, isNew: false, renamedFrom: null };
  }
  // Name known + rename enabled: move toward the canonical (or collision-disambiguated) name.
  const targetBase = canonicalForeign ? `${sanitizedName}-${idFallbackBase}` : canonicalBase;
  const targetPath = join(dir, `${targetBase}.yaml`);
  if (foundPath === targetPath) return { path: foundPath, isNew: false, renamedFrom: null };
  try {
    await renameFn(foundPath, targetPath);
    return { path: targetPath, isNew: false, renamedFrom: foundPath };
  } catch (e) {
    console.error(`!! resolveStatFilename rename(${foundPath} -> ${targetPath}): ${e?.message ?? e}`);
    return { path: foundPath, isNew: false, renamedFrom: null };   // rename failed → keep the found path
  }
}

// The per-CONTACT stats file under state/stats/<surface>/ — one file per sender holding that
// sender's rollup ACROSS ALL chats on the surface. Named by the sender's push name / number
// when known (operator 2026-07-04), else the sanitized sender id. Async resolver — see statsPath.
export async function contactStatsPath(surface, senderId, { name, io = {}, rename = false } = {}) {
  const { path } = await resolveStatFilename({ dir: statsDir(surface), idField: 'sender_id', id: senderId, name, io, rename });
  return path;
}

const STATS_HEADER = '# per-chat stats (spine-written — do not edit)\n';
const CONTACT_STATS_HEADER = '# per-contact cross-chat stats (spine-written — do not edit)\n';

// Merge migrated lifecycle facts into an existing stats object WITHOUT clobbering content
// already there (create-or-merge): scalars fill only when absent; `threads:` is unioned by
// id (existing order kept, new ids appended). Pure — the caller owns the fs.
export function mergeStats(existing = {}, incoming = {}) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  if (out.name == null && incoming.name != null) out.name = incoming.name;
  if (out.first_seen == null && incoming.first_seen != null) out.first_seen = incoming.first_seen;
  const ex = Array.isArray(out.threads) ? out.threads : [];
  const inc = Array.isArray(incoming.threads) ? incoming.threads : [];
  const seen = new Set(ex.map((t) => t?.id));
  const merged = ex.slice();
  for (const t of inc) if (t?.id && !seen.has(t.id)) { merged.push(t); seen.add(t.id); }
  if (merged.length) out.threads = merged;
  return out;
}

// Append a thread to stats.threads: when its id isn't already the LATEST (the branch
// mirror: a changed threadId appends, the old id stays; the same id is a no-op). Pure.
export function mergeThreadIntoStats(stats, thread) {
  const out = { ...(stats && typeof stats === 'object' ? stats : {}) };
  const threads = Array.isArray(out.threads) ? out.threads.slice() : [];
  const last = threads[threads.length - 1];
  if (last && last.id === thread.id) return { stats: out, changed: false };
  threads.push(thread);
  out.threads = threads;
  return { stats: out, changed: true };
}

// Write-serialization for a stats entity (operator 2026-07-03): appendThreadStat (awaited in a
// brainpool turn) and recordMemberStat (fired fire-and-forget on EVERY received message) both
// read-merge-write the SAME chat file, so two overlapping writes could race and lose one's
// read-before-write delta. Chain each write behind the previous one, turning last-writer-wins
// into read-after-write. Keyed by a STABLE LOGICAL key `${surface}:${kind}:${id}` (operator
// 2026-07-04), NOT the file path: once a filename can change mid-write (a rename this very write
// triggers), two racers keyed by path — one resolving pre-rename, one post — would land on
// DIFFERENT chains and reintroduce the lost-update race. The whole resolve+read+merge+rename+write
// critical section runs inside ONE serializeStatsWrite(logicalKey) per entity.
const _statsWriteChains = new Map();
function serializeStatsWrite(key, task) {
  const prev = _statsWriteChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);                // run regardless of the prior write's outcome
  _statsWriteChains.set(key, next.catch(() => {}));  // a rejection must not poison the chain
  return next;
}

// mutateState(writeState, task): serializes conversations.yaml's read-modify-write
// critical sections so two concurrent first-turn-style mutations (contacts.resolve's
// ensureContact, brainpool's readonly-freeze + recordThread) can't interleave and lose
// one write. `task` is the caller's WHOLE load→mutate→write closure — wrapping only the
// write would still lose updates, since both racers would already have read the same
// stale state before either writes. Keyed by the `writeState` FUNCTION REFERENCE (not the
// file path): boot.mjs builds exactly one loadState/writeState pair per process and hands
// the same references to every consumer, so they land in one chain automatically; an
// in-memory test's own fake pair gets its own chain, so existing tests need no changes.
// Reuses the same keyed-serializer spine.mjs's turn queue is built on (src/serial-by-key.mjs)
// rather than a second hand-rolled chain like serializeStatsWrite's.
const _serializeConvState = makeSerialByKey();
export function mutateState(writeState, task) {
  return _serializeConvState(writeState, task);
}

// Effectful mirror of a freshly-minted thread into the per-chat stats file
// (state/stats/<surface>/<chatId>.yaml — the branchable history). Injectable io + statsDirOf
// so it's testable in-memory; NEVER fatal (the state write is the durable record — a stats
// hiccup must not break a reply). Returns whether it wrote. Called by the brainpool right
// where it records a new session. Serialized per file (serializeStatsWrite) so it never
// races recordMemberStat on the same file.
export async function appendThreadStat(surface, chatId, thread, { io = {}, statsDirOf = statsDir } = {}) {
  const key = `${surface}:chat:${chatId}`;
  return serializeStatsWrite(key, async () => {
    const readFileFn = io.readFile ?? readFile;
    const writeFileFn = io.writeFile ?? writeFile;
    const mkdirFn = io.mkdir ?? mkdir;
    const dir = statsDirOf(surface, chatId);
    // Nameless caller (this path carries no chat display name): resolve WITHOUT demoting an
    // already-nicely-named file back to the id-only base (the correctness trap) — locate the
    // chat's file by body chat_id, or the id-only base for a brand-new chat, never renaming.
    const { path: fp } = await resolveStatFilename({ dir, idField: 'chat_id', id: chatId, name: undefined, io, rename: true });
    let existing = {};
    try { existing = YAML.parse(await readFileFn(fp, 'utf8')) ?? {}; } catch { /* none / unreadable → fresh */ }
    const { stats, changed } = mergeThreadIntoStats(existing, thread);
    if (!changed) return false;
    const withId = { chat_id: chatId, ...stats };
    try {
      await mkdirFn(dir, { recursive: true });
      await writeFileFn(fp, STATS_HEADER + YAML.stringify(withId), 'utf8');
      return true;
    } catch (e) { console.error(`!! appendThreadStat(${surface}/${chatId}): ${e?.message ?? e}`); return false; }
  });
}

// Merge one received message's sender into stats.members[senderId] = { name?, count,
// last_seen } (count++, last_seen = isoTs) — the per-member counter contracts §3.1 mandates.
// `name` (operator 2026-07-04: member entries were raw ids, unreadable) is a DISPLAY field
// only — the id stays the key: set/refreshed when the event carries senderName, the existing
// name kept when it doesn't, and never invented (a member who never spoke with a name has no
// name key at all). No per-member former_names — kept simple per the operator. Pure; a no-op
// (returns stats unchanged) when senderId is falsy.
export function mergeMemberIntoStats(stats, senderId, isoTs, senderName) {
  if (!senderId) return stats;
  const out = { ...(stats && typeof stats === 'object' ? stats : {}) };
  const members = { ...(out.members && typeof out.members === 'object' ? out.members : {}) };
  const prev = members[senderId] && typeof members[senderId] === 'object' ? members[senderId] : {};
  const name = senderName || prev.name;
  members[senderId] = {
    ...(name ? { name } : {}),   // name first — the human label leads the entry
    count: (Number(prev.count) || 0) + 1,
    last_seen: isoTs,
  };
  out.members = members;
  return out;
}

// Merge one received message into a per-CONTACT stats object — a FLAT { count, last_seen,
// name?, former_names? } (NOT nested under a members: map like the per-chat file, since the
// file is already scoped to ONE sender): count++, last_seen bumped every time; `name` set/
// refreshed ONLY when the event actually carries one (never invented/backfilled from nothing),
// with a name CHANGE appending the outgoing name to former_names via the shared name-history
// helper. Pure.
export function mergeContactIntoStats(existing = {}, isoTs, name) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  out.count = (Number(out.count) || 0) + 1;
  out.last_seen = isoTs;
  Object.assign(out, mergeNameHistory(existing, name, isoTs));
  return out;
}

// Effectful per-message member counter into state/stats/<surface>/<chatId>.yaml (contracts
// §3.1: every received message passes to the stats collector). Same read-merge-write shape
// as appendThreadStat and serialized with it per file; NEVER fatal (a stats hiccup must not
// touch the message path). Returns whether the CHAT file wrote — false (chat file untouched)
// on a falsy senderId, matching mergeMemberIntoStats' no-op.
//
// ALSO rolls this sender up into its own per-CONTACT file (state/stats/<surface>/<sanitized
// senderId>.yaml — cross-chat totals). Different path → its OWN serializeStatsWrite chain
// (the two never block each other, each is race-safe internally); its own try/catch, added
// as an internal step that does NOT change the return contract (existing tests assert the
// chat-file write's `true`). `senderName`, when present on the event, sets/refreshes name.
export async function recordMemberStat(surface, chatId, senderId, isoTs, { io = {}, statsDirOf = statsDir, senderName, chatName } = {}) {
  if (!senderId) return false;
  const dir = statsDirOf(surface, chatId);
  const readFileFn = io.readFile ?? readFile;
  const writeFileFn = io.writeFile ?? writeFile;
  const mkdirFn = io.mkdir ?? mkdir;

  // ── per-CHAT file: member counter + NAME-FOLLOWS-RENAME on the chat display name. ──
  // Serialized by the stable LOGICAL key (surface:chat:chatId), NOT the file path — the
  // filename can change mid-write (a rename this write triggers), and two racers keyed by path
  // would land on different chains and lose an update. Resolve + read + merge + rename + write
  // all run inside this ONE critical section per chat.
  const chatKey = `${surface}:chat:${chatId}`;
  const wrote = await serializeStatsWrite(chatKey, async () => {
    // Resolve WITH the chat name so the file lands at / renames toward its human basename. A
    // name change renames the file HERE, before the read below reads the moved file's still-old
    // bytes — so mergeNameHistory can diff the outgoing (old) name against the observed one.
    const { path: fp } = await resolveStatFilename({ dir, idField: 'chat_id', id: chatId, name: chatName, io, rename: true });
    let existing = {};
    try { existing = YAML.parse(await readFileFn(fp, 'utf8')) ?? {}; } catch { /* none / unreadable → fresh */ }
    const stats = mergeMemberIntoStats(existing, senderId, isoTs, senderName);   // member entry carries the sender's display name
    Object.assign(stats, mergeNameHistory(existing, chatName, isoTs));   // chat name + former_names
    const withId = { chat_id: chatId, ...stats };
    try {
      await mkdirFn(dir, { recursive: true });
      await writeFileFn(fp, STATS_HEADER + YAML.stringify(withId), 'utf8');
      return true;
    } catch (e) { console.error(`!! recordMemberStat(${surface}/${chatId}): ${e?.message ?? e}`); return false; }
  });

  // ── per-CONTACT file: flat cross-chat rollup + NAME-FOLLOWS-RENAME on the sender push name. ──
  // Own logical key (surface:contact:senderId) → its own chain (never blocks the chat file);
  // non-fatal (a rollup hiccup must not touch the message path). `senderName`, when present,
  // sets/refreshes name and drives the human filename.
  const contactKey = `${surface}:contact:${senderId}`;
  await serializeStatsWrite(contactKey, async () => {
    const { path: fp } = await resolveStatFilename({ dir, idField: 'sender_id', id: senderId, name: senderName, io, rename: true });
    let existing = {};
    try { existing = YAML.parse(await readFileFn(fp, 'utf8')) ?? {}; } catch { /* none / unreadable → fresh */ }
    const stats = mergeContactIntoStats(existing, isoTs, senderName);
    const withId = { sender_id: senderId, ...stats };
    try {
      await mkdirFn(dir, { recursive: true });
      await writeFileFn(fp, CONTACT_STATS_HEADER + YAML.stringify(withId), 'utf8');
    } catch (e) { console.error(`!! recordMemberStat contact(${surface}/${senderId}): ${e?.message ?? e}`); }
  }).catch(() => {});   // per-contact roll-up is non-fatal — never break the message path
  return wrote;
}

// Move a contact's on-disk slug folder old→new (transcript.md, media/, identity
// files all ride along). Used by the placeholder self-heal (ensureContact +
// migratePlaceholderSlugs). Idempotent + safe: no-op if the source is missing
// or the target already exists (NEVER clobbers — a name collision must not eat a
// transcript). Returns true only when a move actually happened.
export async function renameSlugDir(surface, oldSlug, newSlug, reason = 'name changed') {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return false;
  const from = slugDir(surface, oldSlug);
  const to = slugDir(surface, newSlug);
  if (!existsSync(from) || existsSync(to)) return false;
  try {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    await appendRenameLog(to, oldSlug, newSlug, reason);
    return true;
  }
  catch (e) { console.error(`!! renameSlugDir(${oldSlug} -> ${newSlug}): ${e?.message ?? e}`); return false; }
}

// Append a rename record into the conversation folder (operator 2026-06-14:
// "renames can be logged in conversation folder"). One line per rename, so the
// folder carries its own naming history. Best-effort — never throws into a
// dispatch/migration path.
export function renameLogLine(from, to, reason = '') {
  return `${new Date().toISOString()}  ${from}  →  ${to}${reason ? `  (${reason})` : ''}\n`;
}
export async function appendRenameLog(dir, from, to, reason = '') {
  try { await appendFile(join(dir, 'renames.log'), renameLogLine(from, to, reason), 'utf8'); }
  catch (e) { console.error(`!! appendRenameLog(${dir}): ${e?.message ?? e}`); }
}

// Pre-surface-layout slug dir — used only inside the legacy migration
// chain that operates on the flat ~/.egpt/conversations/<slug>/ shape.
// Once migrateToSurfaceLayout has run, callers use slugDir(surface, slug)
// for the new ~/.egpt/conversations/<surface>/<slug>/ shape.
function _legacySlugDir(slug) {
  return join(EGPT_HOME, 'conversations', sanitizeSlug(slug));
}

// system-e shared dir. All operator-DM contacts with personality='system'
// (WA Self DM, TG operator-bot-DM, future surfaces) share ONE conversation
// thread and ONE transcript file living here. Operator (2026-05-21):
// "system-e is a same conversation thread" across surfaces — distinct from
// per-chat conversation-e which stays surface-scoped under whatsapp/, etc.
export const SYSTEM_SLUG_DIR = join(EGPT_HOME, 'conversations', '_system', 'system-e');

// Shared system-e thread state — sits at the YAML root, sibling to
// `contacts:`. All system-personality dispatches read from / write to here
// instead of the per-contact threadId field.
//
//   system_thread:
//     threadId: <claude session id>
//     threadCreatedAt: <iso>
//     identityInjectedAt: <iso>
//     threadCwd: <override path; usually null = homedir>
export function getSystemThread(state) {
  return state?.system_thread ?? null;
}
export function setSystemThread(state, patch) {
  return { ...(state ?? {}), system_thread: { ...(state?.system_thread ?? {}), ...patch } };
}

// Per-JID media directory the bridge writes to (unchanged; for
// permissioning purposes we add it to conversation-e's --add-dir set).
export function jidMediaDir(jid) {
  const sanitized = String(jid ?? '').replace(/@/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(EGPT_HOME, 'media', sanitized);
}

// Best-effort reverse of claude-code's project-dir sanitization.
//
// Claude-code derives the project-dir name from cwd by mapping `\`,
// `/`, `:`, `.`, AND `_` ALL to `-`. That's many-to-one — an output
// dash could have come from any of them — so the reverse is
// fundamentally ambiguous. This function tries the obvious case
// (drive letter prefix, slash-only) but is NOT reliable when cwd
// contained `.`, `_`, or other chars that sanitize to `-`.
//
// Returns: the resolved cwd matched against `candidateCwds` when
// possible (preferred), or a heuristic guess otherwise.
//
// Callers should treat the return as a hint, not ground truth.
// The previous implementation hard-mapped every `-` to `/` and
// produced paths like `C:/Users/an//egpt/conversations/premise/driven/bitcoin/e/2605211611`
// for the cwd `C:/Users/an/.egpt/conversations/premise_driven_bitcoin_e-2605211611`
// — totally broken. Surface-layout migration now invalidates
// threadIds instead of relying on this recovery path.
export function reverseSanitizeCwd(projectDir, candidateCwds = []) {
  if (!projectDir || typeof projectDir !== 'string') return null;

  // If the host provided a list of known cwds (e.g., from the
  // conversations registry), find one whose claude-sanitized form
  // matches the project-dir. This is the only reliable reverse.
  const sanitize = (cwd) => String(cwd).replace(/[\\\/:._]/g, '-');
  for (const cwd of candidateCwds) {
    if (sanitize(cwd) === projectDir) return cwd;
  }

  // Fallback heuristic: drive-letter unambiguously maps to 'X--'.
  // The rest is unreliable, but we attempt it for the simplest case
  // (cwd with no `.` or `_`). Callers should verify the resulting
  // path exists on disk before trusting it.
  const winMatch = projectDir.match(/^([A-Za-z])--(.+)$/);
  if (winMatch) {
    return `${winMatch[1]}:/${winMatch[2].replace(/-/g, '/')}`;
  }
  if (projectDir.startsWith('-')) {
    return '/' + projectDir.slice(1).replace(/-/g, '/');
  }
  return null;
}

// Scan ~/.claude/projects/*/<threadId>.jsonl. Returns { projectDir, cwd }
// or null when not found anywhere.
import { readdirSync as _readdirSync, existsSync as _existsSync } from 'node:fs';
export function findThreadJsonl(threadId, candidateCwds = []) {
  if (!threadId) return null;
  const projects = join(homedir(), '.claude', 'projects');
  if (!_existsSync(projects)) return null;
  let entries;
  try { entries = _readdirSync(projects); } catch (e) { console.error(`!! findThreadJsonl readdir(${projects}): ${e?.message ?? e}`); return null; }
  for (const d of entries) {
    const candidate = join(projects, d, `${threadId}.jsonl`);
    if (_existsSync(candidate)) {
      return {
        projectDir: d,
        cwd:        reverseSanitizeCwd(d, candidateCwds),
        jsonlPath:  candidate,
      };
    }
  }
  return null;
}

// Move media for each contact from ~/.egpt/media/<jid-sanitized>/ into
// the contact's <slug-dir>/media/. Operator (2026-05-20): media should
// live inside the conversation's own dir so conversation-e sees it at
// ./media without crossing its sandbox.
// Multi-JID contacts merge contents (filename-collision tolerant — on
// collision the existing file in slug-dir wins, the legacy stays for
// audit). Idempotent: skips contacts whose jid-media-dirs no longer
// exist (already migrated).
// OLD-SPINE ONLY (dead on the v2 path; invoked only from egpt-spine.mjs) — retire with the old spine.
export async function migrateMediaToSlugDirs() {
  if (!existsSync(CONV_YAML_PATH)) return { migrated: 0, files: 0 };
  const state = await readState(CONV_YAML_PATH);
  // Surface-layout is the post-2026-05-21 shape — media already lives
  // under conversations/<surface>/<slug>/media/. Nothing to migrate.
  if (_isSurfaceLayout(state)) return { migrated: 0, files: 0, skipped: 'surface-layout' };
  let contactsTouched = 0, filesMoved = 0;
  const isJid = _isJidKeyed(state);
  // Collect (slug, jids[]) tuples for both schemas.
  const groups = [];
  if (isJid) {
    // New shape: iterate primary entries (those with `slug`, not `aliasOf`).
    // Each primary's jids[] = the primary jid + every alias pointing to it.
    for (const [primaryJid, entry] of Object.entries(state.contacts ?? {})) {
      if (entry?.aliasOf || !entry?.slug) continue;
      const jids = [primaryJid];
      for (const [j, e] of Object.entries(state.contacts ?? {})) {
        if (e?.aliasOf === primaryJid) jids.push(j);
      }
      groups.push({ slug: entry.slug, jids });
    }
  } else {
    // Old shape: slug-keyed.
    for (const [slug, entry] of Object.entries(state.contacts ?? {})) {
      groups.push({ slug, jids: entry?.jids ?? [] });
    }
  }
  for (const { slug, jids } of groups) {
    // This migration predates surface-layout — destination is the
    // legacy flat path. Later migrateToSurfaceLayout moves the whole
    // slug-dir (media included) into conversations/whatsapp/<slug>/.
    const dstDir = join(_legacySlugDir(slug), 'media');
    let touched = false;
    for (const jid of jids) {
      const srcDir = jidMediaDir(jid);
      if (!existsSync(srcDir)) continue;
      try { await mkdir(dstDir, { recursive: true }); } catch {}
      const { readdir } = await import('node:fs/promises');
      let names;
      try { names = await readdir(srcDir); }
      catch (e) {
        console.error(`!! migrateMediaToSlugDirs readdir(${srcDir}): ${e?.message ?? e}`);
        continue;
      }
      for (const name of names) {
        const srcPath = join(srcDir, name);
        const dstPath = join(dstDir, name);
        if (existsSync(dstPath)) continue;
        try { await rename(srcPath, dstPath); filesMoved++; touched = true; }
        catch (e) {
          console.error(`!! migrateMediaToSlugDirs rename(${srcPath} -> ${dstPath}): ${e?.message ?? e}`);
        }
      }
    }
    if (touched) contactsTouched++;
  }
  return { migrated: contactsTouched, files: filesMoved };
}

// Detect whether the on-disk state uses the new JID-keyed shape.
// JID-keyed entries always have '@' in the key; slug-keyed never do.
function _isJidKeyed(state) {
  const keys = Object.keys(state?.contacts ?? {});
  return keys.length > 0 && keys[0].includes('@');
}

// New shape detection: top-level keys under contacts: are surface names
// (whatsapp / telegram / shell / signal), not JIDs. The migration
// migrateToSurfaceLayout() converts JID-keyed → surface-nested. Empty
// state counts as surface-layout (avoids re-running the migration when
// nothing's there yet).
function _isSurfaceLayout(state) {
  const keys = Object.keys(state?.contacts ?? {});
  if (keys.length === 0) return true;
  return keys.every(k => KNOWN_SURFACES.includes(k));
}

// Convert slug-keyed → JID-keyed (one-time, idempotent). For each
// slug-keyed entry, pick the first JID in its jids[] as primary; drop
// jids[] from the entry, replace the YAML key with primary JID, add
// alias stubs ({aliasOf: <primary>}) for additional JIDs.
//
//   contacts:
//     diego_p_rez_koma-2605200133:
//       jids: [A, B]
//       personality: default
//   →
//     contacts:
//       A:
//         slug: diego_p_rez_koma-2605200133
//         personality: default
//       B:
//         aliasOf: A
// OLD-SPINE ONLY (dead on the v2 path; invoked only from egpt-spine.mjs) — retire with the old spine.
export async function migrateConversationsToJidKey() {
  if (!existsSync(CONV_YAML_PATH)) return null;
  const state = await readState(CONV_YAML_PATH);
  if (_isSurfaceLayout(state)) return { skipped: 'surface-layout' };
  if (_isJidKeyed(state)) return { skipped: 'already-jid-keyed' };
  const oldContacts = state.contacts ?? {};
  const newContacts = {};
  let primaries = 0, aliases = 0, dangling = 0;
  for (const [slug, entry] of Object.entries(oldContacts)) {
    const jids = entry?.jids ?? [];
    if (!jids.length) {
      // No JID to key on — keep under old key (rare edge case).
      newContacts[slug] = entry;
      dangling++;
      continue;
    }
    const primaryJid = jids[0];
    const { jids: _drop, ...rest } = entry;
    newContacts[primaryJid] = { ...rest, slug };
    primaries++;
    for (const aliasJid of jids.slice(1)) {
      newContacts[aliasJid] = { aliasOf: primaryJid };
      aliases++;
    }
  }
  await writeState(CONV_YAML_PATH, { contacts: newContacts });
  return { migrated: primaries, aliases, dangling };
}

// One-shot migration: flat JID-keyed → nested-by-surface.
//
// Pre-2026-05-21: contacts at top-level under `contacts:`, slug-dirs flat at
// ~/.egpt/conversations/<slug>/. Everything was WhatsApp.
//
// Post: contacts.whatsapp.<jid>, slug-dirs at
// ~/.egpt/conversations/whatsapp/<slug>/. Telegram and Signal get
// their own buckets as their bridges register chats.
//
// Idempotent: returns { skipped } when state already surface-layout.
// Migrates BOTH yaml and on-disk slug-dirs. Crash-safe insofar as each
// dir rename is atomic; partial completion is detectable on next boot
// (some dirs in new path, some still in old) and the migration will
// finish the move.
// OLD-SPINE ONLY (dead on the v2 path; invoked only from egpt-spine.mjs) — retire with the old spine.
export async function migrateToSurfaceLayout() {
  if (!existsSync(CONV_YAML_PATH)) return { skipped: 'no registry yet' };
  const state = await readState(CONV_YAML_PATH);
  if (_isSurfaceLayout(state)) return { skipped: 'already surface-layout' };

  // Move yaml: wrap existing flat contacts in { whatsapp: ... }.
  // Each primary entry's cwd moves from conversations/<slug>/ to
  // conversations/whatsapp/<slug>/, which means claude-code's
  // sanitized project-dir name changes too (cwd is its key). Any
  // stored `threadId` points to a jsonl in the OLD project-dir,
  // unreachable from the new cwd. `reverseSanitizeCwd` can't help
  // reliably because claude-code's sanitize is many-to-one (`.`, `_`,
  // `/`, `:` all map to `-`). Cleanest fix: invalidate thread state
  // on migrated entries. Next dispatch spawns a fresh thread at the
  // new cwd. Transcripts on disk are preserved; only the live
  // claude session_id is lost.
  const flat = {};
  for (const [jid, entry] of Object.entries(state.contacts ?? {})) {
    if (entry?.aliasOf) { flat[jid] = entry; continue; }
    flat[jid] = {
      ...entry,
      threadId:           null,
      threadCwd:          null,
      threadCreatedAt:    null,
      identityInjectedAt: null,
    };
  }
  const newState = { ...state, contacts: { whatsapp: flat } };

  // Move slug-dirs: ~/.egpt/conversations/<slug>/ → conversations/whatsapp/<slug>/.
  // Iterate by primary entries (those with `.slug`, not aliases).
  const newSurfaceRoot = join(EGPT_HOME, 'conversations', 'whatsapp');
  await mkdir(newSurfaceRoot, { recursive: true });
  let dirsMoved = 0, missingDirs = 0;
  for (const [_jid, entry] of Object.entries(flat)) {
    if (entry?.aliasOf || !entry?.slug) continue;
    const oldDir = _legacySlugDir(entry.slug);
    const newDir = join(newSurfaceRoot, sanitizeSlug(entry.slug));
    if (!existsSync(oldDir)) { missingDirs++; continue; }
    if (existsSync(newDir)) { dirsMoved++; continue; }   // already moved
    try {
      await rename(oldDir, newDir);
      dirsMoved++;
    } catch (e) {
      console.error(`!! migrateToSurfaceLayout rename(${oldDir} -> ${newDir}): ${e?.message ?? e}`);
    }
  }

  await writeState(CONV_YAML_PATH, newState);
  return { migrated: Object.keys(flat).length, dirsMoved, missingDirs };
}

// At-rest repair: re-slug every primary contact whose folder name no longer
// matches its current title (pushedName) — both a nameless 'contact-<ts>'
// placeholder finally learning its name AND an old aggressively-sanitized slug
// ('Dando_Ruiz') upgrading to the path-safe title ('Dando Ruiz'). The registry
// slug + on-disk folder both follow the name (operator 2026-06-14: slugs must
// track the current name, not stay frozen). This is the batch form of the
// per-message tracking in ensureContact, for chats not currently messaging.
//
// Idempotent: an entry whose slug base already equals its title is skipped, so a
// steady state re-runs clean. Entries with no known title are left as-is.
// threadId is nulled on rename (cwd changed ⇒ stale claude session); transcripts
// move with the folder via renameSlugDir (which logs the rename). Surface-layout
// only — the earlier boot migrations convert older shapes first.
// OLD-SPINE ONLY (dead on the v2 path; invoked only from egpt-spine.mjs) — retire with the old spine.
export async function migrateSlugsToCurrentName() {
  if (!existsSync(CONV_YAML_PATH)) return { renamed: 0, skipped: 'no registry' };
  const state = await readState(CONV_YAML_PATH);
  if (!_isSurfaceLayout(state)) return { renamed: 0, skipped: 'not surface-layout' };
  const nextContacts = { ...(state.contacts ?? {}) };
  let renamed = 0, touched = false;
  for (const surface of Object.keys(nextContacts)) {
    if (!KNOWN_SURFACES.includes(surface)) continue;
    const bucket = { ...(nextContacts[surface] ?? {}) };
    let bucketTouched = false;
    for (const [jid, entry] of Object.entries(bucket)) {
      if (!entry || entry.aliasOf || !entry.slug) continue;
      const nameBase = sanitizeSlug(entry.pushedName);
      if (!nameBase || nameBase === 'contact') continue;            // no title to adopt
      const curBase = String(entry.slug).replace(/-\d{10}$/, '');
      if (nameBase === curBase) continue;                            // already current
      const suffix = String(entry.slug).match(/-(\d{10})$/)?.[1]
        || slugSuffix(entry.firstSeenAt ? new Date(entry.firstSeenAt) : new Date());
      const candidate = suffix ? `${nameBase}-${suffix}` : nameBase;
      if (candidate === entry.slug) continue;
      // Collision guard within this (in-progress) bucket — never two on one slug.
      if (_findByslug({ contacts: { [surface]: bucket } }, surface, candidate)) continue;
      await renameSlugDir(surface, entry.slug, candidate, 'name changed (boot repair)');
      bucket[jid] = { ...entry, slug: candidate, conversation_path: conversationPathOf(surface, candidate), threadId: null, threadCreatedAt: null, identityInjectedAt: null, threadCwd: null };
      bucketTouched = true; renamed++;
    }
    if (bucketTouched) { nextContacts[surface] = bucket; touched = true; }
  }
  if (touched) await writeState(CONV_YAML_PATH, { ...state, contacts: nextContacts });
  return { renamed };
}

// Rename any contact whose slug lacks the '-yymmddhhmm' suffix.
// Idempotent: skips entries that already match the pattern. Only runs
// for slug-keyed state — once converted to JID-keyed, this is a no-op.
// OLD-SPINE ONLY (dead on the v2 path; invoked only from egpt-spine.mjs) — retire with the old spine.
export async function migrateSlugSuffix() {
  if (!existsSync(CONV_YAML_PATH)) return { renamed: 0, skipped: 0 };
  const state = await readState(CONV_YAML_PATH);
  if (_isSurfaceLayout(state)) return { renamed: 0, skipped: 'surface-layout' };
  if (_isJidKeyed(state)) return { renamed: 0, skipped: 'jid-keyed' };
  const oldContacts = state.contacts ?? {};
  const nextContacts = {};
  let renamed = 0, skipped = 0;
  for (const [oldSlug, entry] of Object.entries(oldContacts)) {
    if (hasSlugSuffix(oldSlug) || !entry?.jids?.length) {
      // Already migrated or has no JIDs to derive from — keep as-is.
      // Backfill firstSeenAt for already-suffixed entries that lack it.
      if (hasSlugSuffix(oldSlug) && !entry.firstSeenAt) {
        const inferredFromSlug = (() => {
          const m = oldSlug.match(/-(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
          if (!m) return null;
          const [, yy, MM, dd, HH, mm] = m;
          return new Date(Date.UTC(2000 + Number(yy), Number(MM) - 1, Number(dd), Number(HH), Number(mm))).toISOString();
        })();
        nextContacts[oldSlug] = { ...entry, firstSeenAt: inferredFromSlug ?? entry.threadCreatedAt ?? new Date().toISOString() };
      } else {
        nextContacts[oldSlug] = entry;
      }
      skipped++;
      continue;
    }
    // Determine firstSeenAt: explicit field, then threadCreatedAt,
    // then dir mtime, then now.
    let firstSeenAt = entry.firstSeenAt;
    if (!firstSeenAt) {
      if (entry.threadCreatedAt) firstSeenAt = entry.threadCreatedAt;
      else {
        try {
          const s = await stat(_legacySlugDir(oldSlug));
          firstSeenAt = new Date(s.birthtimeMs || s.mtimeMs).toISOString();
        } catch (e) { console.error(`!! migrateSlugSuffix stat(${oldSlug}): ${e?.message ?? e}`); firstSeenAt = new Date().toISOString(); }
      }
    }
    const newSlug = appendSlugSuffix(oldSlug, new Date(firstSeenAt));
    const oldDir = _legacySlugDir(oldSlug);
    const newDir = _legacySlugDir(newSlug);
    if (existsSync(oldDir) && !existsSync(newDir)) {
      try { await rename(oldDir, newDir); }
      catch (e) { console.error(`!! migrateSlugSuffix rename(${oldDir} -> ${newDir}): ${e?.message ?? e}`); }
    }
    nextContacts[newSlug] = { ...entry, firstSeenAt };
    renamed++;
  }
  if (renamed > 0 || Object.keys(nextContacts).some(k => oldContacts[k]?.firstSeenAt !== nextContacts[k]?.firstSeenAt)) {
    await writeState(CONV_YAML_PATH, { ...state, contacts: nextContacts });
  }
  return { renamed, skipped };
}

// ── State shape ─────────────────────────────────────────────────────────────

// emptyState() returns the empty registry.
export function emptyState() {
  return { contacts: {} };
}

// ── Slug uniqueness ────────────────────────────────────────────────────────

// Operator (2026-05-20): use a local-time suffix so the slug encodes
// the contact's creation time at a glance — '-yymmddhhmm'. Two groups
// with the same name across time will have different suffixes and
// won't collide.
//   diego-2605201243  =  contact 'diego' first seen 2026-05-20 12:43 local
export function slugSuffix(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  // UTC — stable across operator's TZ changes; not the local clock.
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return yy + MM + dd + HH + mm;
}
export function hasSlugSuffix(slug) {
  return /-\d{10}$/.test(String(slug ?? ''));
}
export function appendSlugSuffix(baseSlug, date = new Date()) {
  const base = sanitizeSlug(baseSlug);
  const suf = slugSuffix(date);
  return suf ? `${base}-${suf}` : base;
}

// A PLACEHOLDER slug is one whose BASE (slug minus the -yymmddhhmm suffix) is
// empty or the generic 'contact' fallback — i.e. ensureContact had no name to
// work with at first contact (Beeper title not resolved yet, etc.). These are
// meant to self-heal: once the chat's real title is known, the slug — and its
// on-disk folder — recompute to follow the name. 'contact-2606101622' →
// placeholder; 'morgan-2606101622' → not. Without this, a chat first seen
// before its title resolved stays nameless forever (operator 2026-06-14).
export function isPlaceholderSlug(slug) {
  const base = String(slug ?? '').replace(/-\d{10}$/, '');
  return base === '' || base === 'contact';
}

// ── Slug sanitization (Windows-path-safe) ──────────────────────────────────
// Extracted VERBATIM to the leaf src/sanitize.mjs (Phase 0a of the
// conversations↔rooms merge, GENOME §2.5) so the Room abstraction can share it
// without an import cycle. Re-exported here so every existing importer of
// `sanitizeSlug` from conversations-state.mjs is unaffected. See sanitize.mjs
// for the operator rationale (keep the slug close to the real name; only strip
// Windows-illegal chars). Imported at the top so slugDir() below keeps a local
// binding; re-exported here so importers of conversations-state.sanitizeSlug work.
export { sanitizeSlug };

// ── Schema notes ───────────────────────────────────────────────────────────
//
// Operator (2026-05-21): conversations are nested by surface, then keyed by
// JID/chat-id within each surface. Surface separation lets each bridge
// own its own contact namespace. Multi-JID humans (within ONE surface)
// are modeled with a primary entry + alias entries pointing back via
// `aliasOf: <primary-jid>`. The on-disk slug-dir lives under
// conversations/<surface>/<slug>/.
//
//   contacts:
//     whatsapp:
//       "26087681749235@lid":
//         slug: diego_p_rez_koma-2605200133
//         personality: default
//         threadId: …
//         firstSeenAt: …
//         pushedName: "Diego Pérez (Koma)"
//         ...
//       "584122182178@s.whatsapp.net":
//         aliasOf: "26087681749235@lid"
//     telegram:
//       "tg:user:88164392":
//         slug: an-self-tg-2605211200
//         personality: system
//         ...

// ── Lookups ─────────────────────────────────────────────────────────────────

// Resolve a JID within one surface, following one level of aliasing.
// Returns {primaryJid, entry} or null when not registered (or alias
// dangles).
function _resolveByJid(state, surface, jid) {
  const bucket = state.contacts?.[surface];
  if (!bucket) return null;
  const direct = bucket[jid];
  if (!direct) return null;
  if (direct.aliasOf) {
    const primary = bucket[direct.aliasOf];
    if (!primary) return null;
    return { primaryJid: direct.aliasOf, entry: primary };
  }
  return { primaryJid: jid, entry: direct };
}

// Find which contact's primary entry owns a given JID inside surface.
// Returns the slug (string) or null. Slug-callers will still get the
// dir under conversations/<surface>/<slug>/.
export function findContactByJid(state, surface, jid) {
  const r = _resolveByJid(state, surface, jid);
  return r?.entry?.slug ?? null;
}

// Get the resolved contact entry + slug + primary-JID for a JID within
// a surface. Returns { jid, slug, entry, surface } or null.
export function getContact(state, surface, jid) {
  const r = _resolveByJid(state, surface, jid);
  return r ? { jid: r.primaryJid, slug: r.entry.slug, entry: r.entry, surface } : null;
}

// ── per-being view (#2: per-resident conversation shape) ────────────────────
// A conversation can host several resident beings (E + custom agents), each its own
// sub-block: `<being>: { mode, readonly: { model, effort, personality }, threadId,
// threadCreatedAt, identityInjectedAt }`. `mode` is the hot reply-gate; `readonly` is
// how the thread was started (changing it reloads the agent via /e new|identity|brain).
//
// READER-CONVERGENCE (stage 1): read the nested block, falling back to today's FLAT
// fields for the default 'e' so an un-migrated conversation resolves identically. No
// writer or migration yet — nothing nested exists until the migrate stage, so every
// read still lands on the flat fallback. Behavior-neutral by construction.
const _FLAT_ENTRY_KEYS = new Set([
  'slug', 'personality', 'threadId', 'threadCreatedAt', 'identityInjectedAt', 'threadCwd',
  'pushedName', 'firstSeenAt', 'mode', 'send_to_egpt', 'aliasOf', 'jids', 'transcribe',
  // `readonly` is object-valued but FLAT: it's the instanced-brain block the
  // brainpool writes for the default 'e' (getBeing reads flat.readonly), NOT a
  // nested resident-being. Without this, residentsOf would list a phantom
  // "readonly" resident on any v2-instanced conversation.
  'readonly',
]);

// Resolve a resident being's view of a conversation. `entry[being]` (nested) wins;
// for 'e' it falls back to the legacy flat fields. Returns null when there's no contact.
export function getBeing(state, surface, jid, being = 'e') {
  const c = getContact(state, surface, jid);
  if (!c) return null;
  const e = c.entry ?? {};
  const b = (e[being] && typeof e[being] === 'object' && !Array.isArray(e[being])) ? e[being] : null;
  const flat = being === 'e' ? e : {};
  // `readonly` (the instanced brain) reads from the nested being block, or — for the
  // legacy flat 'e' — a flat `readonly` (which is where the brainpool instances it, so
  // we never have to migrate a flat entry to nested).
  const ro = b?.readonly ?? (being === 'e' ? (flat.readonly ?? {}) : {});
  return {
    jid: c.jid, slug: c.slug, surface, being,
    present:            !!b || being === 'e',                                   // 'e' is the implicit legacy resident
    mode:               b?.mode               ?? flat.mode               ?? null,
    send_to_egpt:       b?.send_to_egpt       ?? flat.send_to_egpt       ?? null,  // per-conv 'always'|'mode' override
    threadId:           b?.threadId           ?? flat.threadId           ?? null,
    model:              ro.model              ?? null,
    effort:             ro.effort             ?? null,
    // The def name this thread was instanced from (operator 2026-07-02: new-config-only —
    // readonly.agent, no readonly.brain back-read). `brain` stays the returned property
    // (callers/tests consume it); `agent` is a cheap alias.
    brain:              ro.agent              ?? null,
    agent:              ro.agent              ?? null,
    brainType:          ro.type               ?? null,   // the engine (frozen); null = not instanced yet
    allowedTools:       ro.allowed_tools      ?? null,
  };
}

// The resident being names configured on an entry: the nested per-being keys, plus an
// implicit 'e' for a legacy flat entry (which has no nested blocks). 'e' is always first.
export function residentsOf(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const named = Object.keys(entry).filter(
    (k) => !_FLAT_ENTRY_KEYS.has(k) && entry[k] && typeof entry[k] === 'object' && !Array.isArray(entry[k]),
  );
  if (!named.length) return ['e'];
  return named.includes('e') ? named : ['e', ...named];
}

// Top-N primary contacts across surfaces, newest first — the `/e` / `/egpt` browser.
// `recencyOf(surface, slug, entry) → ms` is supplied by the caller (the spine uses the
// transcript.md mtime, falling back to firstSeenAt) so this stays pure + testable. Skips
// aliases and slug-less entries.
export function recentContacts(state, { limit = 10, offset = 0, recencyOf } = {}) {
  const rows = [];
  for (const surface of Object.keys(state?.contacts ?? {})) {
    if (!KNOWN_SURFACES.includes(surface)) continue;
    for (const [jid, entry] of Object.entries(state.contacts[surface] ?? {})) {
      if (!entry || entry.aliasOf || !entry.slug) continue;
      const recency = recencyOf ? Number(recencyOf(surface, entry.slug, entry)) || 0 : 0;
      rows.push({ surface, jid, slug: entry.slug, pushedName: entry.pushedName || entry.slug, entry, recency });
    }
  }
  rows.sort((a, b) => b.recency - a.recency);
  const start = Math.max(0, offset);
  return rows.slice(start, start + Math.max(0, limit));
}

// Look up a contact by its slug WITHIN one surface (linear scan; N small).
function _findByslug(state, surface, slug) {
  const bucket = state.contacts?.[surface] ?? {};
  for (const [jid, entry] of Object.entries(bucket)) {
    if (entry?.aliasOf) continue;
    if (entry?.slug === slug) return { primaryJid: jid, entry };
  }
  return null;
}

// Name-search: substring match (case-insensitive) on pushedName + slug.
// Searches ALL surfaces unless one is named explicitly (operator might
// want "@e new daniel" to disambiguate by surface later — for now,
// cross-surface is the default). Returns an array of
// { jid, slug, entry, pushedName, surface } for primary entries only.
export function findContactsByName(state, term, surface = null) {
  const needle = String(term ?? '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  const surfaces = surface ? [surface] : Object.keys(state.contacts ?? {});
  for (const surf of surfaces) {
    const bucket = state.contacts?.[surf] ?? {};
    for (const [jid, entry] of Object.entries(bucket)) {
      if (entry?.aliasOf || !entry?.slug) continue;
      const pn = String(entry.pushedName ?? '').toLowerCase();
      const sl = String(entry.slug ?? '').toLowerCase();
      if (pn.includes(needle) || sl.includes(needle)) {
        out.push({ jid, slug: entry.slug, entry, pushedName: entry.pushedName ?? '', surface: surf });
      }
    }
  }
  return out;
}

// Shared chat-target resolver for ANY slash command that takes a jid. Accepts:
//   - a real @-jid          → resolved to its LIVE name (bridge group subject)
//   - a fuzzy name term     → matched against the bridge's live chat names
//                             first (the real WA subjects), then registered
//                             contacts (pushedName + slug) as a fallback.
// Returns { jid, name } on a unique hit, { error } on none/ambiguous, or {} for
// an empty term (caller falls back to the current chat). `waBridge` is the live
// WA bridge (ctx.waBridgeRef.current) or null; this module stays bridge-free —
// the bridge is passed in. Always names the picked chat so a bare-jid echo is
// never the only feedback ([[feedback-verify-wa-chat-name]]).
export async function resolveChatTarget(term, { waBridge = null, surface = 'whatsapp', statePath = CONV_YAML_PATH } = {}) {
  if (!term) return {};
  // A JID/room-id (not a fuzzy name): a WA jid carries '@'; a Beeper room id is
  // '!<room>:beeper.local' (no '@'). Recognize BOTH — else a Beeper id falls to
  // the fuzzy-name path and never resolves (operator 2026-06-16: `/e auto status`
  // showed raw `!…:beeper.local` ids because getChatName was never consulted).
  const _t = String(term);
  if (_t.includes('@') || _t.startsWith('!') || _t.includes(':beeper')) {
    const live = waBridge?.getChatName?.(term) ?? null;
    if (live) return { jid: term, name: live };
    const cs = await readState(statePath);
    return { jid: term, name: findContactByJid(cs, surface, term) ?? null };
  }
  const needle = String(term).trim().toLowerCase();
  const hits = new Map();   // jid -> name
  try {
    const chats = await waBridge?.listChats?.({ all: true, limit: 2000, messagesPerChat: 0, includeStatus: false }) ?? [];
    for (const c of chats) {
      const nm = String(c.name ?? '');
      if (nm && c.jid && nm.toLowerCase().includes(needle)) hits.set(c.jid, nm);
    }
  } catch { /* bridge optional */ }
  // The LIVE chat list is AUTHORITATIVE. Only consult the registry when NO live
  // chat matched (e.g. an archived chat the bridge no longer lists) — otherwise
  // stale/duplicate registry entries (a renamed or baileys→Beeper-migrated jid
  // for the SAME group) create phantom "matches N" ambiguity for what is really
  // one live chat (operator 2026-06-16: `/e auto on HFM` → "matches 2").
  if (!hits.size) {
    try {
      const cs = await readState(statePath);
      for (const m of findContactsByName(cs, term, surface)) {
        if (!hits.has(m.jid)) hits.set(m.jid, m.pushedName || m.slug || m.jid);
      }
    } catch { /* conv-state optional */ }
  }
  const arr = [...hits.entries()];
  if (!arr.length) return { error: `no chat matches "${term}" — try /channels to see exact names, or pass the @-jid` };
  if (arr.length > 1) {
    return { error: `"${term}" matches ${arr.length}: ${arr.slice(0, 8).map(([, n]) => n).join(', ')} — be more specific or pass the @-jid` };
  }
  return { jid: arr[0][0], name: arr[0][1] };
}

// Normalize a `residents` config value to a flat list of ENABLED being-names.
// Accepts any of:
//   ["e","l"]              — plain list of names
//   [{e:true},{l:false}]   — list of {name: enabled} toggles
//   {e:true, l:false}      — a {name: enabled} map
// Falsy toggles are dropped. So the operator can write residents as a list OR
// as an enable-map (which reads naturally: `e: true`, `l: false`).
export function normalizeResidents(val) {
  if (Array.isArray(val)) {
    const out = [];
    for (const item of val) {
      if (typeof item === 'string') { if (item.trim()) out.push(item.trim()); }
      else if (item && typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) if (v) out.push(k);
      }
    }
    return out;
  }
  if (val && typeof val === 'object') {
    return Object.entries(val).filter(([, v]) => v).map(([k]) => k);
  }
  return [];
}

// ── Upsert ─────────────────────────────────────────────────────────────────

// Idempotent. Schema is surface-nested + JID-keyed. Multi-JID humans
// (within one surface) get alias entries pointing to a primary. Returns
// { state, jid, slug, entry, surface, isNew, changed } where jid is the
// PRIMARY jid (alias resolution already applied).
export function ensureContact(state, surface, jid, ctx = {}) {
  if (!surface || !KNOWN_SURFACES.includes(surface)) {
    throw new Error(`ensureContact: unknown surface "${surface}" (expected one of ${KNOWN_SURFACES.join('|')})`);
  }
  if (!jid) return { state, surface, jid: null, slug: null, entry: null, isNew: false, changed: false };

  // Deep-clone the touched bucket so the original state is unchanged.
  const prevBucket = state.contacts?.[surface] ?? {};
  const nextBucket = { ...prevBucket };
  const next = { ...state, contacts: { ...(state.contacts ?? {}), [surface]: nextBucket } };

  // 1. JID already known (directly or as alias) → refresh pushedName on primary,
  //    and SELF-HEAL a placeholder slug now that a real name may be known.
  const resolved = _resolveByJid(state, surface, jid);
  if (resolved) {
    const cur = resolved.entry;
    let changed = false;
    let patch = cur;
    if (ctx.pushedName && cur.pushedName !== ctx.pushedName) {
      patch = { ...patch, pushedName: ctx.pushedName };
      changed = true;
    }
    // Backfill the STORED conversation_path for an already-known entry (operator 2026-06-27:
    // the path must be stored). One-time per entry: once written it equals the desired value,
    // so this stops churning. A rename below overrides it for the new slug. (threadCwd is
    // retired 2026-07-02 — no v2 reader; _SLIM_DROP purges any stray key on write.)
    const _wantPath = conversationPathOf(surface, cur.slug);
    if (cur.conversation_path !== _wantPath) { patch = { ...patch, conversation_path: _wantPath }; changed = true; }
    // Track the CURRENT name (operator 2026-06-14: "the slug must be updated with
    // the current contact/group name, not frozen"). Whenever the chat's title
    // (pushedName) changes — including a 'contact-<ts>' placeholder finally
    // learning its name, OR a group being renamed — recompute the slug so the
    // folder always follows the name. Driven off pushedName ONLY (the title), so
    // it can't flap between two slug derivations. KEEP the original -yymmddhhmm
    // suffix (encodes firstSeen → preserves ordering + keeps the slug unique).
    // Renaming the slug-dir changes conversation-e's cwd, which invalidates the
    // stored threadId (a claude session keyed on cwd) — so null thread state, the
    // same trade-off migrateToSurfaceLayout makes. The on-disk transcript is
    // moved by the caller (renameSlugDir / dispatch), which also writes a
    // renames.log entry into the folder.
    let renamedFrom = null, renamedTo = null;
    const nameBase = sanitizeSlug(ctx.pushedName);
    const curBase = String(cur.slug ?? '').replace(/-\d{10}$/, '');
    if (nameBase && nameBase !== 'contact' && nameBase !== curBase) {
      const suffix = String(cur.slug).match(/-(\d{10})$/)?.[1]
        || slugSuffix(cur.firstSeenAt ? new Date(cur.firstSeenAt) : new Date());
      const candidate = suffix ? `${nameBase}-${suffix}` : nameBase;
      if (candidate !== cur.slug && !_findByslug(state, surface, candidate)) {
        renamedFrom = cur.slug;
        renamedTo = candidate;
        patch = { ...patch, slug: candidate, conversation_path: conversationPathOf(surface, candidate), threadId: null, threadCreatedAt: null, identityInjectedAt: null };
        changed = true;
      }
    }
    if (changed) nextBucket[resolved.primaryJid] = patch;
    return {
      state: changed ? next : state,
      surface,
      jid: resolved.primaryJid,
      slug: patch.slug,
      entry: changed ? patch : cur,
      isNew: false,
      changed,
      renamedFrom,
      renamedTo,
    };
  }

  // 2. New JID. Multi-JID auto-merge: does a primary entry already exist
  //    in this surface whose slug matches our intended slug (within the
  //    same minute)? Same-base-slug + same suffix == same contact → alias.
  const firstSeen = new Date();
  // pushedName (the chat TITLE) drives the slug so a fresh contact is named like
  // the contact, AND so creation agrees with the name-tracking above (no rename
  // on the 2nd message). slugHint is a fallback for callers that pass only a slug
  // (e.g. a slash command), and 'contact' is the last-resort placeholder.
  const baseSlug = sanitizeSlug(ctx.pushedName)
    || sanitizeSlug(ctx.slugHint)
    || 'contact';
  const candidateSlug = appendSlugSuffix(baseSlug, firstSeen);
  const slugMatch = _findByslug(state, surface, candidateSlug);
  if (slugMatch) {
    nextBucket[jid] = { aliasOf: slugMatch.primaryJid };
    return {
      state: next,
      surface,
      jid: slugMatch.primaryJid,
      slug: slugMatch.entry.slug,
      entry: slugMatch.entry,
      isNew: false,
      changed: true,
    };
  }

  // 3. Brand-new contact — the SLIM shape (operator 2026-07-02). `firstSeen` still drives
  //    the slug-suffix (never overwritten on /e new), but is no longer stored as a key: the
  //    lifecycle timestamps (firstSeenAt/threadCreatedAt/identityInjectedAt) live in the
  //    conversation's own stats.yaml now, and the slug's -yymmddhhmm suffix already encodes
  //    firstSeen for the rename logic. We store `home_dir` + the (home-relative) re-based
  //    `conversation_path` so the conversation is individually relocatable. The
  //    per-conversation `personality` key is RETIRED — the identity feed is a property of
  //    the AGENT TYPE — so `ctx.personality` (still passed by legacy callers) is ignored.
  const entry = {
    slug: candidateSlug,
    conversation_path: conversationPathOf(surface, candidateSlug),
    home_dir: homeDirMsys(),
    threadId: null,
    pushedName: ctx.pushedName ?? '',
  };
  nextBucket[jid] = entry;
  return { state: next, surface, jid, slug: candidateSlug, entry, isNew: true, changed: true };
}

// patchContact accepts EITHER a JID or a slug as the lookup key, scoped
// to one surface. The patch always lands on the primary entry. Returns
// a new state; if not found, returns the original state unchanged.
export function patchContact(state, surface, jidOrSlug, patch) {
  if (!surface || !KNOWN_SURFACES.includes(surface)) {
    throw new Error(`patchContact: unknown surface "${surface}"`);
  }
  const prevBucket = state.contacts?.[surface] ?? {};
  // First try JID lookup (preferred for new code).
  const byJid = _resolveByJid(state, surface, jidOrSlug);
  if (byJid) {
    const nextBucket = { ...prevBucket, [byJid.primaryJid]: { ...byJid.entry, ...patch } };
    return { ...state, contacts: { ...(state.contacts ?? {}), [surface]: nextBucket } };
  }
  // Fall back: slug lookup (back-compat with slug-passing callers).
  const bySlug = _findByslug(state, surface, jidOrSlug);
  if (bySlug) {
    const nextBucket = { ...prevBucket, [bySlug.primaryJid]: { ...bySlug.entry, ...patch } };
    return { ...state, contacts: { ...(state.contacts ?? {}), [surface]: nextBucket } };
  }
  return state;
}

// Record that a new claude thread was just spawned for a contact's resident being.
// The default 'e' writes the FLAT thread fields exactly as before (an un-migrated
// conversation is byte-identical). Any OTHER being writes a NESTED `<being>` block
// so its thread persists alongside E's — merged over the block's existing fields
// (mode/readonly survive), and it then shows up as a resident (residentsOf), which
// is the intended per-being conversation shape.
export function recordThread(state, surface, jidOrSlug, threadId, nowIso = nowIsoString(), being = 'e') {
  if (being === 'e') {
    return patchContact(state, surface, jidOrSlug, {
      threadId,
      threadCreatedAt: nowIso,
      identityInjectedAt: nowIso,
    });
  }
  const existing = _entryByJidOrSlug(state, surface, jidOrSlug)?.[being] ?? {};
  return patchContact(state, surface, jidOrSlug, {
    [being]: { ...existing, threadId, threadCreatedAt: nowIso, identityInjectedAt: nowIso },
  });
}

// Resolve the primary entry for a jid OR slug within a surface (the same lookup
// order patchContact uses). Returns the entry object or null. Used by the
// being-aware recordThread to read the current nested block before merging.
function _entryByJidOrSlug(state, surface, jidOrSlug) {
  const byJid = _resolveByJid(state, surface, jidOrSlug);
  if (byJid) return byJid.entry;
  return _findByslug(state, surface, jidOrSlug)?.entry ?? null;
}

// ── Predicates ─────────────────────────────────────────────────────────────

export function isMuted(entry) {
  return entry?.personality === 'mute';
}

// ── Personality file resolution ────────────────────────────────────────────

// Resolution chain: operator dir → shipped dir. Returns absolute path or null.
export function resolvePersonalityFile(name, opts = {}) {
  const safeName = sanitizeSlug(name || 'default') || 'default';
  const opDir   = opts.operatorDir   ?? PERSONALITIES_OPERATOR_DIR;
  const shipDir = opts.shippedDir    ?? PERSONALITIES_SHIPPED_DIR;
  const candidates = [
    join(opDir, `${safeName}.md`),
    join(shipDir, `${safeName}.md`),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// Safe-default tool allowlist for personalities that have no frontmatter
// or no `allowed_tools` field. File ops (read + write + edit) scoped to
// the contact's slug-dir via additionalDirectories; READ-ONLY web access
// (WebSearch + WebFetch); no Bash, no Agent, no NotebookEdit.
//
// Operator security trail (2026-05-22):
//   - First pass: "if any of my contacts convince the model to send
//     messages via node, that would be a major flaw." → restrict tools.
//   - Refinement: "conversation-e should be able to write text files"
//     (so it can maintain summaries, daily notes, scratch state in its
//     own slug-dir). The additionalDirectories pin keeps writes
//     contained; absence of Bash blocks self-elevation (no
//     `chmod +x && ./malicious.sh` path), absence of Agent blocks
//     spawning sub-agents that could escape the scope.
//   - 2026-06-16: grant WebSearch + WebFetch. E kept telling contacts it
//     "couldn't search the internet" and asking for authorization — the
//     lineage prelude PROMISES these tools, but the permission layer didn't
//     grant them (they're non-file tools, so under the confined path they
//     weren't pre-approved → a headless permission prompt = denied). They are
//     READ-ONLY network tools: no self-elevation (still no Bash/Agent), no file
//     escape (file tools stay path-confined). So E can answer "what happened in
//     X?" without widening its sandbox.
export const DEFAULT_PERSONALITY_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

function _parseFrontmatter(raw) {
  if (typeof raw !== 'string') return { meta: {}, body: '' };
  const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  try {
    const meta = YAML.parse(m[1]);
    return { meta: (meta && typeof meta === 'object') ? meta : {}, body: m[2] };
  } catch (e) {
    console.error(`!! personality frontmatter parse: ${e?.message ?? e}`);
    return { meta: {}, body: m[2] };
  }
}

export async function readPersonality(name, opts = {}) {
  const p = resolvePersonalityFile(name, opts);
  if (!p) return null;
  try {
    const raw = await readFile(p, 'utf8');
    // Strip YAML frontmatter from the body that goes into the prompt;
    // the meta lives separately (see readPersonalityMeta below).
    return _parseFrontmatter(raw).body;
  }
  catch (e) { console.error(`!! readPersonality(${name}): ${e?.message ?? e}`); return null; }
}

// Read the personality's YAML frontmatter (allowed_tools, etc.) without
// the body. Returns { allowed_tools, ... } or a safe default when the
// file is missing or has no frontmatter.
export async function readPersonalityMeta(name, opts = {}) {
  const p = resolvePersonalityFile(name, opts);
  if (!p) return { allowed_tools: DEFAULT_PERSONALITY_TOOLS };
  try {
    const raw = await readFile(p, 'utf8');
    const { meta } = _parseFrontmatter(raw);
    if (meta.allowed_tools === undefined) {
      meta.allowed_tools = DEFAULT_PERSONALITY_TOOLS;
    }
    return meta;
  } catch (e) {
    console.error(`!! readPersonalityMeta(${name}): ${e?.message ?? e}`);
    return { allowed_tools: DEFAULT_PERSONALITY_TOOLS };
  }
}

// Operator-editable rules + pointers files. These live in ~/.egpt/ but
// get COPIED into <slug-dir>/ at /e new and /e persona so conversation-e
// (sandboxed to its slug-dir) can `cat ./rules.md ./pointers.md`.
const RULES_OPERATOR_PATH    = join(EGPT_HOME, 'rules.md');
const POINTERS_OPERATOR_PATH = join(EGPT_HOME, 'pointers.md');

// Read identity/rules/pointers content. Returns { identity, rules, pointers }
// with empty strings (not null) for any missing file — easier downstream.
export async function readIdentityBundle(personalityName, opts = {}) {
  // The PERSONALITY (config/personalities/<name>.md) — historically returned as
  // `identity`, kept under that key for back-compat. The egpt-wide MANIFEST
  // (e_identity.md) is passed in by the caller via opts.manifest, since this
  // module doesn't know APP_DIR / config; '' when omitted.
  const personality = (await readPersonality(personalityName, opts)) ?? '';
  let rules = '';
  let pointers = '';
  try { rules    = await readFile(opts.rulesPath    ?? RULES_OPERATOR_PATH,    'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') console.error(`!! readIdentityBundle rules.md: ${e?.message ?? e}`); }
  try { pointers = await readFile(opts.pointersPath ?? POINTERS_OPERATOR_PATH, 'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') console.error(`!! readIdentityBundle pointers.md: ${e?.message ?? e}`); }
  return { manifest: String(opts.manifest ?? ''), identity: personality, personality, rules, pointers };
}

// <slug>/identity.d/ — the ordered set of files fed to conversation-e. Files
// sort lexically; numeric prefixes give order + insertion gaps so the operator
// (or E) can drop extras (e.g. 30-project.md) and they're fed too — no schema.
export function identityDir(surface, slug) {
  return join(slugDir(surface, slug), 'identity.d');
}

// Populate identity.d/ from sources. `manifest` is the egpt-wide e_identity
// content (caller resolves brains.identity). Also keeps the flat ./identity.md
// (= personality, back-compat) + ./rules.md + ./pointers.md the sandbox may cat.
export async function populateIdentityDir(surface, slug, personalityName, opts = {}) {
  const bundle = await readIdentityBundle(personalityName, opts);
  const dir = slugDir(surface, slug);
  const idd = identityDir(surface, slug);
  await mkdir(idd, { recursive: true });
  await writeFile(join(idd, '00-manifest.md'),    bundle.manifest,    'utf8');
  await writeFile(join(idd, '20-personality.md'), bundle.personality, 'utf8');
  await writeFile(join(idd, '40-rules.md'),       bundle.rules,       'utf8');
  await writeFile(join(idd, '60-pointers.md'),    bundle.pointers,    'utf8');
  // Flat copies for back-compat (e_identity references ./rules.md etc.).
  await writeFile(join(dir, 'identity.md'), bundle.personality, 'utf8');
  await writeFile(join(dir, 'rules.md'),    bundle.rules,       'utf8');
  await writeFile(join(dir, 'pointers.md'), bundle.pointers,    'utf8');
  return bundle;
}

// Back-compat alias: same as populateIdentityDir, returns the bundle.
export async function installPersonaIntoSlugDir(surface, slug, personalityName, opts = {}) {
  return populateIdentityDir(surface, slug, personalityName, opts);
}

// Rewrite ONLY the personality slice of identity.d/ (for /e persona — swap
// flavor without re-sending the manifest). Returns the new personality content.
export async function writeIdentityPersonality(surface, slug, personalityName, opts = {}) {
  const idd = identityDir(surface, slug);
  await mkdir(idd, { recursive: true });
  const personality = (await readPersonality(personalityName, opts)) ?? '';
  await writeFile(join(idd, '20-personality.md'), personality, 'utf8');
  await writeFile(join(slugDir(surface, slug), 'identity.md'), personality, 'utf8');
  return personality;
}

// Read + concat identity.d/*.md in lexical (= numeric-prefix) order, skipping
// empty files. This is the full bundle fed to E on /e new and /e identity.
export async function readIdentityDir(surface, slug) {
  const idd = identityDir(surface, slug);
  let names = [];
  try { const { readdir } = await import('node:fs/promises'); names = await readdir(idd); }
  catch { return ''; }
  const parts = [];
  for (const n of names.filter(x => x.endsWith('.md')).sort()) {
    try { const t = (await readFile(join(idd, n), 'utf8')).trim(); if (t) parts.push(t); }
    catch (e) { console.error(`!! readIdentityDir ${n}: ${e?.message ?? e}`); }
  }
  return parts.join('\n\n');
}

// ── Identities as flat .md files (operator 2026-07-03) ──────────────────────
// An identity is ONE markdown file `config/identities/<name>.md` (profile). The
// kickoff feed = that identity file + the SHARED pointers/rules (the room template
// config/skeletons/room/{30-pointers,40-rules}.md), identity FIRST — the same content
// + order as the retired 00/30/40 folder trio, just re-sourced. A name with no profile
// identity file falls back to the room template's 00-identity.md (the shipped eGPT
// default). No repo-root identities/ back-read (the operator's new-only house rule).

// The shared room template dir: the profile's seeded copy wins; the repo's shipped
// template is the fallback so a fresh, un-seeded profile still resolves the eGPT default.
function roomTemplateDir() {
  return existsSync(ROOM_TEMPLATE_PROFILE_DIR) ? ROOM_TEMPLATE_PROFILE_DIR : ROOM_TEMPLATE_SHIPPED_DIR;
}

// Best-effort file read; a missing/unreadable file yields the fallback (never throws).
async function _readFileOr(fp, fallback = '') {
  try { return await readFile(fp, 'utf8'); } catch { return fallback; }
}

// Resolve an identity NAME to its profile markdown file config/identities/<name>.md.
// Returns the path when it exists, else null (the caller falls back to the room
// template's 00-identity.md — the shipped eGPT default).
export function resolveIdentityFile(name) {
  const safe = sanitizeSlug(name || 'egpt') || 'egpt';
  const p = join(IDENTITIES_PROFILE_DIR, `${safe}.md`);
  return existsSync(p) ? p : null;
}

// Enumerate identity-LAYER names for the `/e` wizard's personality pick: the *.md
// basenames in the profile's config/identities/ (operator-authored: seeded presets +
// wizard free-text layers) PLUS 'egpt' (the shipped default, which lives in the room
// template, not a profile file). Deduped case-insensitively + sorted. Never throws.
export function listIdentityLayers() {
  const seen = new Set();
  const out = [];
  const add = (n) => { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(n); } };
  add('egpt');
  let ents = [];
  try { ents = readdirSync(IDENTITIES_PROFILE_DIR, { withFileTypes: true }); } catch { ents = []; }
  for (const ent of ents) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) add(ent.name.slice(0, -3));
  }
  return out.sort();
}

// The identity + shared pointers + rules, in that order — the feed shape shared by the
// in-context kickoff (readIdentityFeed) and the slug-dir install (installIdentity).
async function _identityLayers(name) {
  const room = roomTemplateDir();
  const idFile = resolveIdentityFile(name);
  const identity = await _readFileOr(idFile ?? join(room, '00-identity.md'));
  const pointers = await _readFileOr(join(room, '30-pointers.md'));
  const rules    = await _readFileOr(join(room, '40-rules.md'));
  return { identity, pointers, rules };
}

// Install identity <name> into a conversation slug-dir: write the flat layers (so
// ./identity.md, ./pointers.md, ./rules.md exist in the sandbox) and return
// { feed, files, dir }. feed = identity + pointers + rules for the kickoff turn.
export async function installIdentity(surface, slug, name) {
  const { identity, pointers, rules } = await _identityLayers(name);
  const slugd = slugDir(surface, slug);
  await mkdir(slugd, { recursive: true });
  const files = [];
  await writeFile(join(slugd, 'identity.md'), identity, 'utf8'); files.push('identity.md');
  await writeFile(join(slugd, 'pointers.md'), pointers, 'utf8'); files.push('pointers.md');
  await writeFile(join(slugd, 'rules.md'),    rules,    'utf8'); files.push('rules.md');
  const feed = [identity, pointers, rules].map(s => s.trim()).filter(Boolean).join('\n\n');
  return { feed, files, dir: resolveIdentityFile(name) ?? join(roomTemplateDir(), '00-identity.md') };
}

// Read identity <name>'s concatenated feed (identity + pointers + rules) WITHOUT
// writing any slug-dir copies — for the first-dispatch auto-wrap, which just needs the
// content in-context. Never empty for a resolvable persona (eGPT is the default).
export async function readIdentityFeed(name) {
  const { identity, pointers, rules } = await _identityLayers(name);
  return [identity, pointers, rules].map(s => s.trim()).filter(Boolean).join('\n\n');
}

// The `mode: auto` operator-role instruction layer (config/skeletons/auto-mode.md).
// Read profile-first, repo-fallback (mirror of roomTemplateDir). '' when absent (an
// auto conversation then simply gates like 'on' with no extra layer — never throws).
// Appended to an auto conversation's kickoff feed by the brainpool.
export async function readAutoModeLayer() {
  const profile = join(SKELETONS_PROFILE_DIR, 'auto-mode.md');
  const shipped = join(SKELETONS_SHIPPED_DIR, 'auto-mode.md');
  return (await _readFileOr(existsSync(profile) ? profile : shipped)).trim();
}

// Full-install announcement: the whole identity.d bundle (manifest +
// personality + rules + pointers + any extras), re-grounding the model.
export function buildIdentityAnnouncement(personalityName, feed) {
  // Feed ONLY the identity text — no "Reboot complete / Installing persona" preamble
  // (operator 2026-06-29: that framing reads like a roleplay setup the model declines).
  return String(feed ?? '').trim();
}

// Legacy frame kept for slash/egpt.mjs (the cross-chat @egpt variant) until it
// migrates to identity.d. Embeds the manifest first when present.
export function buildRebootAnnouncement(personalityName, bundle) {
  const { manifest = '', identity = '', rules = '', pointers = '' } = bundle;
  return [
    'Reboot complete. All systems operational.',
    `Installing persona: ${personalityName}`,
    '',
    manifest.trim(),
    manifest.trim() ? '' : null,
    identity.trim(),
    '',
    'Please, remember to:',
    '- follow the ./rules.md:',
    rules.trim(),
    '',
    '- read your ./pointers.md file when you think you lack an ability or tool:',
    pointers.trim(),
  ].filter(x => x != null).join('\n');
}

// ── YAML serialization ─────────────────────────────────────────────────────

// The ON-DISK representation is SLIM (operator 2026-07-02): each contact's `pushedName`
// becomes the INLINE COMMENT on its jid key (` # <name>`, not a data key), the derived
// `slug` is dropped (recovered from conversation_path's basename), and the lifecycle
// timestamps (firstSeenAt/threadCreatedAt/identityInjectedAt) are dropped (they live in the
// conversation's stats.yaml). `home_dir` + the home-relative `conversation_path` are always
// emitted so each entry is a relocatable pointer. The IN-MEMORY shape is UNCHANGED — parse
// re-hydrates slug + pushedName as fields — so every consumer keeps working; only the FILE
// slims. Aliases (`{aliasOf}`) pass through untouched.
const _SLIM_DROP = new Set(['slug', 'pushedName', 'firstSeenAt', 'threadCreatedAt', 'identityInjectedAt', 'threadCwd']);
const _pathBasename = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

export function serialize(state) {
  // Build the slimmed plain object first (drop the derived/moved keys), keeping the jid→name
  // map so we can re-attach names as key comments on the built Document.
  const src = state && typeof state === 'object' ? state : emptyState();
  const names = {};   // `${surface} ${jid}` -> pushedName
  const outContacts = {};
  for (const [surface, bucket] of Object.entries(src.contacts ?? {})) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) { outContacts[surface] = bucket; continue; }
    const outBucket = {};
    for (const [jid, entry] of Object.entries(bucket)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.aliasOf) { outBucket[jid] = entry; continue; }
      const slim = {};
      for (const [k, v] of Object.entries(entry)) { if (!_SLIM_DROP.has(k)) slim[k] = v; }
      // Always emit the relocatable pointer: home_dir + a (home-relative) conversation_path
      // — computed from the slug when absent so the derived slug survives the round-trip.
      if (slim.conversation_path == null) slim.conversation_path = conversationPathOf(surface, entry.slug);
      if (slim.home_dir == null) slim.home_dir = homeDirMsys();
      outBucket[jid] = slim;
      if (entry.pushedName) names[`${surface} ${jid}`] = String(entry.pushedName).replace(/[\r\n]+/g, ' ');
    }
    outContacts[surface] = outBucket;
  }
  const slimState = { ...src, contacts: outContacts };

  const doc = new YAML.Document(slimState);
  const contactsNode = doc.get('contacts');
  if (contactsNode && contactsNode.items) {
    for (const surfPair of contactsNode.items) {
      const surface = String(surfPair.key.value ?? surfPair.key);
      const bucketNode = surfPair.value;
      if (!bucketNode || !bucketNode.items) continue;
      for (const pair of bucketNode.items) {
        const jid = String(pair.key.value ?? pair.key);
        const nm = names[`${surface} ${jid}`];
        if (nm) pair.key.comment = ' ' + nm;   // renders `"<jid>": # <name>` on the key line
      }
    }
  }
  return doc.toString({ lineWidth: 100 });
}

export function parse(text) {
  if (!text || !text.trim()) return emptyState();
  const doc = YAML.parseDocument(text);
  const obj = doc.toJS() ?? {};
  if (!obj || typeof obj !== 'object') return emptyState();
  if (!obj.contacts || typeof obj.contacts !== 'object') { obj.contacts = {}; return obj; }
  // Re-hydrate the in-memory fields the slim file omits: pushedName from the jid key's inline
  // comment (recovered as the value's commentBefore after a round-trip), slug from
  // conversation_path's basename. An OLD file that still carries pushedName/slug as KEYS keeps
  // them (a comment/derivation only fills when the key is absent), so pre-migration YAML reads
  // byte-for-byte the same in memory.
  const contactsNode = doc.get('contacts');
  const commentByJid = {};   // `${surface} ${jid}` -> recovered name
  if (contactsNode && contactsNode.items) {
    for (const surfPair of contactsNode.items) {
      const surface = String(surfPair.key.value ?? surfPair.key);
      const bucketNode = surfPair.value;
      if (!bucketNode || !bucketNode.items) continue;
      for (const pair of bucketNode.items) {
        const jid = String(pair.key.value ?? pair.key);
        const c = pair.value?.commentBefore ?? pair.key.comment ?? null;
        if (c != null) commentByJid[`${surface} ${jid}`] = String(c).trim();
      }
    }
  }
  for (const [surface, bucket] of Object.entries(obj.contacts)) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const [jid, entry] of Object.entries(bucket)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.aliasOf) continue;
      const nm = commentByJid[`${surface} ${jid}`];
      if (typeof entry.pushedName !== 'string' || (nm != null)) entry.pushedName = nm ?? entry.pushedName ?? '';
      if (typeof entry.slug !== 'string' || !entry.slug) entry.slug = _pathBasename(entry.conversation_path);
    }
  }
  return obj;
}

// ── Disk I/O helpers ───────────────────────────────────────────────────────

export async function readState(yamlPath) {
  try {
    const text = await readFile(yamlPath, 'utf8');
    return parse(text);
  } catch (e) {
    // ENOENT on first daemon run is legitimate (empty registry).
    // Anything else (parse error, permission, IO) must surface so
    // the operator can see WHY the registry came back empty
    // — silent fallback is how we lost yesterday's contacts.
    if (e?.code !== 'ENOENT') {
      console.error(`!! readState(${yamlPath}): ${e?.stack ?? e?.message ?? e}`);
    }
    return emptyState();
  }
}

// Atomic write: serialize → temp file → rename to final. Protects against
// torn writes if the process is killed mid-write or if a concurrent reader
// catches the file half-written. The rename is atomic at the fs level on
// both POSIX and Windows NTFS (within the same volume). Codex review
// 2026-05-21: parse failures returning emptyState made the next write
// dangerous — atomicity removes the partial-write class of failures.
export async function writeState(yamlPath, state) {
  await mkdir(dirname(yamlPath), { recursive: true });
  const body = serialize(state);
  const tmp = yamlPath + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, yamlPath);
}

// ── Migration: conversations.json → conversations.yaml ────────────────────

// Reads the old JID-keyed JSON shape and rebuilds it as the new slug-keyed
// YAML shape. JSON entries with the same customName merge into one
// new contact (their JIDs accumulate). Old entries without a customName
// get a slug derived from pushedName, or 'contact_<short>'.
//
// Returns { migrated: <#contacts>, jids: <#total jids merged> } or null
// when no migration needed.
// OLD-SPINE ONLY (dead on the v2 path; invoked only from egpt-spine.mjs) — retire with the old spine.
export function migrateJsonToYaml(jsonMap) {
  if (!jsonMap || typeof jsonMap !== 'object') return null;
  const state = emptyState();
  let totalJids = 0;
  for (const [jid, row] of Object.entries(jsonMap)) {
    if (!row || typeof row !== 'object') continue;
    totalJids++;
    const slug = (
      sanitizeSlug(row.customName)
      || sanitizeSlug(row.pushedName)
      || `contact_${sanitizeSlug(jid).slice(0, 12)}`
    );
    if (!state.contacts[slug]) {
      state.contacts[slug] = {
        personality: 'default',
        threadId: null,
        threadCreatedAt: null,
        identityInjectedAt: null,
        pushedName: row.pushedName ?? '',
        jids: [],
      };
    }
    state.contacts[slug].jids.push(jid);
    if (row.pushedName && !state.contacts[slug].pushedName) {
      state.contacts[slug].pushedName = row.pushedName;
    }
    // Preserve customNameSource flag if operator set one.
    if (row.customNameSource) state.contacts[slug].customNameSource = row.customNameSource;
  }
  return { state, migrated: Object.keys(state.contacts).length, jids: totalJids };
}

// ── Layout migration (flat conversations/e/<slug>.md → per-slug dirs) ─────

// Detect-and-migrate. Idempotent: if the new layout already exists,
// returns { skipped: 'reason' } without touching disk. Otherwise
// reads the old registry, creates per-slug dirs, moves transcript
// files in, and writes the registry at its new location.
import { readdirSync } from 'node:fs';
// OLD-SPINE ONLY (dead on the v2 path; invoked only from egpt-spine.mjs) — retire with the old spine.
export async function migrateLayoutIfNeeded() {
  const newRegistry    = CONV_YAML_PATH;
  const oldDirRoot     = join(EGPT_HOME, 'conversations', 'e');
  const oldYaml        = join(oldDirRoot, 'conversations.yaml');
  const oldJson        = join(oldDirRoot, 'conversations.json');
  if (existsSync(newRegistry)) return { skipped: 'new layout already in place' };

  // Source the state from whichever legacy file exists.
  let state = null;
  if (existsSync(oldYaml)) {
    try { state = parse(await readFile(oldYaml, 'utf8')); } catch {}
  }
  if (!state && existsSync(oldJson)) {
    try {
      const json = JSON.parse(await readFile(oldJson, 'utf8'));
      const r = migrateJsonToYaml(json);
      if (r) state = r.state;
    } catch {}
  }
  if (!state) return { skipped: 'no old registry found' };

  // For each slug: create new dir, find + move transcript file in.
  // Old filename shapes we've used (worst case all five):
  //   <slug>.md
  //   <jid-sanitized>.md            (early days, jid-only)
  //   <jid-sanitized>__<slug>.md    (most common)
  //   <slug>__...md
  //   <jid-sanitized>__<pushedName-sanitized>.md   (pushedName variant)
  // Match case-insensitively + try each contact JID.
  let moved = 0;
  const entries = existsSync(oldDirRoot) ? readdirSync(oldDirRoot) : [];
  const lcEntries = entries.map(fn => ({ fn, lc: fn.toLowerCase() }));
  for (const [slug, entry] of Object.entries(state.contacts ?? {})) {
    // This migration converts JSON → flat slug-keyed YAML. The "new"
    // dir at this point is still the legacy flat path; the later
    // migrateToSurfaceLayout pushes it under conversations/whatsapp/.
    const newDir = _legacySlugDir(slug);
    try { await mkdir(newDir, { recursive: true }); } catch (e) { console.error(`!! migrateLayoutIfNeeded mkdir(${newDir}): ${e?.message ?? e}`); }
    const safeSlug = sanitizeSlug(slug).toLowerCase();
    const jids = entry.jids ?? [];
    const jidSluglets = jids.map(j => sanitizeSlug(j).toLowerCase());
    const candidates = lcEntries
      .filter(({ fn, lc }) => fn.endsWith('.md') && lc !== 'conversations.yaml')
      .filter(({ lc }) =>
        lc === `${safeSlug}.md` ||
        lc.endsWith(`__${safeSlug}.md`) ||
        lc.startsWith(`${safeSlug}__`) ||
        jidSluglets.some(j => lc === `${j}.md` || lc.startsWith(`${j}__`))
      )
      .map(({ fn }) => fn);
    if (!candidates.length) continue;
    // Pick the longest filename (most descriptive); if multiple, move
    // the first into transcript.md and append the rest below the header
    // so no history is lost.
    candidates.sort((a, b) => b.length - a.length);
    const target = join(newDir, 'transcript.md');
    try {
      if (!existsSync(target)) {
        await rename(join(oldDirRoot, candidates[0]), target);
        moved++;
      }
      // Any leftover candidates: append their content + bak-rename
      for (const fn of candidates.slice(1)) {
        try {
          const extra = await readFile(join(oldDirRoot, fn), 'utf8');
          const sep = `\n\n<!-- merged from legacy file: ${fn} -->\n\n`;
          await (await import('node:fs/promises')).appendFile(target, sep + extra);
          await rename(join(oldDirRoot, fn), join(oldDirRoot, fn + '.merged.bak'));
        } catch (e) { console.error(`!! migrateLayoutIfNeeded merge(${fn}): ${e?.message ?? e}`); }
      }
    } catch (e) { console.error(`!! migrateLayoutIfNeeded transcript-merge: ${e?.message ?? e}`); }
  }
  await writeFile(newRegistry, serialize(state), 'utf8');
  if (existsSync(oldYaml)) { try { await rename(oldYaml, oldYaml + '.bak'); } catch (e) { console.error(`!! migrateLayoutIfNeeded yaml-bak: ${e?.message ?? e}`); } }
  if (existsSync(oldJson)) { try { await rename(oldJson, oldJson + '.bak'); } catch (e) { console.error(`!! migrateLayoutIfNeeded json-bak: ${e?.message ?? e}`); } }
  return { migrated: Object.keys(state.contacts ?? {}).length, moved };
}

// ── ISO time helper ────────────────────────────────────────────────────────

export function nowIsoString(d = new Date()) {
  return d.toISOString();
}

// Convert legacy numeric `at` (ms since epoch) → ISO. Used by persona-state
// when reading old config.json that still has numeric timestamps.
export function isoFromMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}
