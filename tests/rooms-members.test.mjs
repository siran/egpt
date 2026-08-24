// Command Surface Phase 2 — rooms & members core (DATA MODEL + COMMANDS).
//
// THE MODEL (bug fix 2026-07-23): a conversation IS a room. The /members family (/members,
// /members add tab <n>, /members <id> mode <m>, /activate <id>) operates on the CURRENT
// CONVERSATION's room — the SAME room the phase-4 relay reads its members from — resolved
// through the injected resolveConvRoom seam. There is NO "/room <slug> join first" gate: the
// conversation you're in IS the room.
//
// 2026-08-09: an operator-named room is no longer a second KIND. /rooms + /room
// create|join|leave|members|delete address a conversation on surface `room` whose chatId is
// the name itself, resolved through the SAME resolveConvRoom seam — there is no roomForName.
// It stays a separately ADDRESSED construct (you name it instead of being in it), not a
// separate implementation.
//
// The room store is exercised for real through room-core against temp-dir Room subclasses
// (round-trip persistence, cleaned up), injected via resolveConvRoom, so nothing touches the
// live profile. The CDP + adapter seams are faked, so no live Chrome and no dynamic import in
// these tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// A PRIVATE profile for this file. The room READ verbs resolve their slug purely (no seam,
// by design — a read must not mint), so the rooms below are real folders under EGPT_HOME,
// and `/room delete`'s skeleton comparison reads the profile's identity layers. The suite's
// SHARED throwaway profile (tests/setup-egpt-home.mjs) is written by other files IN PARALLEL
// — seedSkeletons lands config/skeletons/room/* mid-run — so seeding a room and then asking
// "is it still just the skeleton?" against it raced ~1 in 3. egpt-home.mjs freezes EGPT_HOME
// at module load, so this must run BEFORE the imports below: vi.hoisted is what does that.
// Verified by the beforeEach tripwire, which fails loudly rather than racing again.
// (os/path are not importable here — a hoisted block runs before the imports it precedes —
// so the temp root comes from the env, which is what os.tmpdir() reads anyway.)
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-rooms-members-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { createCommands } from '../src/spine/commands.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { sanitizeName } from '../src/sanitize.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { emptyState, seedIdentityLayers } from '../src/conversations-state.mjs';
import { ROOMS_FILE } from '../src/rooms-file.mjs';
import { rmSync as _rmRooms } from 'node:fs';

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

const self = { chatId: '!conv-1', surface: 'whatsapp' };

const ADAPTERS = [
  { name: 'chatgpt-cdp', urlMatch: /chatgpt\.com|chat\.openai\.com/, homeUrl: 'https://chatgpt.com/' },
  { name: 'claude-cdp', urlMatch: /claude\.ai/, homeUrl: 'https://claude.ai/new' },
];

let base;
// Every conversations/room/<slug>/ this file materialised, removed after each test. The room
// READ verbs (/room members, /room delete) and /rooms resolve the slug PURELY — no seam, by
// design (a read must not mint a contact) — so those rooms are real folders under the suite's
// isolated EGPT_HOME. Same tripwire tests/beeper-bridge.test.mjs uses: never the live ~/.egpt.
let roomDirs;
beforeEach(() => {
  // The ROOM RUNG is now ONE shared file — wipe it so rows never leak between cases.
  try { _rmRooms(ROOMS_FILE, { force: true }); } catch { /* none yet */ }
  // THE TRIPWIRE. If vi.hoisted above ever stops running before the imports, EGPT_HOME is
  // the shared profile again and these tests race — fail here instead, loudly.
  expect(join(EGPT_HOME), 'EGPT_HOME must be THIS file\'s private profile — see the vi.hoisted block').toBe(join(TEST_HOME));
  expect(EGPT_HOME).not.toBe(join(homedir(), '.egpt'));
  base = mkdtempSync(join(tmpdir(), 'egpt-rmc-'));
  roomDirs = [];
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  for (const d of roomDirs) rmSync(d, { recursive: true, force: true });
});

// The room called <name>, at the path production resolves it to: fixedSlugFor makes a room's
// slug sanitizeName(<name>), so this is the SAME folder /room create writes and the read verbs
// stat. Registered for cleanup.
function roomAt(name) {
  const room = Room.forChat('room', sanitizeName(name));
  roomDirs.push(room.baseDir());
  return room;
}

