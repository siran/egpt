// Command Surface Phase 2 — rooms & members core (DATA MODEL + COMMANDS).
//
// THE MODEL (bug fix 2026-07-23): a conversation IS a room. The /members family (/members,
// /members add tab <n>, /members <id> mode <m>, /activate <id>) operates on the CURRENT
// CONVERSATION's room — the SAME room the phase-4 relay reads its members from — resolved
// through the injected resolveConvRoom seam. There is NO "/room <slug> join first" gate: the
// conversation you're in IS the room. NamedRooms (/rooms, /room create|join|leave, /room <slug>
// members) stay a SEPARATE explicit construct — relay-wiring them is a later phase.
//
// The room store is exercised for real through room-core against temp-dir Room subclasses
// (round-trip persistence, cleaned up), injected via roomForName (NamedRooms) + resolveConvRoom
// (the conversation room) so nothing touches the live profile. The CDP + adapter seams are faked,
// so no live Chrome and no dynamic import in these tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { Room } from '../src/room-core.mjs';
import { seedIdentityLayers } from '../src/conversations-state.mjs';

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
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-rmc-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function harness({ cdp, adapters = ADAPTERS, roomNames = [], config = {} } = {}) {
  const sent = [];
  const rooms = new Map();       // NamedRoom name        -> TmpRoom (real fs under base/named)
  const convRooms = new Map();   // `${surface}:${chatId}` -> TmpRoom (real fs under base/conv)
  const roomForName = (name) => {
    if (!rooms.has(name)) rooms.set(name, new TmpRoom(join(base, 'named', name), name));
    return rooms.get(name);
  };
  // The SHARED conversation-room resolver: the SAME function shape boot injects into BOTH
  // createCommands (write) and the phase-4 relay's resolveMembers (read). A per-(surface,chatId)
  // TmpRoom stands in for conversations/<surface>/<slug>/.
  const resolveConvRoom = async (surface, chatId) => {
    const key = `${surface}:${chatId}`;
    if (!convRooms.has(key)) convRooms.set(key, new TmpRoom(join(base, 'conv', surface, String(chatId)), String(chatId)));
    return convRooms.get(key);
  };
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!conv-1' }, ...config }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    ...(cdp ? { cdp } : {}),
    loadAdapters: async () => adapters,
    roomForName,
    resolveConvRoom,
    listRoomNames: () => roomNames,
  });
  return { cmds, sent, roomForName, resolveConvRoom };
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

