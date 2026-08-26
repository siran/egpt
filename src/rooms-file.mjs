// rooms-file.mjs — config/rooms.yaml, the ROOM rung.
//
// Sibling to config/conversations.yaml and shaped like it: ONE file, keyed by
// the entity's namespace `<surface>/<slug>` — the same key listEntityDirs and
// the resolver already use. Before this, every room kept its own
// conversations/<surface>/<slug>/config.yaml; the operator's ruling
// (2026-08-24) is that a conversation folder belongs to the BEING and holds no
// operator config, so the block moved out to a registry file the operator owns.
//
// NO ROOM IS SPECIAL. dj-son is a row here like any other — a room that happens
// to carry permissions and a heartbeat. There is no code path keyed to a name.
//
// Writes go through the YAML Document API so an operator's comments and their
// other rows survive a single-block edit.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from './egpt-home.mjs';
import { sanitizeSlug } from './sanitize.mjs';

// Resolved LAZILY, not frozen at module load: a test file that points EGPT_HOME
// at its own private profile must be honoured even though egpt-home.mjs froze
// its constant earlier. One shared rung file means parallel test files would
// otherwise contend on a single path.
export const roomsFilePath = () => join(process.env.EGPT_HOME || EGPT_HOME, 'config', 'rooms.yaml');
export const ROOMS_FILE = roomsFilePath();
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The whole file as a plain object: { "<surface>/<slug>": {...} }. Never throws. */
export async function readRoomsFile({ path = roomsFilePath(), read = readFile } = {}) {
  let doc;
  try { doc = YAML.parse(await read(path, 'utf8')); } catch { return {}; }
  if (!isPlainObject(doc)) return {};
  // Tolerate both the wrapped shape (rooms:) and a bare top-level map.
  const rooms = isPlainObject(doc.rooms) ? doc.rooms : doc;
  return isPlainObject(rooms) ? rooms : {};
}

/** One room's config block. `{}` when the row (or the file) is absent. */
export async function readRoomConfig(ns, deps = {}) {
  const all = await readRoomsFile(deps);
  const row = all[String(ns ?? '')];
  return isPlainObject(row) ? row : {};
}

/**
 * Set ONE top-level block for ONE room, preserving every other row and the
 * operator's comments. Creates the file (and config/) when absent.
 */
export async function setRoomConfigBlock(ns, key, value, { path = roomsFilePath(), read = readFile, write = writeFile, ensureDir = mkdir } = {}) {
  await ensureDir(dirname(path), { recursive: true });
  let text = '';
  try { text = await read(path, 'utf8'); } catch { /* new file */ }
  const doc = YAML.parseDocument(text || 'rooms:\n');
  if (doc.get('rooms') == null) doc.set('rooms', doc.createNode({}));
  doc.setIn(['rooms', String(ns), key], value);
  await write(path, String(doc), 'utf8');
}

/**
 * Set a DOTTED key inside one room's row: setRoomConfigKey('room/dj-son',
 * 'radio_service.wildnloyal.enabled', false).
 *
 * `ns` is treated as ONE key, never split: a slug legitimately contains spaces
 * and can contain dots ("HFM - high frequency masturbation-2606300017"), so
 * splitting the whole path would shatter it into nested maps.
 */
export async function setRoomConfigKey(ns, dottedKey, value, { path = roomsFilePath(), read = readFile, write = writeFile, ensureDir = mkdir } = {}) {
  await ensureDir(dirname(path), { recursive: true });
  let text = '';
  try { text = await read(path, 'utf8'); } catch { /* new file */ }
  const doc = YAML.parseDocument(text || 'rooms:\n');
  if (doc.get('rooms') == null) doc.set('rooms', doc.createNode({}));
  doc.setIn(['rooms', String(ns), ...String(dottedKey).split('.')], value);
  await write(path, String(doc), 'utf8');
}

/** Drop one room's whole row (used when a room is deleted). */
export async function removeRoomRow(ns, { path = roomsFilePath(), read = readFile, write = writeFile } = {}) {
  let text = '';
  try { text = await read(path, 'utf8'); } catch { return; }
  const doc = YAML.parseDocument(text || '');
  doc.deleteIn(['rooms', String(ns)]);
  await write(path, String(doc), 'utf8');
}

/** Drop ONE block from one room's row, leaving the row and its siblings alone. */
export async function deleteRoomConfigBlock(ns, key, { path = roomsFilePath(), read = readFile, write = writeFile } = {}) {
  let text = '';
  try { text = await read(path, 'utf8'); } catch { return; }
  const doc = YAML.parseDocument(text || '');
  // Both shapes readRoomsFile tolerates: the wrapped `rooms:` map and a bare top-level one.
  const gone = doc.deleteIn(['rooms', String(ns), key]) || doc.deleteIn([String(ns), key]);
  if (!gone) return;
  await write(path, String(doc), 'utf8');
}

