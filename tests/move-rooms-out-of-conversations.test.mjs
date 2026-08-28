// move-rooms-out-of-conversations.test.mjs — the ONE-SHOT folder migration
// (setup/move-rooms-out-of-conversations.mjs) that follows the operator's 2026-08-28 ruling:
// conversations/ is the BEEPER tree, so an operator-named room's folder moves
// conversations/room/<slug>/ → rooms/<slug>/.
//
// Everything here runs against a TEMP profile root — the script is never pointed at a real
// ~/.egpt from a test. It must be re-runnable (an already-moved profile is a no-op), must
// REFUSE rather than overwrite a destination that has content, and --dry-run must write
// nothing at all.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveRoomsOutOfConversations } from '../setup/move-rooms-out-of-conversations.mjs';

let root;
const convRoom = (...p) => join(root, 'conversations', 'room', ...p);
const roomsAt = (...p) => join(root, 'rooms', ...p);

// A room in the OLD place, with the tree a live room carries.
function seedOldRoom(name) {
  mkdirSync(convRoom(name, 'identity.d'), { recursive: true });
  mkdirSync(convRoom(name, 'media'), { recursive: true });
  writeFileSync(convRoom(name, 'transcript.md'), `# ${name}\n`);
  writeFileSync(convRoom(name, 'identity.d', '00-identity.md'), 'i am\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egpt-move-rooms-'));
  mkdirSync(join(root, 'conversations', 'whatsapp', 'diego'), { recursive: true });
  writeFileSync(join(root, 'conversations', 'whatsapp', 'diego', 'transcript.md'), 'hi\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('move-rooms-out-of-conversations', () => {
  it('moves each conversations/room/<slug>/ to rooms/<slug>/ with its tree intact', async () => {
    seedOldRoom('acim');
    seedOldRoom('dj-son');
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.moved.sort()).toEqual(['acim', 'dj-son']);
    expect(res.refused).toEqual([]);
    expect(readFileSync(roomsAt('acim', 'transcript.md'), 'utf8')).toBe('# acim\n');
    expect(readFileSync(roomsAt('acim', 'identity.d', '00-identity.md'), 'utf8')).toBe('i am\n');
    expect(existsSync(roomsAt('dj-son', 'media'))).toBe(true);
    expect(existsSync(convRoom('acim'))).toBe(false);
    // the emptied conversations/room/ itself is cleaned up, so a re-run has nothing to see
    expect(existsSync(join(root, 'conversations', 'room'))).toBe(false);
  });

  it('leaves every other surface alone', async () => {
    seedOldRoom('acim');
    await moveRoomsOutOfConversations({ root });
    expect(readFileSync(join(root, 'conversations', 'whatsapp', 'diego', 'transcript.md'), 'utf8')).toBe('hi\n');
  });

  it('is idempotent — a second run is a no-op, and so is an already-moved profile', async () => {
    seedOldRoom('acim');
    await moveRoomsOutOfConversations({ root });
    const again = await moveRoomsOutOfConversations({ root });
    expect(again.moved).toEqual([]);
    expect(again.refused).toEqual([]);
    expect(readFileSync(roomsAt('acim', 'transcript.md'), 'utf8')).toBe('# acim\n');
  });

  it('a profile that never had conversations/room/ is a no-op and creates nothing', async () => {
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.moved).toEqual([]);
    expect(existsSync(join(root, 'rooms'))).toBe(false);
  });

  it('REFUSES a destination that already has content — never overwrites', async () => {
    seedOldRoom('acim');
    mkdirSync(roomsAt('acim'), { recursive: true });
    writeFileSync(roomsAt('acim', 'transcript.md'), 'THE LIVE ONE\n');
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.moved).toEqual([]);
    expect(res.refused).toEqual(['acim']);
    expect(readFileSync(roomsAt('acim', 'transcript.md'), 'utf8')).toBe('THE LIVE ONE\n');   // untouched
    expect(readFileSync(convRoom('acim', 'transcript.md'), 'utf8')).toBe('# acim\n');        // source kept
  });

  it('an EMPTY destination folder is not an obstacle', async () => {
    seedOldRoom('acim');
    mkdirSync(roomsAt('acim'), { recursive: true });
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.moved).toEqual(['acim']);
    expect(readFileSync(roomsAt('acim', 'transcript.md'), 'utf8')).toBe('# acim\n');
  });

  it('--dry-run writes NOTHING', async () => {
    seedOldRoom('acim');
    seedOldRoom('dj-son');
    const before = readdirSync(convRoom());
    const res = await moveRoomsOutOfConversations({ root, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.moved.sort()).toEqual(['acim', 'dj-son']);          // what it WOULD move
    expect(existsSync(join(root, 'rooms'))).toBe(false);           // nothing created
    expect(readdirSync(convRoom()).sort()).toEqual(before.sort()); // nothing removed
    expect(readFileSync(convRoom('acim', 'transcript.md'), 'utf8')).toBe('# acim\n');
  });

  it('--dry-run reports a refusal without touching either side', async () => {
    seedOldRoom('acim');
    mkdirSync(roomsAt('acim'), { recursive: true });
    writeFileSync(roomsAt('acim', 'transcript.md'), 'THE LIVE ONE\n');
    const res = await moveRoomsOutOfConversations({ root, dryRun: true });
    expect(res.moved).toEqual([]);
    expect(res.refused).toEqual(['acim']);
    expect(readFileSync(roomsAt('acim', 'transcript.md'), 'utf8')).toBe('THE LIVE ONE\n');
    expect(readFileSync(convRoom('acim', 'transcript.md'), 'utf8')).toBe('# acim\n');
  });
});
