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
import { readRoomConfig } from '../src/rooms-file.mjs';
import { parse as parseConversationsYaml } from '../src/conversations-state.mjs';

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

// ── the shell's own conversation is a room too (operator ruling, 2026-08-28) ────────────────
// The shell surface collapses into surface `room`, slug `lobby`: its folder, its
// config/rooms.yaml row (members: incl. a chatgpt-cdp brain), and its config/conversations.yaml
// registry row (agents: egpt/wren threads) move together, in the SAME call, with the SAME
// idempotent / refuse / dry-run guarantees as the room/* folder step above — and all-or-nothing:
// a refused folder move skips BOTH yaml rewrites too, so the config never points at the wrong
// place.
const shellLobby = (...p) => join(root, 'conversations', 'shell', 'lobby', ...p);
const shellOrphan = (...p) => join(root, 'conversations', 'shell', 'shell-2607201416', ...p);
const roomsYamlPath = () => join(root, 'config', 'rooms.yaml');
const convYamlPath = () => join(root, 'config', 'conversations.yaml');

const ROOMS_YAML_FIXTURE = `# operator notes
rooms:
  room/dj-son:
    heartbeats:
      dj: false
  shell/lobby:
    members:
      - adapter: chatgpt-cdp
        id: cdp-main
        state: active
  shell/shell-2607201416:
    heartbeats: {}
  whatsapp/diego-123:
    heartbeats:
      x: true
`;

const CONV_YAML_FIXTURE = `contacts:
  shell:
    main: # console
      conversation_path: .egpt/conversations/shell/lobby
      home_dir: /c/Users/an
      agents:
        egpt:
          threadId: egpt-thread-1
          threadCreatedAt: 2026-07-10T16:39:39.948Z
          access_level: all
        wren:
          threadId: wren-thread-1
  room:
    dj-son: # DJ Son
      conversation_path: .egpt/rooms/dj-son
      home_dir: /c/Users/an
  whatsapp:
    "1234567890":
      conversation_path: .egpt/conversations/whatsapp/diego-2606291919
      home_dir: /c/Users/an
`;

function seedShellLobbyFolder() {
  mkdirSync(shellLobby('identity.d'), { recursive: true });
  writeFileSync(shellLobby('transcript.md'), '# lobby\n');
  writeFileSync(shellLobby('identity.d', '00-identity.md'), 'i am\n');
}
function seedShellOrphanFolder() {
  mkdirSync(shellOrphan(), { recursive: true });
  writeFileSync(shellOrphan('transcript.md'), 'orphan\n');
}
function seedYamlFixtures() {
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(roomsYamlPath(), ROOMS_YAML_FIXTURE);
  writeFileSync(convYamlPath(), CONV_YAML_FIXTURE);
}

