// rooms-file.mjs — config/rooms.yaml and config/agents.yaml, the REGISTRY rung.
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

// ── THE TWO REGISTRIES (operator 2026-09-01) ───────────────────────────────
// ONE mechanism, two files. A registry differs from its sibling in exactly three
// values — the surface it keys, the file it lives in, and that file's root key:
//
//   room  → config/rooms.yaml    rooms:  { "room/<slug>":  {…} }
//   agent → config/agents.yaml   agents: { "agent/<name>": {…} }
//
// The `agent` rung exists because a being can now be pinned node-wide
// (`agents.<being>.scope: <surface>/<chatId>`, src/spine/identity-scope.mjs) and so
// needs ONE conversation every chat resolves to — but wren is not a room:
// *"we can have an agents/ path and an agents.yaml holding the global threads and
// configuration access"*, *"agents/wren/ holds the Room instance from wren as a
// conversation"*. An agent's GLOBAL thread and its access configuration therefore
// live in a row of agents.yaml with the SAME block shape a room's row already has
// (threadId / threadCreatedAt / identityInjectedAt, access_level / allowed_users /
// sandboxed / verbose_thinking / allow_new_input).
//
// FOUR UNRELATED THINGS ARE SPELLED `agents`. Do not merge them:
//   1. config/agents.yaml     — a registry file THIS module owns: per-agent-INSTANCE
//                               rows keyed `agent/<name>`, one row per conversation.
//   2. config/config.yaml's top-level `agents:` — the node's agent REGISTRY: which
//                               beings exist, their handles, type, routing and scope.
//   3. config/agents/*.yaml   — the agent TYPE files (the engine definitions).
//   4. a row's own `agents:`  — the CONTAINER of per-being blocks getBeing/patchBeing
//                               read (see conversations-state.mjs above
//                               CONTACT_BOOKKEEPING_KEYS: *"a genuine collision between
//                               two namespaces, older than the resolver"*).
// (1) and (4) legitimately nest, and agents.yaml reads `agents: → agent/wren: → agents:
// → wren:` because of it. That is the collision showing, not a bug.
const ROOM  = { surface: 'room',  file: 'rooms.yaml',  root: 'rooms'  };
const AGENT = { surface: 'agent', file: 'agents.yaml', root: 'agents' };

// WHICH registry a `<surface>/<slug>` key belongs to. Only `agent/` moves; every other
// surface stays in rooms.yaml exactly as before — including the `shell/…` and
// `whatsapp/…` rows it already carries. Routing off the key itself is what lets
// room-core's loadConfig/_setConfigBlock, which pass nothing but this.ns(), reach the
// right file for an `agent/<name>` Room without knowing either file exists.
const registryOf = (ns) => String(ns ?? '').startsWith(`${AGENT.surface}/`) ? AGENT : ROOM;
const registryPath = ({ file }) => join(process.env.EGPT_HOME || EGPT_HOME, 'config', file);

// Resolved LAZILY, not frozen at module load: a test file that points EGPT_HOME
// at its own private profile must be honoured even though egpt-home.mjs froze
// its constant earlier. One shared rung file means parallel test files would
// otherwise contend on a single path.
export const roomsFilePath = () => registryPath(ROOM);
export const agentsFilePath = () => registryPath(AGENT);
export const ROOMS_FILE = roomsFilePath();
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The whole file as a plain object: { "<surface>/<slug>": {...} }. Never throws. */
export async function readRoomsFile({ reg = ROOM, path = registryPath(reg), read = readFile } = {}) {
  let doc;
  try { doc = YAML.parse(await read(path, 'utf8')); } catch { return {}; }
  if (!isPlainObject(doc)) return {};
  // Tolerate both the wrapped shape (rooms: / agents:) and a bare top-level map.
  const rooms = isPlainObject(doc[reg.root]) ? doc[reg.root] : doc;
  return isPlainObject(rooms) ? rooms : {};
}

