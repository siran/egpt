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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { Room } from '../src/room-core.mjs';

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

function harness({ cdp, adapters = ADAPTERS, roomNames = [] } = {}) {
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
    getConfig: () => ({ whatsapp: { chat_id: '!conv-1' } }),
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
    expect(m).toMatchObject({ kind: 'brain', id: 'chatgpt', state: 'muted', adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1' });
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