function harness({ cdp, adapters = ADAPTERS, roomNames = [], config = {} } = {}) {
  const sent = [];
  const convRooms = new Map();   // `${surface}:${chatId}` -> TmpRoom (real fs under base/conv)
  // The SHARED conversation-room resolver: the SAME function shape boot injects into BOTH
  // createCommands (write) and the phase-4 relay's resolveMembers (read). A per-(surface,chatId)
  // TmpRoom stands in for conversations/<surface>/<slug>/.
  // Surface `room` is NOT faked: its slug is a pure function of the name (fixedSlugFor), and
  // the read verbs stat that real path, so the resolver must agree with them or a create and
  // a read would land in two different folders — the very split this chunk removed.
  const resolveConvRoom = async (surface, chatId) => {
    if (surface === 'room') return roomAt(chatId);
    const key = `${surface}:${chatId}`;
    if (!convRooms.has(key)) convRooms.set(key, new TmpRoom(join(base, 'conv', surface, String(chatId)), String(chatId)));
    return convRooms.get(key);
  };
  // The named room called <name> — the SAME resolution `/room <verb> <name>` performs.
  const namedRoom = (name) => resolveConvRoom('room', name);
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!conv-1' }, ...config }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    ...(cdp ? { cdp } : {}),
    loadAdapters: async () => adapters,
    resolveConvRoom,
    listRoomNames: () => roomNames,
  });
  return { cmds, sent, namedRoom, resolveConvRoom };
}

// A three-tab Chrome: 1 chatgpt (adapter match), 2 claude (adapter match), 3 gmail (none).
const threeTabs = [
  { id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
  { id: 'CLA2', title: 'Claude', url: 'https://claude.ai/chat/def' },
  { id: 'GML3', title: 'Gmail', url: 'https://mail.google.com/mail/u/0' },
];

// ─────────────────────────────────────────────────────────────────────────────
// THE CONNECTION TEST (the important one): /members WRITE == relay READ.
// A brain member added through the /members add tab code path for conversation (surface,
// chatId) is returned by a relay-style resolveMembers(surface, chatId) that uses the SAME
// resolveConvRoom — i.e. BOTH resolve to the identical room/config.yaml. This FAILED before
// the fix (members → NamedRoom, relay → ConversationRoom, two different files → @chatgpt no-op).
describe('CONNECTION — a member added via /members is found by the relay for the SAME conversation', () => {
  it('/members add tab 1 → resolveMembers(surface, chatId) returns that member (same room)', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });

    // Operator, IN conversation !conv-1, adds the chatgpt tab as a member — no /room join.
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);

    // The relay reads members the SAME way boot wires it: resolveConvRoom(surface, chatId).members().
    const relayResolveMembers = async (surface, chatId) => {
      const room = await resolveConvRoom(surface, chatId);
      return room ? await room.members() : [];
    };
    const seen = await relayResolveMembers(self.surface, self.chatId);
    const chatgpt = seen.find((m) => m.id === 'chatgpt');
    expect(chatgpt).toBeTruthy();
    expect(chatgpt).toMatchObject({ kind: 'brain', adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1' });

    // A member added for a DIFFERENT conversation is NOT seen here (per-conversation isolation).
    const other = await relayResolveMembers('whatsapp', '!other');
    expect(other).toEqual([]);
  });
});

