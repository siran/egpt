// move-rooms-out-of-conversations.mjs — ONE-SHOT: move each operator-named room's folder
// out of the Beeper tree, and fold the shell's own conversation into the room tree too.
//
//   EGPT_HOME/conversations/room/<slug>/   ->   EGPT_HOME/rooms/<slug>/
//   EGPT_HOME/conversations/shell/lobby/   ->   EGPT_HOME/rooms/lobby/
//
// Operator 2026-08-28: *"voice, instagram, telegram, whatsapp, matrix is all under beeper,
// only rooms is not. under that logic, rooms does belong outside conversations."* A room is
// still a conversation on surface `room` — same chatId, same members, same tree, same
// namespace `room/<slug>` — so config/rooms.yaml is NOT touched for an operator-named room:
// every key stays byte-identical and there is nothing to migrate in it. Only the folder moves.
//
// New ruling (same day): the shell's own conversation is a room too — surface `shell`,
// jid `main` collapses into surface `room`, slug `lobby`. Unlike an operator-named room, that
// IS a namespace change (`shell/lobby` -> `room/lobby`), so for the lobby ALONE this script also
// moves its config/rooms.yaml row (whole block, incl. members:) and its config/conversations.yaml
// registry row (`contacts.shell.main` -> `contacts.room.lobby`, agents: intact, slug: lobby set).
//
// SAFE BY CONSTRUCTION:
//   · idempotent — an already-moved profile (no conversations/room/, no conversations/shell/
//     lobby/, no stale yaml keys) is a no-op; each part re-runs cleanly on its own;
//   · never overwrites — a destination that has content is REFUSED and both sides are left
//     exactly as they are (an empty destination folder is not an obstacle);
//   · the lobby step is ALL-OR-NOTHING on its folder move: rooms/lobby/ already having content
//     REFUSES the folder move AND skips both yaml rewrites, so the config never points at the
//     wrong place;
//   · --dry-run writes NOTHING and prints the same report.
//
// Usage:  node setup/move-rooms-out-of-conversations.mjs [--dry-run]
// Run it with the daemon STOPPED (a live spine holds a room's transcript open).
import { pathToFileURL } from 'node:url';
import { readdir, mkdir, rename, rmdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { CONVERSATIONS_ROOT, ROOMS_ROOT } from '../src/room-core.mjs';
import { roomsFilePath } from '../src/rooms-file.mjs';
import { CONV_YAML_PATH } from '../src/conversations-state.mjs';

const LOBBY_SLUG = 'lobby';

// Move `src` -> `dest` unless `dest` already has content (refused) or `dryRun` (reported only).
// Returns 'moved' | 'refused' | 'absent' (src doesn't exist — already moved / never existed).
async function moveDirIfFree(src, dest, dryRun) {
  try { await readdir(src); } catch { return 'absent'; }
  let destEntries = null;
  try { destEntries = await readdir(dest); } catch { /* absent → free */ }
  if (destEntries && destEntries.length) return 'refused';
  if (dryRun) return 'moved';
  await mkdir(dirname(dest), { recursive: true });
  if (destEntries) await rmdir(dest);            // an EMPTY leftover would block rename()
  await rename(src, dest);
  return 'moved';
}

// Move ONE row, keyed by a flat `<surface>/<slug>` string (never a nested path — see
// rooms-file.mjs), from `src` to `dest` inside a YAML Document, preserving comments and every
// sibling row. Returns 'moved' | 'refused' (dest already exists) | 'absent' (no file, or no
// src row — already moved / never existed). Writes nothing when dryRun or when there is
// nothing to move.
async function moveYamlRow(path, srcKey, destKeyPath, dryRun, { base = [], afterMove } = {}) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return 'absent'; }
  const doc = YAML.parseDocument(text);
  const src = [...base, srcKey];
  if (!doc.hasIn(src)) return 'absent';
  if (doc.hasIn(destKeyPath)) return 'refused';
  if (dryRun) return 'moved';
  doc.setIn(destKeyPath, doc.getIn(src, true));
  doc.deleteIn(src);
  if (afterMove) afterMove(doc);
  await writeFile(path, String(doc), 'utf8');
  return 'moved';
}

/**
 * Move every conversations/room/<slug>/ to rooms/<slug>/, AND fold the shell's own
 * conversation into the room tree too (operator ruling: the shell surface collapses into
 * surface `room`, slug `lobby`) — its folder, its config/rooms.yaml row (`shell/lobby` ->
 * `room/lobby`, whole block incl. members:), and its config/conversations.yaml registry row
 * (`contacts.shell.main` -> `contacts.room.lobby`, with slug: lobby set).
 * `root` defaults to the live profile's roots/files and is overridden wholesale in tests,
 * which point everything at a temp dir.
 * The lobby step is ALL-OR-NOTHING on its folder move: a refused folder (rooms/lobby/
 * already has content) skips both yaml rewrites too, so the config never points at the
 * wrong place. Each of its three parts (folder, rooms.yaml row, conversations.yaml row) is
 * otherwise independently idempotent.
 * Returns { moved: [slug], refused: [slug], dryRun, from, to, lobby }, where lobby is
 * { folderMoved, folderRefused, roomsYaml: {moved, refused}, conversationsYaml: {moved, refused} }.
 */