// ── THE ROOM RUNG'S PER-BEING STATE (operator 2026-08-26) ───────────────────
// *"rooms.yaml is for non-beeper conversations: a room. It's a conversation with a
// different base dir."* — so a room's RUNTIME per-being state (threadId /
// threadCreatedAt / identityInjectedAt, and the access_level / allowed_users /
// sandboxed / mode overrides) belongs in THIS file, not in config/conversations.yaml
// (which registers transport-backed conversations). Before this, recordThread →
// patchBeing wrote every surface's block into conversations.yaml, so a room registered
// here grew its thread over there — `radio` carried a live threadId in the OTHER file
// while `dj-son` sat here with only `heartbeats:`.
//
// SHAPE MIRRORS conversations.yaml exactly (*"mirror like… make sure no room is
// special"*): the SAME `agents: { <being>: { … } }` nesting getBeing/patchBeing already
// read and write, hung off the room's `<surface>/<slug>` row:
//
//   rooms:
//     room/radio:
//       agents:
//         egpt:
//           access_level: all
//           allowed_users: ["…"]
//           threadId: 85937f93-…
//
// ONE ROUTING DECISION, AT THE STATE IO BOUNDARY. getBeing/patchBeing/recordThread are
// PURE functions over the in-memory registry state and have a dozen callers between
// them; teaching each one "which file backs this surface" would be the sprinkled
// special case. Instead the two functions below are the read and write halves of a
// single decision, applied in conversations-state.readState/writeState (the ONE pair
// boot.mjs hands to every service): on the way IN a room's `agents:` block is hydrated
// from here, on the way OUT it is persisted here and stripped from what
// conversations.yaml serializes. Every consumer above that line — getBeing, patchBeing,
// recordThread, brainpool's two-tier resolution, /agents — is untouched and cannot tell
// the difference.
//
// MIGRATION IS READ-THROUGH, and it is why the merge is PER BEING rather than a
// whole-block replace: a room whose state still lives in conversations.yaml (today:
// `radio`, `acim`) finds nothing here, keeps the legacy block it was loaded with, and
// therefore keeps its thread — no new session, no lost continuity. The first write that
// touches that room lifts the block into rooms.yaml and drops it from conversations.yaml,
// so the move happens once, on the operator's own data, with no migration step to run.
const ROOM_SURFACE = 'room';
// Byte-identical to ConversationRoom.ns() — computed here off (surface, slug) rather
// than imported, since room-core.mjs imports THIS module.
const roomNs = (slug) => `${ROOM_SURFACE}/${sanitizeSlug(slug)}`;
const _agentsOf = (row) => (isPlainObject(row) && isPlainObject(row.agents)) ? row.agents : null;
const _movable = (entry) => isPlainObject(entry) && !entry.aliasOf && !!entry.slug;

/** The rooms.yaml that sits BESIDE a conversations.yaml — they are config/ siblings. */
export function roomsPathBeside(convYamlPath) {
  return join(dirname(String(convYamlPath ?? '')), 'rooms.yaml');
}

/**
 * READ half: hydrate every `room` entry's `agents:` block from rooms.yaml. A being
 * present here wins over the same being in the loaded state; one that is only in the
 * loaded state (the legacy conversations.yaml block) survives untouched.
 */
export async function mergeRoomBeings(state, deps = {}) {
  const bucket = state?.contacts?.[ROOM_SURFACE];
  if (!isPlainObject(bucket)) return state;
  const rooms = await readRoomsFile(deps);
  let changed = false;
  const next = { ...bucket };
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!_movable(entry)) continue;
    const near = _agentsOf(rooms[roomNs(entry.slug)]);
    if (!near) continue;
    next[jid] = { ...entry, agents: { ...(isPlainObject(entry.agents) ? entry.agents : {}), ...near } };
    changed = true;
  }
  return changed ? { ...state, contacts: { ...state.contacts, [ROOM_SURFACE]: next } } : state;
}

/**
 * WRITE half: persist every `room` entry's `agents:` block into rooms.yaml and return
 * the state MINUS those blocks, which is what conversations.yaml then serializes. Only
 * writes when the row's block actually differs, so an ordinary state write (a pushedName
 * refresh) doesn't churn the operator's file.
 */
export async function persistRoomBeings(state, deps = {}) {
  const bucket = state?.contacts?.[ROOM_SURFACE];
  if (!isPlainObject(bucket)) return state;
  const rooms = await readRoomsFile(deps);
  let changed = false;
  const next = { ...bucket };
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!_movable(entry) || !('agents' in entry)) continue;
    const ns = roomNs(entry.slug);
    const have = _agentsOf(rooms[ns]);
    const want = isPlainObject(entry.agents) && Object.keys(entry.agents).length ? entry.agents : null;
    if (want) {
      if (JSON.stringify(have) !== JSON.stringify(want)) await setRoomConfigBlock(ns, 'agents', want, deps);
    } else if (have) {
      await deleteRoomConfigBlock(ns, 'agents', deps);   // deleteBeing wiped the last resident
    }
    const { agents, ...rest } = entry;
    next[jid] = rest;
    changed = true;
  }
  return changed ? { ...state, contacts: { ...state.contacts, [ROOM_SURFACE]: next } } : state;
}
