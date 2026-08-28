// move-rooms-out-of-conversations.mjs — ONE-SHOT: move each operator-named room's folder
// out of the Beeper tree.
//
//   EGPT_HOME/conversations/room/<slug>/   ->   EGPT_HOME/rooms/<slug>/
//
// Operator 2026-08-28: *"voice, instagram, telegram, whatsapp, matrix is all under beeper,
// only rooms is not. under that logic, rooms does belong outside conversations."* A room is
// still a conversation on surface `room` — same chatId, same members, same tree, same
// namespace `room/<slug>` — so config/rooms.yaml is NOT touched: every key stays
// byte-identical and there is nothing to migrate in it. Only the folder moves.
//
// SAFE BY CONSTRUCTION:
//   · idempotent — an already-moved profile (no conversations/room/) is a no-op;
//   · never overwrites — a destination that has content is REFUSED and both sides are left
//     exactly as they are (an empty destination folder is not an obstacle);
//   · --dry-run writes NOTHING and prints the same report.
//
// Usage:  node setup/move-rooms-out-of-conversations.mjs [--dry-run]
// Run it with the daemon STOPPED (a live spine holds a room's transcript open).
import { pathToFileURL } from 'node:url';
import { readdir, mkdir, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONVERSATIONS_ROOT, ROOMS_ROOT } from '../src/room-core.mjs';

/**
 * Move every conversations/room/<slug>/ to rooms/<slug>/.
 * `root` defaults to the live profile's two roots (room-core's surface→root map) and is
 * overridden wholesale in tests, which point BOTH sides at a temp dir.
 * Returns { moved: [slug], refused: [slug], dryRun, from, to }.
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
    const dest = join(to, slug);
    let destEntries = null;
    try { destEntries = await readdir(dest); } catch { /* absent → free */ }
    if (destEntries && destEntries.length) { refused.push(slug); continue; }
    if (dryRun) { moved.push(slug); continue; }
    await mkdir(to, { recursive: true });
    if (destEntries) await rmdir(dest);            // an EMPTY leftover would block rename()
    await rename(join(from, slug), dest);
    moved.push(slug);
  }
  // Leave no empty conversations/room/ behind, so the Beeper tree holds only Beeper surfaces
  // and a re-run finds nothing. rmdir refuses a non-empty dir, which is exactly the guard
  // wanted when something was refused above (and ENOENT when there was never one).
  if (!dryRun) { try { await rmdir(from); } catch { /* refusals still inside, or never existed */ } }

  return { moved, refused, dryRun, from, to };
}

async function main({ dryRun = false } = {}) {
  const res = await moveRoomsOutOfConversations({ dryRun });
  const tag = dryRun ? '[dry-run] ' : '';
  console.log(`${tag}move-rooms-out-of-conversations: ${res.from} -> ${res.to}`);
  if (!res.moved.length && !res.refused.length) console.log(`${tag}  nothing to move (already out of conversations/, or no rooms)`);
  for (const slug of res.moved) console.log(`${tag}  ${dryRun ? 'would move' : 'moved'}: ${slug}`);
  for (const slug of res.refused) console.log(`${tag}  REFUSED (destination already has content): ${slug} — resolve by hand`);
  return res;
}

// Run only when invoked directly (so the export imports cleanly in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ dryRun: process.argv.includes('--dry-run') });
}

export { main };
