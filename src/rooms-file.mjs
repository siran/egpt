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