export async function moveRoomsOutOfConversations({ root = null, dryRun = false } = {}) {
  const from = root ? join(root, 'conversations', 'room') : join(CONVERSATIONS_ROOT, 'room');
  const to = root ? join(root, 'rooms') : ROOMS_ROOT;
  const moved = [];
  const refused = [];

  let ents = [];
  try { ents = await readdir(from, { withFileTypes: true }); } catch { ents = []; }   // already moved / never existed
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const result = await moveDirIfFree(join(from, slug), join(to, slug), dryRun);
    if (result === 'refused') refused.push(slug);
    else if (result === 'moved') moved.push(slug);
  }
  // Leave no empty conversations/room/ behind, so the Beeper tree holds only Beeper surfaces
  // and a re-run finds nothing. rmdir refuses a non-empty dir, which is exactly the guard
  // wanted when something was refused above (and ENOENT when there was never one).
  if (!dryRun) { try { await rmdir(from); } catch { /* refusals still inside, or never existed */ } }

  // ── the shell's own lobby joins the room tree ─────────────────────────────
  const shellLobbyFrom = root ? join(root, 'conversations', 'shell', LOBBY_SLUG) : join(CONVERSATIONS_ROOT, 'shell', LOBBY_SLUG);
  const roomsYamlPath = root ? join(root, 'config', 'rooms.yaml') : roomsFilePath();
  const convYamlPath = root ? join(root, 'config', 'conversations.yaml') : CONV_YAML_PATH;

  const folderResult = await moveDirIfFree(shellLobbyFrom, join(to, LOBBY_SLUG), dryRun);
  const lobby = {
    folderMoved: folderResult === 'moved',
    folderRefused: folderResult === 'refused',
    roomsYaml: { moved: false, refused: false },
    conversationsYaml: { moved: false, refused: false },
  };
  if (folderResult !== 'refused') {
    // rooms.yaml tolerates both a wrapped `rooms:` map and a bare top-level map (readRoomsFile).
    const roomsDoc = await readFile(roomsYamlPath, 'utf8').then(YAML.parseDocument).catch(() => null);
    const roomsBase = roomsDoc && YAML.isMap(roomsDoc.get('rooms')) ? ['rooms'] : [];
    const r1 = await moveYamlRow(roomsYamlPath, 'shell/lobby', [...roomsBase, 'room/lobby'], dryRun, { base: roomsBase });
    lobby.roomsYaml = { moved: r1 === 'moved', refused: r1 === 'refused' };

    const r2 = await moveYamlRow(convYamlPath, 'main', ['contacts', 'room', LOBBY_SLUG], dryRun, {
      base: ['contacts', 'shell'],
      afterMove: (doc) => doc.setIn(['contacts', 'room', LOBBY_SLUG, 'slug'], LOBBY_SLUG),
    });
    lobby.conversationsYaml = { moved: r2 === 'moved', refused: r2 === 'refused' };
  }

  return { moved, refused, dryRun, from, to, lobby };
}

async function main({ dryRun = false } = {}) {
  const res = await moveRoomsOutOfConversations({ dryRun });
  const tag = dryRun ? '[dry-run] ' : '';
  console.log(`${tag}move-rooms-out-of-conversations: ${res.from} -> ${res.to}`);
  if (!res.moved.length && !res.refused.length) console.log(`${tag}  nothing to move (already out of conversations/, or no rooms)`);
  for (const slug of res.moved) console.log(`${tag}  ${dryRun ? 'would move' : 'moved'}: ${slug}`);
  for (const slug of res.refused) console.log(`${tag}  REFUSED (destination already has content): ${slug} — resolve by hand`);
  const { lobby } = res;
  const verb = dryRun ? 'would move' : 'moved';
  if (lobby.folderMoved) console.log(`${tag}  ${verb}: shell/lobby folder -> room/lobby`);
  if (lobby.folderRefused) console.log(`${tag}  REFUSED (rooms/lobby/ already has content): shell/lobby folder — resolve by hand (yaml left untouched)`);
  if (lobby.roomsYaml.moved) console.log(`${tag}  ${verb}: rooms.yaml row shell/lobby -> room/lobby`);
  if (lobby.roomsYaml.refused) console.log(`${tag}  REFUSED (room/lobby row already exists): rooms.yaml shell/lobby — resolve by hand`);
  if (lobby.conversationsYaml.moved) console.log(`${tag}  ${verb}: conversations.yaml row contacts.shell.main -> contacts.room.lobby`);
  if (lobby.conversationsYaml.refused) console.log(`${tag}  REFUSED (contacts.room.lobby already exists): conversations.yaml contacts.shell.main — resolve by hand`);
  return res;
}

// Run only when invoked directly (so the export imports cleanly in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ dryRun: process.argv.includes('--dry-run') });
}

export { main };