describe('move-rooms-out-of-conversations — the shell lobby joins the room tree', () => {
  it('moves conversations/shell/lobby/ to rooms/lobby/, tree intact', async () => {
    seedShellLobbyFolder();
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.lobby.folderMoved).toBe(true);
    expect(res.lobby.folderRefused).toBe(false);
    expect(readFileSync(roomsAt('lobby', 'transcript.md'), 'utf8')).toBe('# lobby\n');
    expect(readFileSync(roomsAt('lobby', 'identity.d', '00-identity.md'), 'utf8')).toBe('i am\n');
    expect(existsSync(shellLobby())).toBe(false);
  });

  it('moves the shell/lobby rooms.yaml row to room/lobby, members intact, via the real reader', async () => {
    seedShellLobbyFolder();
    seedYamlFixtures();
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.lobby.roomsYaml.moved).toBe(true);
    const moved = await readRoomConfig('room/lobby', { path: roomsYamlPath() });
    expect(moved.members).toEqual([{ adapter: 'chatgpt-cdp', id: 'cdp-main', state: 'active' }]);
    const goneRow = await readRoomConfig('shell/lobby', { path: roomsYamlPath() });
    expect(goneRow).toEqual({});
  });

  it('leaves shell/shell-2607201416 — folder and rooms.yaml row — untouched', async () => {
    seedShellLobbyFolder();
    seedShellOrphanFolder();
    seedYamlFixtures();
    await moveRoomsOutOfConversations({ root });
    expect(existsSync(shellOrphan('transcript.md'))).toBe(true);
    expect(readFileSync(shellOrphan('transcript.md'), 'utf8')).toBe('orphan\n');
    const orphanRow = await readRoomConfig('shell/shell-2607201416', { path: roomsYamlPath() });
    expect(orphanRow).toEqual({ heartbeats: {} });
  });

  it('leaves an unrelated room/dj-son row, a whatsapp/... row, and an operator comment intact', async () => {
    seedShellLobbyFolder();
    seedYamlFixtures();
    await moveRoomsOutOfConversations({ root });
    const dj = await readRoomConfig('room/dj-son', { path: roomsYamlPath() });
    expect(dj).toEqual({ heartbeats: { dj: false } });
    const wa = await readRoomConfig('whatsapp/diego-123', { path: roomsYamlPath() });
    expect(wa).toEqual({ heartbeats: { x: true } });
    expect(readFileSync(roomsYamlPath(), 'utf8')).toContain('# operator notes');
  });

  it('moves contacts.shell.main to contacts.room.lobby with slug set and agents intact', async () => {
    seedShellLobbyFolder();
    seedYamlFixtures();
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.lobby.conversationsYaml.moved).toBe(true);
    const parsed = parseConversationsYaml(readFileSync(convYamlPath(), 'utf8'));
    expect(parsed.contacts.shell.main).toBeUndefined();
    const lobby = parsed.contacts.room.lobby;
    expect(lobby.slug).toBe('lobby');
    expect(lobby.agents.egpt.threadId).toBe('egpt-thread-1');
    expect(lobby.agents.wren.threadId).toBe('wren-thread-1');
    expect(parsed.contacts.room['dj-son']).toBeTruthy();
    expect(parsed.contacts.whatsapp['1234567890']).toBeTruthy();
  });

  it('is idempotent for the lobby step too — a second run is a clean no-op', async () => {
    seedShellLobbyFolder();
    seedYamlFixtures();
    await moveRoomsOutOfConversations({ root });
    const roomsYamlAfterFirst = readFileSync(roomsYamlPath(), 'utf8');
    const convYamlAfterFirst = readFileSync(convYamlPath(), 'utf8');
    const again = await moveRoomsOutOfConversations({ root });
    expect(again.lobby.folderMoved).toBe(false);
    expect(again.lobby.roomsYaml.moved).toBe(false);
    expect(again.lobby.conversationsYaml.moved).toBe(false);
    expect(readFileSync(roomsYamlPath(), 'utf8')).toBe(roomsYamlAfterFirst);
    expect(readFileSync(convYamlPath(), 'utf8')).toBe(convYamlAfterFirst);
  });

  it('a half-done previous run (folder already moved, yaml rows still stale) still rewrites the yaml', async () => {
    seedYamlFixtures();
    mkdirSync(roomsAt('lobby', 'identity.d'), { recursive: true });
    writeFileSync(roomsAt('lobby', 'transcript.md'), '# lobby\n');
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.lobby.folderMoved).toBe(false);
    expect(res.lobby.folderRefused).toBe(false);
    expect(res.lobby.roomsYaml.moved).toBe(true);
    expect(res.lobby.conversationsYaml.moved).toBe(true);
    const moved = await readRoomConfig('room/lobby', { path: roomsYamlPath() });
    expect(moved.members?.[0]?.adapter).toBe('chatgpt-cdp');
  });

  it('REFUSES a non-empty rooms/lobby/ — folder AND both yaml rewrites are skipped, all-or-nothing', async () => {
    seedShellLobbyFolder();
    seedYamlFixtures();
    mkdirSync(roomsAt('lobby'), { recursive: true });
    writeFileSync(roomsAt('lobby', 'transcript.md'), 'THE LIVE ONE\n');
    const roomsYamlBefore = readFileSync(roomsYamlPath(), 'utf8');
    const convYamlBefore = readFileSync(convYamlPath(), 'utf8');
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.lobby.folderRefused).toBe(true);
    expect(res.lobby.roomsYaml.moved).toBe(false);
    expect(res.lobby.conversationsYaml.moved).toBe(false);
    expect(readFileSync(roomsAt('lobby', 'transcript.md'), 'utf8')).toBe('THE LIVE ONE\n');
    expect(readFileSync(shellLobby('transcript.md'), 'utf8')).toBe('# lobby\n');
    expect(readFileSync(roomsYamlPath(), 'utf8')).toBe(roomsYamlBefore);
    expect(readFileSync(convYamlPath(), 'utf8')).toBe(convYamlBefore);
  });

  it('--dry-run writes NOTHING for the lobby step (folder + both yaml files byte-identical)', async () => {
    seedShellLobbyFolder();
    seedYamlFixtures();
    const roomsYamlBefore = readFileSync(roomsYamlPath(), 'utf8');
    const convYamlBefore = readFileSync(convYamlPath(), 'utf8');
    const res = await moveRoomsOutOfConversations({ root, dryRun: true });
    expect(res.lobby.folderMoved).toBe(true);
    expect(res.lobby.roomsYaml.moved).toBe(true);
    expect(res.lobby.conversationsYaml.moved).toBe(true);
    expect(existsSync(roomsAt('lobby'))).toBe(false);
    expect(existsSync(shellLobby('transcript.md'))).toBe(true);
    expect(readFileSync(roomsYamlPath(), 'utf8')).toBe(roomsYamlBefore);
    expect(readFileSync(convYamlPath(), 'utf8')).toBe(convYamlBefore);
  });

  it('a profile with no conversations/shell/lobby/ and no shell/lobby row is a no-op', async () => {
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.lobby).toEqual({
      folderMoved: false,
      folderRefused: false,
      roomsYaml: { moved: false, refused: false },
      conversationsYaml: { moved: false, refused: false },
    });
  });

  it('the room/* folder migration still works alongside the lobby step, in one call', async () => {
    seedOldRoom('acim');
    seedShellLobbyFolder();
    seedYamlFixtures();
    const res = await moveRoomsOutOfConversations({ root });
    expect(res.moved).toEqual(['acim']);
    expect(res.lobby.folderMoved).toBe(true);
    expect(readFileSync(roomsAt('acim', 'transcript.md'), 'utf8')).toBe('# acim\n');
    expect(readFileSync(roomsAt('lobby', 'transcript.md'), 'utf8')).toBe('# lobby\n');
  });
});