/** One room's (or agent's) config block. `{}` when the row (or the file) is absent. */
export async function readRoomConfig(ns, deps = {}) {
  const all = await readRoomsFile({ reg: registryOf(ns), ...deps });
  const row = all[String(ns ?? '')];
  return isPlainObject(row) ? row : {};
}

/**
 * Set ONE top-level block for ONE room, preserving every other row and the
 * operator's comments. Creates the file (and config/) when absent.
 */
export async function setRoomConfigBlock(ns, key, value, { reg = registryOf(ns), path = registryPath(reg), read = readFile, write = writeFile, ensureDir = mkdir } = {}) {
  await ensureDir(dirname(path), { recursive: true });
  let text = '';
  try { text = await read(path, 'utf8'); } catch { /* new file */ }
  const doc = YAML.parseDocument(text || `${reg.root}:\n`);
  if (doc.get(reg.root) == null) doc.set(reg.root, doc.createNode({}));
  doc.setIn([reg.root, String(ns), key], value);
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
export async function setRoomConfigKey(ns, dottedKey, value, { reg = registryOf(ns), path = registryPath(reg), read = readFile, write = writeFile, ensureDir = mkdir } = {}) {
  await ensureDir(dirname(path), { recursive: true });
  let text = '';
  try { text = await read(path, 'utf8'); } catch { /* new file */ }
  const doc = YAML.parseDocument(text || `${reg.root}:\n`);
  if (doc.get(reg.root) == null) doc.set(reg.root, doc.createNode({}));
  doc.setIn([reg.root, String(ns), ...String(dottedKey).split('.')], value);
  await write(path, String(doc), 'utf8');
}

/** Drop one room's whole row (used when a room is deleted). */
export async function removeRoomRow(ns, { reg = registryOf(ns), path = registryPath(reg), read = readFile, write = writeFile } = {}) {
  let text = '';
  try { text = await read(path, 'utf8'); } catch { return; }
  const doc = YAML.parseDocument(text || '');
  doc.deleteIn([reg.root, String(ns)]);
  await write(path, String(doc), 'utf8');
}

/** Drop ONE block from one room's row, leaving the row and its siblings alone. */
export async function deleteRoomConfigBlock(ns, key, { reg = registryOf(ns), path = registryPath(reg), read = readFile, write = writeFile } = {}) {
  let text = '';
  try { text = await read(path, 'utf8'); } catch { return; }
  const doc = YAML.parseDocument(text || '');
  // Both shapes readRoomsFile tolerates: the wrapped `rooms:` map and a bare top-level one.
  const gone = doc.deleteIn([reg.root, String(ns), key]) || doc.deleteIn([String(ns), key]);
  if (!gone) return;
  await write(path, String(doc), 'utf8');
}

// ── THE RUNG'S PER-BEING STATE (operator 2026-08-26) ────────────────────────
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
// The `agent` surface is the same two halves over the AGENT registry, nothing else
// (operator 2026-09-01) — `agents: { agent/wren: { agents: { wren: { threadId: … } } } }`
// in config/agents.yaml, so a globally pinned being's thread and access configuration
// sit in the file named for it rather than in a room row it does not belong to.
//
// ONE ROUTING DECISION, AT THE STATE IO BOUNDARY. getBeing/patchBeing/recordThread are
// PURE functions over the in-memory registry state and have a dozen callers between
// them; teaching each one "which file backs this surface" would be the sprinkled
// special case. Instead the two functions below are the read and write halves of a
// single decision, applied in conversations-state.readState/writeState (the ONE pair
// boot.mjs hands to every service) once per registry: on the way IN an entry's `agents:`
// block is hydrated from here, on the way OUT it is persisted here and stripped from what
// conversations.yaml serializes. Every consumer above that line — getBeing, patchBeing,
// recordThread, brainpool's two-tier resolution, /agents — is untouched and cannot tell
// the difference.
//
// MIGRATION IS READ-THROUGH, and it is why the merge is PER BEING rather than a
// whole-block replace: an entry whose state still lives in conversations.yaml (today:
// `radio`, `acim`, and every `agent/` row until its first write) finds nothing here, keeps
// the legacy block it was loaded with, and therefore keeps its thread — no new session, no
// lost continuity. The first write that touches that entry lifts the block into its
// registry file and drops it from conversations.yaml, so the move happens once, on the
// operator's own data, with no migration step to run.
//
// Byte-identical to ConversationRoom.ns() — computed here off (surface, slug) rather
// than imported, since room-core.mjs imports THIS module.
const nsOf = (reg, slug) => `${reg.surface}/${sanitizeSlug(slug)}`;
const _agentsOf = (row) => (isPlainObject(row) && isPlainObject(row.agents)) ? row.agents : null;
const _movable = (entry) => isPlainObject(entry) && !entry.aliasOf && !!entry.slug;

/** The registry file that sits BESIDE a conversations.yaml — they are config/ siblings. */
const pathBeside = (convYamlPath, reg) => join(dirname(String(convYamlPath ?? '')), reg.file);
export const roomsPathBeside = (convYamlPath) => pathBeside(convYamlPath, ROOM);
export const agentsPathBeside = (convYamlPath) => pathBeside(convYamlPath, AGENT);

/**
 * READ half: hydrate every entry of ONE registry's surface with its `agents:` block from
 * that registry's file. A being present there wins over the same being in the loaded
 * state; one that is only in the loaded state (the legacy conversations.yaml block)
 * survives untouched.
 */
async function mergeBeings(state, reg, deps) {
  const bucket = state?.contacts?.[reg.surface];
  if (!isPlainObject(bucket)) return state;
  const rooms = await readRoomsFile({ reg, ...deps });
  let changed = false;
  const next = { ...bucket };
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!_movable(entry)) continue;
    const near = _agentsOf(rooms[nsOf(reg, entry.slug)]);
    if (!near) continue;
    next[jid] = { ...entry, agents: { ...(isPlainObject(entry.agents) ? entry.agents : {}), ...near } };
    changed = true;
  }
  return changed ? { ...state, contacts: { ...state.contacts, [reg.surface]: next } } : state;
}