// /rooms enumerates FOLDERS (listRoomNames yields slugs under conversations/room/), so each
// listed name is turned into a Room by the plain (surface, slug) constructor — resolving a
// folder name as if it were a chatId would mint a contact per room on every /rooms.
describe('/rooms — list rooms, mark current', () => {
  it('lists the scanned rooms with member counts and marks the current one', async () => {
    const { cmds, sent } = harness({ roomNames: ['devwork', 'scratch'] });
    const scratch = roomAt('scratch');
    await scratch.setMember({ kind: 'brain', id: 'e', state: 'active' });
    await scratch.setMember({ kind: 'brain', id: 'l', state: 'mention' });
    await cmds.run({ ...self, body: '/rooms join devwork' });   // devwork → current
    await cmds.run({ ...self, body: '/rooms' });
    const text = sent.at(-1).text;
    expect(text).toMatch(/devwork/);
    expect(text).toMatch(/scratch/);
    expect(text).toMatch(/2 member/);        // scratch has 2 members
    expect(text).toMatch(/current/);         // the current room is marked
    expect(text).not.toMatch(/recognized/);  // NOT the unwired catch-all
  });

  it('/rooms with no saved rooms says so (never throws)', async () => {
    const { cmds, sent } = harness({ roomNames: [] });
    await cmds.run({ ...self, body: '/rooms' });
    expect(sent[0].text).toMatch(/no rooms/i);
  });

  // THE ROUND TRIP (operator's ruling 2026-08-09). /rooms prints FOLDER names; a room's
  // folder name is its typed name (fixedSlugFor, no -yymmddhhmm tail), so the string /rooms
  // prints must go straight back into /room members. With a tailed slug this fails: /rooms
  // would print `acim-2608091345` and typing that back answers "no room".
  it('the name /rooms prints is the name /room members accepts (no tail, typeable round trip)', async () => {
    const room = roomAt('acim');
    await room.setMember({ kind: 'brain', id: 'claude', state: 'mention' });
    const { cmds, sent } = harness({ roomNames: ['acim'] });

    await cmds.run({ ...self, body: '/rooms' });
    const listed = /·\s+(\S+)/.exec(sent.at(-1).text)?.[1];
    expect(listed).toBe('acim');                       // the printed name, verbatim
    expect(listed).not.toMatch(/-\d{10}$/);            // no date tail

    await cmds.run({ ...self, body: `/room members ${listed}` });
    expect(sent.at(-1).text).toMatch(/acim \(1 members\)/);
    expect(sent.at(-1).text).toMatch(/claude/);        // it really read THAT room
    expect(sent.at(-1).text).not.toMatch(/no room/);
  });

  // …and the (current) marker matches the listed name again: /room join stores the typed
  // name, /rooms lists the folder name, and after the ruling those are one string.
  it('/room join acim then /rooms marks acim (current)', async () => {
    roomAt('acim');
    const { cmds, sent } = harness({ roomNames: ['acim'] });
    await cmds.run({ ...self, body: '/room join acim' });
    await cmds.run({ ...self, body: '/rooms' });
    expect(sent.at(-1).text).toMatch(/·\s+acim\s+\d+ members\s+\(current\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MINTING BOUNDARY (operator's ruling 2026-08-09). A room's slug is a PURE FUNCTION of
// its name (fixedSlugFor, surface `room`), so a READ verb resolves it without conv-state and
// must leave conv-state untouched — `/room members <typo>` may not deposit a contact for a
// room that does not exist. `/room create` is the ONE room path that mints, and that is where
// the entry belongs. Run against the REAL contacts service over in-memory state, wired
// exactly as src/spine/boot.mjs does, so this exercises ensureContact for real.
describe('a room READ never mints — /room create is the only room path that writes conv-state', () => {
  function stateHarness() {
    let st = emptyState();
    const writes = [];
    const contacts = createContacts({ loadState: async () => st, writeState: async (s) => { writes.push(s); st = s; } });
    // Verbatim boot.mjs's resolveConvRoom.
    const resolveConvRoom = async (surface, chatId) => {
      const slug = await contacts.resolve(surface, chatId);
      return slug ? Room.forChat(surface, slug) : null;
    };
    const sent = [];
    const cmds = createCommands({
      getConfig: () => ({ whatsapp: { chat_id: '!conv-1' } }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      cdp: { listTabs: async () => [] },
      resolveConvRoom, listRoomNames: () => [],
    });
    return { cmds, sent, writes, snapshot: () => JSON.stringify(st), rooms: () => st.contacts?.room ?? {} };
  }

  for (const verb of ['members', 'delete']) {
    it(`/room ${verb} <nonexistent> reports "no room" and leaves conv-state byte-identical`, async () => {
      const { cmds, sent, writes, snapshot } = stateHarness();
      const before = snapshot();
      await cmds.run({ ...self, body: `/room ${verb} ghost` });
      expect(sent.at(-1).text).toMatch(/no room 'ghost'/);
      expect(snapshot()).toBe(before);   // nothing minted for a room that does not exist
      expect(writes).toEqual([]);        // and nothing was even written
    });
  }

  // THE RULING'S WHOLE PURPOSE: the folder name IS the chatId IS the typed name.
  it('/room create acim lands at conversations/room/acim/ — no -yymmddhhmm tail', async () => {
    const { cmds, sent, rooms } = stateHarness();
    const room = roomAt('acim');   // registers the real dir for cleanup
    await cmds.run({ ...self, body: '/room create acim' });
    expect(sent.at(-1).text).toBe('room acim created at conversations/room/acim/');
    expect(existsSync(room.baseDir())).toBe(true);
    // the contact was minted, under the typed name, with an untailed slug
    expect(rooms().acim?.slug).toBe('acim');
    expect(rooms().acim?.slug).not.toMatch(/-\d{10}$/);
  });

  // Finding (c), closed by the ruling: sanitizeName is the slug rule now, so case and
  // punctuation fold to ONE room instead of creating a second one.
  it('/room create Foo then /room members foo reach the SAME room', async () => {
    const { cmds, sent, rooms } = stateHarness();
    roomAt('Foo');
    await cmds.run({ ...self, body: '/room create Foo' });
    expect(sent.at(-1).text).toMatch(/room foo created at conversations\/room\/foo\//);
    await cmds.run({ ...self, body: '/room members foo' });
    expect(sent.at(-1).text).toMatch(/foo \(0 members\)/);
    expect(sent.at(-1).text).not.toMatch(/no room/);
    expect(Object.keys(rooms())).toEqual(['Foo']);   // ONE entry, keyed by the typed chatId
  });
});

// Defect 1 regression lock: an EXISTING room that genuinely has zero members must still
// render its roster ("<slug> (0 members):") — that is a DIFFERENT case from a room that
// doesn't exist on disk at all (locked in spine-commands.test.mjs) and must not regress.
describe('/room <slug> members — a real, genuinely empty room still renders its roster', () => {
  it('a room whose tree exists but has no members renders "(0 members)", not "no room"', async () => {
    const { cmds, sent, namedRoom } = harness();
    await (await namedRoom('nobody-yet')).ensureTree();
    await cmds.run({ ...self, body: '/room members nobody-yet' });
    expect(sent.at(-1).text).toMatch(/nobody-yet \(0 members\)/);
    expect(sent.at(-1).text).not.toMatch(/no room/);
  });
});

// Defect 2 (live incident 2026-08-07): create/join/leave/members was the whole vocabulary —
// there was no way to remove a NamedRoom short of deleting the folder by hand. /room <slug>
// delete fills that gap: a room that's STILL JUST the seeded skeleton (the empty tree plus
// identity.d/'s seeded layers — exactly what /room create + seedIdentityLayers leave behind)
// is removed outright; a room holding anything more REFUSES and names what's there, requiring
// an explicit `delete force` to proceed.
describe('/room <slug> delete — remove a room, refusing when it holds real content', () => {
  // Builds a room exactly the way /room create does: the tree + the seeded identity.d/
  // layers — so "still just the skeleton" is tested against the SAME shape the creator
  // produces, not a hand-picked filename list.
  async function freshRoom(namedRoom, slug) {
    const room = await namedRoom(slug);
    await room.ensureTree();
    await seedIdentityLayers(room, 'egpt');
    return room;
  }

  it('a room that is still just the seeded skeleton is deleted outright', async () => {
    const { cmds, sent, namedRoom } = harness();
    const room = await freshRoom(namedRoom, 'scratch');
    await cmds.run({ ...self, body: '/room delete scratch' });
    expect(sent.at(-1).text).toMatch(/room scratch deleted/);
    expect(existsSync(room.baseDir())).toBe(false);
  });

  it('a room holding a transcript refuses, naming it — "delete force" then removes it', async () => {
    const { cmds, sent, namedRoom } = harness();
    const room = await freshRoom(namedRoom, 'devwork');
    writeFileSync(room.transcriptPath, '# hi\n', 'utf8');
    await cmds.run({ ...self, body: '/room delete devwork' });
    expect(sent.at(-1).text).toMatch(/transcript\.md/);
    expect(sent.at(-1).text).toMatch(/delete force/);
    expect(existsSync(room.baseDir())).toBe(true);   // refused — NOT removed
    await cmds.run({ ...self, body: '/room delete force devwork' });
    expect(sent.at(-1).text).toMatch(/deleted/);
    expect(existsSync(room.baseDir())).toBe(false);
  });

  it('a room holding files in media/ refuses, naming the count', async () => {
    const { cmds, sent, namedRoom } = harness();
    const room = await freshRoom(namedRoom, 'withmedia');
    writeFileSync(join(room.mediaDir, 'photo.jpg'), 'x');
    await cmds.run({ ...self, body: '/room delete withmedia' });
    expect(sent.at(-1).text).toMatch(/1 file in media\//);
    expect(existsSync(room.baseDir())).toBe(true);
  });

  it('/room <slug> delete on a room that does not exist reports it (same wording as the "no room" path)', async () => {
    const { cmds, sent } = harness();
    await cmds.run({ ...self, body: '/room delete ghost' });
    expect(sent.at(-1).text).toMatch(/no room 'ghost'/);
  });

  it('deleting the current room clears currentRoom for that surface (no dangling pointer)', async () => {
    const { cmds, sent, namedRoom } = harness();
    await freshRoom(namedRoom, 'current-one');
    await cmds.run({ ...self, body: '/room join current-one' });
    expect(sent.at(-1).text).toMatch(/joined 'current-one'/);
    await cmds.run({ ...self, body: '/room delete current-one' });
    expect(sent.at(-1).text).toMatch(/deleted/);
    // leave now reports "not in" — the pointer was cleared, not left dangling at a deleted room
    await cmds.run({ ...self, body: '/room leave current-one' });
    expect(sent.at(-1).text).toMatch(/not in 'current-one'/);
  });
});

describe('/members — targets the CURRENT CONVERSATION (no /room join gate)', () => {
  it('/members with no named room joined lists the conversation members (NOT "no current room")', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/members' });   // never joined a named room
    const text = sent.at(-1).text;
    expect(text).not.toMatch(/no current room/i);    // the dropped gate
    expect(text).not.toMatch(/recognized/);          // not the catch-all
    expect(text).toMatch(/0 members|no members/i);   // the conversation's (empty) roster
  });

  it('/members lists the members after one is added — no /room join anywhere', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });   // a chatgpt member (active tab)
    await cmds.run({ ...self, body: '/members' });
    const text = sent.at(-1).text;
    expect(text).toMatch(/chatgpt/);
    expect(text).toMatch(/brain/);          // kind
    expect(text).toMatch(/mode:disable/);   // muted → disable
    expect(text).toMatch(/active/);         // targetId GPT1 is a live tab
  });
});

describe('/members add tab <n> — adapter-matched, added disabled, in the conversation room', () => {
  it('add tab 1 (chatgpt) → member added, mode:disable, active; persisted with adapter/url/targetId', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    expect(sent.at(-1).text).toMatch(/adapter:chatgpt/);
    expect(sent.at(-1).text).toMatch(/mode:disable/);
    // persisted to the CONVERSATION's config.yaml, extra fields intact
    const m = (await (await resolveConvRoom(self.surface, self.chatId)).members()).find((x) => x.id === 'chatgpt');
    expect(m).toMatchObject({ kind: 'brain', id: 'chatgpt', state: 'muted', adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1', title: 'ChatGPT' });
  });

  it('/members lists a brain member MULTILINE — its url + captured tab title on their own indented lines', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt tab, title 'ChatGPT'
    await cmds.run({ ...self, body: '/members' });
    const text = sent.at(-1).text;
    expect(text).toMatch(/chatgpt\s+brain/);                    // the id/kind summary line stays (multiline, not replaced)
    expect(text).toMatch(/url:\s+https:\/\/chatgpt\.com\/c\/abc/);
    expect(text).toMatch(/title:\s+ChatGPT/);
  });

  it('add tab 3 (gmail) → REFUSED, "no adapter matches <host>", nothing persisted', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 3' });
    expect(sent.at(-1).text).toMatch(/no adapter matches/i);
    expect(sent.at(-1).text).toMatch(/mail\.google\.com/);
    expect(await (await resolveConvRoom(self.surface, self.chatId)).members()).toEqual([]);
  });

  it('add tab <n> past the end reports it instead of throwing', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await expect(cmds.run({ ...self, body: '/members add tab 9' })).resolves.toBeUndefined();
    expect(sent.at(-1).text).toMatch(/no tab 9/);
  });

  // Bug fix 2026-07-24: the id was derived from the ADAPTER name alone, so two chatgpt.com
  // tabs both minted id 'chatgpt' and the second setMember() SILENTLY OVERWROTE the first.
  it('two DIFFERENT chatgpt.com tabs → two DISTINCT members, chatgpt + chatgpt-2 (no collision)', async () => {
    const twoChatgptTabs = [
      { id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/aaa' },
      { id: 'GPT2', title: 'ChatGPT', url: 'https://chatgpt.com/c/bbb' },
    ];
    const cdp = { listTabs: async () => twoChatgptTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    await cmds.run({ ...self, body: '/members add tab 2' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt-2'/);

    const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
    expect(ms.map((m) => m.id).sort()).toEqual(['chatgpt', 'chatgpt-2']);
    const a = ms.find((m) => m.id === 'chatgpt');
    const b = ms.find((m) => m.id === 'chatgpt-2');
    expect(a).toMatchObject({ url: 'https://chatgpt.com/c/aaa', targetId: 'GPT1' });
    expect(b).toMatchObject({ url: 'https://chatgpt.com/c/bbb', targetId: 'GPT2' });
  });

  it('re-adding the SAME tab url refreshes the existing member in place — no chatgpt-2 spawned', async () => {
    const cdp = { listTabs: async () => ([{ id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/aaa' }]) };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt @ GPT1
    // the SAME conversation reopens as a NEW targetId (tab closed/reopened), url unchanged
    cdp.listTabs = async () => ([{ id: 'GPT1-NEW', title: 'ChatGPT', url: 'https://chatgpt.com/c/aaa' }]);
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/refreshed 'chatgpt'/);

    const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
    expect(ms.map((m) => m.id)).toEqual(['chatgpt']);   // still ONE member, no chatgpt-2
    expect(ms[0].targetId).toBe('GPT1-NEW');            // refreshed
    expect(ms[0].state).toBe('muted');                  // its existing mode preserved
  });

  // Operator ruling 2026-07-27: an explicit alias — `alias=<name>` or a bare trailing word —
  // names the member id directly instead of the adapter-derived auto-suffix.
  describe('/members add tab <n> alias=<name> | <name> — an explicit alias', () => {
    it('alias=cgpt3 names the member "cgpt3" instead of "chatgpt"', async () => {
      const cdp = { listTabs: async () => threeTabs };
      const { cmds, sent, resolveConvRoom } = harness({ cdp });
      await cmds.run({ ...self, body: '/members add tab 1 alias=cgpt3' });
      expect(sent.at(-1).text).toMatch(/added 'cgpt3'/);
      const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
      expect(ms.map((m) => m.id)).toEqual(['cgpt3']);
    });

    it('a bare trailing word is the SAME explicit alias, no "alias=" prefix required', async () => {
      const cdp = { listTabs: async () => threeTabs };
      const { cmds, sent, resolveConvRoom } = harness({ cdp });
      await cmds.run({ ...self, body: '/members add tab 1 cgpt3' });
      expect(sent.at(-1).text).toMatch(/added 'cgpt3'/);
      const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
      expect(ms.map((m) => m.id)).toEqual(['cgpt3']);
    });

    // REPRODUCE-FIRST: an explicit alias already taken in this room REFUSES — it must NOT
    // silently fall back to the chatgpt-2 auto-suffix the way a no-alias add would.
    it('REPRODUCE-FIRST: an explicit alias already taken in this room REFUSES, no auto-suffix', async () => {
      const cdp = { listTabs: async () => threeTabs };
      const { cmds, sent, resolveConvRoom } = harness({ cdp });
      await cmds.run({ ...self, body: '/members add tab 1 alias=cgpt3' });   // takes 'cgpt3'
      await cmds.run({ ...self, body: '/members add tab 2 alias=cgpt3' });   // claude tab, SAME alias
      expect(sent.at(-1).text).toMatch(/can't add tab 2/);
      expect(sent.at(-1).text).toMatch(/'cgpt3'/);
      expect(sent.at(-1).text).toMatch(/already taken/);
      const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
      expect(ms.map((m) => m.id)).toEqual(['cgpt3']);   // unchanged — no second member, no cgpt3-2
    });

    // REPRODUCE-FIRST (live bug 2026-07-27): re-adding the SAME tab url with an explicit
    // alias that DISAGREES with the existing member's real id must REFUSE, not silently
    // rename — a member id is @mention-able and appears in transcript history. Before the
    // fix this said "refreshed 'chatgpt'" with zero indication the alias 'c1' was ignored.
    it("REPRODUCE-FIRST: re-adding the same tab url with a DIFFERING alias REFUSES, no silent rename", async () => {
      const cdp = { listTabs: async () => threeTabs };
      const { cmds, sent, resolveConvRoom } = harness({ cdp });
      await cmds.run({ ...self, body: '/members add tab 1' });        // chatgpt @ GPT1
      await cmds.run({ ...self, body: '/members add tab 1 c1' });     // same tab, alias 'c1'
      expect(sent.at(-1).text).not.toMatch(/refreshed 'chatgpt'/);
      expect(sent.at(-1).text).toMatch(/'chatgpt'/);                  // names the real existing id
      expect(sent.at(-1).text).toMatch(/'c1'/);                       // and the rejected alias
      const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
      expect(ms.map((m) => m.id)).toEqual(['chatgpt']);                // unchanged — never renamed to c1
    });

    // an alias equal to the existing id is a no-op rename — harmless, refreshes as before.
    it('re-adding the same tab url with an alias EQUAL to the existing id still refreshes exactly as before', async () => {
      const cdp = { listTabs: async () => threeTabs };
      const { cmds, sent, resolveConvRoom } = harness({ cdp });
      await cmds.run({ ...self, body: '/members add tab 1' });          // chatgpt @ GPT1
      await cmds.run({ ...self, body: '/members add tab 1 chatgpt' });  // same alias as existing id
      expect(sent.at(-1).text).toMatch(/refreshed 'chatgpt'/);
      const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
      expect(ms.map((m) => m.id)).toEqual(['chatgpt']);
    });

    // REGRESSION LOCK: with NO alias given, the existing lowest-free-integer auto-suffix is
    // untouched (covered above at "two DIFFERENT chatgpt.com tabs…", unmodified by this ruling).
    it('no alias given still auto-suffixes exactly as before', async () => {
      const twoChatgptTabs = [
        { id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/aaa' },
        { id: 'GPT2', title: 'ChatGPT', url: 'https://chatgpt.com/c/bbb' },
      ];
      const cdp = { listTabs: async () => twoChatgptTabs };
      const { cmds, sent, resolveConvRoom } = harness({ cdp });
      await cmds.run({ ...self, body: '/members add tab 1' });
      await cmds.run({ ...self, body: '/members add tab 2' });
      expect(sent.at(-1).text).toMatch(/added 'chatgpt-2'/);
      const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
      expect(ms.map((m) => m.id).sort()).toEqual(['chatgpt', 'chatgpt-2']);
    });
  });

  it('/member add tab 1 (singular alias) routes to the same members handler', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/member add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    expect(sent.at(-1).text).not.toMatch(/recognized/);   // not the unwired catch-all
    const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
    expect(ms.map((m) => m.id)).toEqual(['chatgpt']);
  });
});

describe('/members <id> mode <disable|mention|all>', () => {
  it('mode mention persists (re-read shows mention); mode all → active token', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt, muted
    await cmds.run({ ...self, body: '/members chatgpt mode mention' });
    expect(sent.at(-1).text).toMatch(/mode:mention/);
    expect(await (await resolveConvRoom(self.surface, self.chatId)).memberState('chatgpt')).toBe('mention');
    await cmds.run({ ...self, body: '/members chatgpt mode all' });
    expect(await (await resolveConvRoom(self.surface, self.chatId)).memberState('chatgpt')).toBe('active');   // all → active
    // mode change must NOT clobber the persisted adapter/url/targetId
    const m = (await (await resolveConvRoom(self.surface, self.chatId)).members()).find((x) => x.id === 'chatgpt');
    expect(m).toMatchObject({ adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1' });
  });

  it('an unknown mode word is rejected; an unknown member id is reported', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });
    await cmds.run({ ...self, body: '/members chatgpt mode loud' });
    expect(sent.at(-1).text).toMatch(/disable\|mention\|all|unknown mode/i);
    expect(await (await resolveConvRoom(self.surface, self.chatId)).memberState('chatgpt')).toBe('muted');   // unchanged
    await cmds.run({ ...self, body: '/members ghost mode all' });
    expect(sent.at(-1).text).toMatch(/no member/i);
  });
});

describe('/members remove <id>', () => {
  it('removes an existing member and confirms it', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt
    await cmds.run({ ...self, body: '/members remove chatgpt' });
    expect(sent.at(-1).text).toMatch(/removed 'chatgpt'/);
    const ms = await (await resolveConvRoom(self.surface, self.chatId)).members();
    expect(ms.map((m) => m.id)).toEqual([]);
  });

  it('an unknown id reports "no member" — mirrors the mode sub-verb\'s wording — and never throws', async () => {
    const { cmds, sent } = harness({});
    await expect(cmds.run({ ...self, body: '/members remove ghost' })).resolves.toBeUndefined();
    expect(sent.at(-1).text).toMatch(/no member 'ghost' in this conversation/);
  });
});

describe('/members usage line', () => {
  it('mentions every accepted form: add, alias, remove, mode', async () => {
    const { cmds, sent } = harness({});
    await cmds.run({ ...self, body: '/members bogus' });   // matches none of the sub-grammars
    const text = sent.at(-1).text;
    expect(text).toMatch(/usage:/);
    expect(text).toMatch(/add tab/);
    expect(text).toMatch(/alias/);
    expect(text).toMatch(/remove/);
    expect(text).toMatch(/mode/);
  });
});

// C3 (HANDOFF 2026-07-26): /members joined the node-addressable set, so a node token is
// stripped by the ONE shared gate (commands.mjs) before /members' own sub-grammar parses.
// `=<name>` bound to the COMMAND TOKEN (operator ruling 2026-07-27, revised same day: the
// first cut let "node=<name>" float anywhere in the arguments, and that's what let `/tabs=do`
// fall through to the catch-all live — see commands.mjs's NODE_ADDRESSABLE comment) replaced
// the old floating parse. The three things that must hold together: a peer's name silences us,
// OUR name runs here, and the existing sub-grammar (`add tab <n>`, `<id> mode <m>`, bare) is
// untouched.
describe('/members <node> — the shared node gate, with the sub-grammar intact', () => {
  const NODES = { node_name: 'kg', account_peers: ['kg', 'do'] };

  it('REPRODUCE-FIRST: /members=do (a peer, not us) answers NOTHING AT ALL', async () => {
    const { cmds, sent } = harness({ config: NODES });
    await cmds.run({ ...self, body: '/members=do' });
    expect(sent).toEqual([]);
  });

  it('/members=kg (OUR node) strips the token and lists, exactly like bare /members', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp, config: NODES });
    await cmds.run({ ...self, body: '/members add tab 1' });
    await cmds.run({ ...self, body: '/members' });
    const bare = sent.at(-1).text;
    await cmds.run({ ...self, body: '/members=kg' });
    expect(sent.at(-1).text).toBe(bare);
    expect(sent.at(-1).text).not.toMatch(/usage:/);
  });

  it('the sub-grammar is unchanged with nodes configured — add tab <n> and <id> mode <m>', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp, config: NODES });
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    await cmds.run({ ...self, body: '/members chatgpt mode mention' });
    expect(sent.at(-1).text).toMatch(/mode:mention/);
    expect(await (await resolveConvRoom(self.surface, self.chatId)).memberState('chatgpt')).toBe('mention');
  });
});

describe('/activate <id> — reopen a closed tab (in the conversation room)', () => {
  it('targetId gone from listTabs → openTab(savedUrl), targetId updated, member active', async () => {
    const opened = [];
    // chatgpt's tab GPT1 is CLOSED after add: listTabs no longer includes it.
    const cdp = {
      listTabs: async () => threeTabs,   // add-time: GPT1 present
      openTab: async (url) => { opened.push(url); return 'GPT-NEW'; },
    };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt @ GPT1
    // now the tab is gone — listTabs returns a set WITHOUT GPT1
    cdp.listTabs = async () => ([{ id: 'OTHER', title: 'x', url: 'https://x' }]);
    await cmds.run({ ...self, body: '/activate chatgpt' });
    expect(opened).toEqual(['https://chatgpt.com/c/abc']);   // reopened the SAVED url
    expect(sent.at(-1).text).toMatch(/active/i);
    // targetId was updated to the freshly-opened tab
    expect((await (await resolveConvRoom(self.surface, self.chatId)).members()).find((x) => x.id === 'chatgpt').targetId).toBe('GPT-NEW');
  });

  it('an already-live member is not reopened', async () => {
    const opened = [];
    const cdp = { listTabs: async () => threeTabs, openTab: async (url) => { opened.push(url); return 'X'; } };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });   // GPT1 still live
    await cmds.run({ ...self, body: '/activate chatgpt' });
    expect(opened).toEqual([]);                       // nothing reopened
    expect(sent.at(-1).text).toMatch(/already active/i);
  });
});

// convRoomOf's joined-room default (operator 2026-08-17): "this conversation" now means the
// room currently /room join'd on this surface, when one is joined — the SAME default
// redirectShellToRoom already applies to prose and /agents already applied to itself
// (2026-08-16), generalized to the ONE shared resolver every room-scoped command (/members,
// /activate, /radio join|leave|say, the r-quickreply) funnels through. No room joined →
// unchanged native-chat behavior.
describe("/members and /activate default to the CURRENTLY JOINED room (convRoomOf generalization)", () => {
  it('/room join <slug> then a bare /members add tab lands in the JOINED room, not the caller\'s own native chat', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/room join devwork' });
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);

    const joined = await resolveConvRoom('room', 'devwork');
    expect((await joined.members()).find((m) => m.id === 'chatgpt')).toBeTruthy();

    const native = await resolveConvRoom(self.surface, self.chatId);
    expect((await native.members()).find((m) => m.id === 'chatgpt')).toBeFalsy();
  });

  it("regression: no room joined — /members still targets the caller's own native chat (unchanged)", async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    const native = await resolveConvRoom(self.surface, self.chatId);
    expect((await native.members()).find((m) => m.id === 'chatgpt')).toBeTruthy();
  });

  it('/room join <slug> then /activate reopens the JOINED room\'s member, not one in the native chat', async () => {
    const opened = [];
    const cdp = {
      listTabs: async () => threeTabs,   // add-time: GPT1 present
      openTab: async (url) => { opened.push(url); return 'GPT-NEW'; },
    };
    const { cmds, sent, resolveConvRoom } = harness({ cdp });
    await cmds.run({ ...self, body: '/room join devwork' });
    await cmds.run({ ...self, body: '/members add tab 1' });   // added into 'devwork', not !conv-1
    cdp.listTabs = async () => ([{ id: 'OTHER', title: 'x', url: 'https://x' }]);   // GPT1 closed
    await cmds.run({ ...self, body: '/activate chatgpt' });
    expect(opened).toEqual(['https://chatgpt.com/c/abc']);
    expect(sent.at(-1).text).toMatch(/active/i);
    const joined = await resolveConvRoom('room', 'devwork');
    expect((await joined.members()).find((m) => m.id === 'chatgpt').targetId).toBe('GPT-NEW');
  });

  it("regression: no room joined — /activate still targets the caller's own native chat (unchanged)", async () => {
    const opened = [];
    const cdp = {
      listTabs: async () => threeTabs,
      openTab: async (url) => { opened.push(url); return 'GPT-NEW'; },
    };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/members add tab 1' });
    cdp.listTabs = async () => ([{ id: 'OTHER', title: 'x', url: 'https://x' }]);
    await cmds.run({ ...self, body: '/activate chatgpt' });
    expect(opened).toEqual(['https://chatgpt.com/c/abc']);
    expect(sent.at(-1).text).toMatch(/active/i);
  });
});

// An operator-named room stays a SEPARATELY ADDRESSED construct: /room <slug> members
// inspects THAT room's own roster, decoupled from whatever conversation you type it in.
describe('/room <slug> members — named-room inspection (kept, separate from /members)', () => {
  it('lists the named room roster, not the conversation roster', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, namedRoom, resolveConvRoom } = harness({ cdp });
    await (await namedRoom('devwork')).setMember({ kind: 'brain', id: 'claude', state: 'mention' });
    // add a member to the CONVERSATION — it must NOT show up under the named room
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt → conversation room
    await cmds.run({ ...self, body: '/room members devwork' });
    const text = sent.at(-1).text;
    expect(text).toMatch(/devwork/);     // labelled by the named room
    expect(text).toMatch(/claude/);      // the named room's own member
    expect(text).not.toMatch(/chatgpt/); // the conversation member is NOT in the named room
    // and the conversation room really did get chatgpt (the two are separate stores)
    expect((await (await resolveConvRoom(self.surface, self.chatId)).members()).map((m) => m.id)).toEqual(['chatgpt']);
  });
});