describe('/rooms — list NamedRooms, mark current', () => {
  it('lists the scanned rooms with member counts and marks the current one', async () => {
    const { cmds, sent, roomForName } = harness({ roomNames: ['devwork', 'scratch'] });
    await roomForName('scratch').setMember({ kind: 'brain', id: 'e', state: 'active' });
    await roomForName('scratch').setMember({ kind: 'brain', id: 'l', state: 'mention' });
    await cmds.run({ ...self, body: '/rooms devwork join' });   // devwork → current
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
});

// Defect 1 regression lock: an EXISTING room that genuinely has zero members must still
// render its roster ("<slug> (0 members):") — that is a DIFFERENT case from a room that
// doesn't exist on disk at all (locked in spine-commands.test.mjs) and must not regress.
describe('/room <slug> members — a real, genuinely empty room still renders its roster', () => {
  it('a room whose tree exists but has no members renders "(0 members)", not "no room"', async () => {
    const { cmds, sent, roomForName } = harness();
    await roomForName('nobody-yet').ensureTree();
    await cmds.run({ ...self, body: '/room nobody-yet members' });
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
describe('/room <slug> delete — remove a NamedRoom, refusing when it holds real content', () => {
  // Builds a room exactly the way /room create does: the tree + the seeded identity.d/
  // layers — so "still just the skeleton" is tested against the SAME shape the creator
  // produces, not a hand-picked filename list.
  async function freshRoom(roomForName, slug) {
    const room = roomForName(slug);
    await room.ensureTree();
    await seedIdentityLayers(room, 'egpt');
    return room;
  }

  it('a room that is still just the seeded skeleton is deleted outright', async () => {
    const { cmds, sent, roomForName } = harness();
    const room = await freshRoom(roomForName, 'scratch');
    await cmds.run({ ...self, body: '/room scratch delete' });
    expect(sent.at(-1).text).toMatch(/room scratch deleted/);
    expect(existsSync(room.baseDir())).toBe(false);
  });

  it('a room holding a transcript refuses, naming it — "delete force" then removes it', async () => {
    const { cmds, sent, roomForName } = harness();
    const room = await freshRoom(roomForName, 'devwork');
    writeFileSync(room.transcriptPath, '# hi\n', 'utf8');
    await cmds.run({ ...self, body: '/room devwork delete' });
    expect(sent.at(-1).text).toMatch(/transcript\.md/);
    expect(sent.at(-1).text).toMatch(/delete force/);
    expect(existsSync(room.baseDir())).toBe(true);   // refused — NOT removed
    await cmds.run({ ...self, body: '/room devwork delete force' });
    expect(sent.at(-1).text).toMatch(/deleted/);
    expect(existsSync(room.baseDir())).toBe(false);
  });

  it('a room holding files in media/ refuses, naming the count', async () => {
    const { cmds, sent, roomForName } = harness();
    const room = await freshRoom(roomForName, 'withmedia');
    writeFileSync(join(room.mediaDir, 'photo.jpg'), 'x');
    await cmds.run({ ...self, body: '/room withmedia delete' });
    expect(sent.at(-1).text).toMatch(/1 file in media\//);
    expect(existsSync(room.baseDir())).toBe(true);
  });

  it('/room <slug> delete on a room that does not exist reports it (same wording as the "no room" path)', async () => {
    const { cmds, sent } = harness();
    await cmds.run({ ...self, body: '/room ghost delete' });
    expect(sent.at(-1).text).toMatch(/no room 'ghost'/);
  });

  it('deleting the current room clears currentRoom for that surface (no dangling pointer)', async () => {
    const { cmds, sent, roomForName } = harness();
    await freshRoom(roomForName, 'current-one');
    await cmds.run({ ...self, body: '/room current-one join' });
    expect(sent.at(-1).text).toMatch(/joined 'current-one'/);
    await cmds.run({ ...self, body: '/room current-one delete' });
    expect(sent.at(-1).text).toMatch(/deleted/);
    // leave now reports "not in" — the pointer was cleared, not left dangling at a deleted room
    await cmds.run({ ...self, body: '/room current-one leave' });
    expect(sent.at(-1).text).toMatch(/not in 'current-one'/);
  });
});

describe('/members — targets the CURRENT CONVERSATION (no /room join gate)', () => {
  it('/members with no NamedRoom joined lists the conversation members (NOT "no current room")', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/members' });   // never joined a NamedRoom
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

// NamedRooms stay a SEPARATE explicit construct (relay-wiring them is a later phase): /room
// <slug> members inspects the NamedRoom's OWN roster, decoupled from any conversation.
describe('/room <slug> members — NamedRoom inspection (kept, separate from /members)', () => {
  it('lists the NamedRoom roster, not the conversation roster', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, roomForName, resolveConvRoom } = harness({ cdp });
    await roomForName('devwork').setMember({ kind: 'brain', id: 'claude', state: 'mention' });
    // add a member to the CONVERSATION — it must NOT show up under the NamedRoom
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt → conversation room
    await cmds.run({ ...self, body: '/room devwork members' });
    const text = sent.at(-1).text;
    expect(text).toMatch(/devwork/);     // labelled by the NamedRoom
    expect(text).toMatch(/claude/);      // the NamedRoom's own member
    expect(text).not.toMatch(/chatgpt/); // the conversation member is NOT in the NamedRoom
    // and the conversation room really did get chatgpt (the two are separate stores)
    expect((await (await resolveConvRoom(self.surface, self.chatId)).members()).map((m) => m.id)).toEqual(['chatgpt']);
  });
});