/**
 * WRITE half: persist every entry of ONE registry's surface into that registry's file and
 * return the state MINUS those blocks, which is what conversations.yaml then serializes.
 * Only writes when the row's block actually differs, so an ordinary state write (a
 * pushedName refresh) doesn't churn the operator's file.
 */
async function persistBeings(state, reg, deps) {
  const bucket = state?.contacts?.[reg.surface];
  if (!isPlainObject(bucket)) return state;
  const rooms = await readRoomsFile({ reg, ...deps });
  let changed = false;
  const next = { ...bucket };
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!_movable(entry) || !('agents' in entry)) continue;
    const ns = nsOf(reg, entry.slug);
    const have = _agentsOf(rooms[ns]);
    const want = isPlainObject(entry.agents) && Object.keys(entry.agents).length ? entry.agents : null;
    if (want) {
      if (JSON.stringify(have) !== JSON.stringify(want)) await setRoomConfigBlock(ns, 'agents', want, { reg, ...deps });
    } else if (have) {
      await deleteRoomConfigBlock(ns, 'agents', { reg, ...deps });   // deleteBeing wiped the last resident
    }
    const { agents, ...rest } = entry;
    next[jid] = rest;
    changed = true;
  }
  return changed ? { ...state, contacts: { ...state.contacts, [reg.surface]: next } } : state;
}

export const mergeRoomBeings    = (state, deps = {}) => mergeBeings(state, ROOM, deps);
export const mergeAgentBeings   = (state, deps = {}) => mergeBeings(state, AGENT, deps);
export const persistRoomBeings  = (state, deps = {}) => persistBeings(state, ROOM, deps);
export const persistAgentBeings = (state, deps = {}) => persistBeings(state, AGENT, deps);
