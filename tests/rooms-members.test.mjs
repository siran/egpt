// Command Surface Phase 2 — rooms & members core (DATA MODEL + COMMANDS, no relay).
//
// /rooms, /room <slug> join|leave|members (+ /members … = current room), /members add
// tab <n>, /members <id> mode <disable|mention|all>, /activate <id>. Member state is
// the EXISTING room-core roster (config.yaml members[]); the friendly mode words map to
// the existing tokens (disable→muted, mention→mention, all→active). No streamFromTab —
// a brain member is added but stays inert until phase 4.
//
// The room store is exercised for real through room-core against a temp-dir Room
// subclass (round-trip persistence, cleaned up), injected via the roomForName seam so
// nothing touches the live profile. The CDP + adapter seams are faked, so no live
// Chrome and no dynamic import in these tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { Room } from '../src/room-core.mjs';

class TmpRoom extends Room {
  constructor(dir) { super(); this._dir = dir; }
  baseDir() { return this._dir; }
}

const self = { chatId: '!self', surface: 'whatsapp' };

const ADAPTERS = [
  { name: 'chatgpt-cdp', urlMatch: /chatgpt\.com|chat\.openai\.com/, homeUrl: 'https://chatgpt.com/' },
  { name: 'claude-cdp', urlMatch: /claude\.ai/, homeUrl: 'https://claude.ai/new' },
];

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-rmc-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

function harness({ cdp, adapters = ADAPTERS, roomNames = [] } = {}) {
  const sent = [];
  const rooms = new Map();   // name -> TmpRoom (real fs under `base`)
  const roomForName = (name) => {
    if (!rooms.has(name)) rooms.set(name, new TmpRoom(join(base, name)));
    return rooms.get(name);
  };
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    ...(cdp ? { cdp } : {}),
    loadAdapters: async () => adapters,
    roomForName,
    listRoomNames: () => roomNames,
  });
  return { cmds, sent, roomForName };
}

// A three-tab Chrome: 1 chatgpt (adapter match), 2 claude (adapter match), 3 gmail (none).
const threeTabs = [
  { id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' },
  { id: 'CLA2', title: 'Claude', url: 'https://claude.ai/chat/def' },
  { id: 'GML3', title: 'Gmail', url: 'https://mail.google.com/mail/u/0' },
];

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

describe('/room <slug> join + /members list', () => {
  it('/room devwork join sets current; /members lists members with kind + mode + active', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    expect(sent.at(-1).text).toMatch(/join/i);
    await cmds.run({ ...self, body: '/members add tab 1' });   // a chatgpt member (active tab)
    await cmds.run({ ...self, body: '/members' });
    const text = sent.at(-1).text;
    expect(text).toMatch(/chatgpt/);
    expect(text).toMatch(/brain/);          // kind
    expect(text).toMatch(/mode:disable/);   // muted → disable
    expect(text).toMatch(/active/);         // targetId GPT1 is a live tab
  });

  it('/rooms devwork join is an accepted alias of /room devwork join', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/rooms devwork join' });
    await cmds.run({ ...self, body: '/members add tab 1' });   // proves current room = devwork
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
  });

  it('/members with no current room says so (no throw, not the catch-all)', async () => {
    const { cmds, sent } = harness();
    await cmds.run({ ...self, body: '/members' });
    expect(sent[0].text).toMatch(/no current room/i);
    expect(sent[0].text).not.toMatch(/recognized/);
  });
});

describe('/members add tab <n> — adapter-matched, added disabled', () => {
  it('add tab 1 (chatgpt) → member added, mode:disable, active; persisted with adapter/url/targetId', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, roomForName } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    await cmds.run({ ...self, body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    expect(sent.at(-1).text).toMatch(/adapter:chatgpt/);
    expect(sent.at(-1).text).toMatch(/mode:disable/);
    // persisted to the room's config.yaml, extra fields intact
    const m = (await roomForName('devwork').members()).find((x) => x.id === 'chatgpt');
    expect(m).toMatchObject({ kind: 'brain', id: 'chatgpt', state: 'muted', adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1' });
  });

  it('add tab 3 (gmail) → REFUSED, "no adapter matches <host>", nothing persisted', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, roomForName } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    await cmds.run({ ...self, body: '/members add tab 3' });
    expect(sent.at(-1).text).toMatch(/no adapter matches/i);
    expect(sent.at(-1).text).toMatch(/mail\.google\.com/);
    expect(await roomForName('devwork').members()).toEqual([]);
  });

  it('add tab <n> past the end reports it instead of throwing', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    await expect(cmds.run({ ...self, body: '/members add tab 9' })).resolves.toBeUndefined();
    expect(sent.at(-1).text).toMatch(/no tab 9/);
  });
});

describe('/members <id> mode <disable|mention|all>', () => {
  it('mode mention persists (re-read shows mention); mode all → active token', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, roomForName } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt, muted
    await cmds.run({ ...self, body: '/members chatgpt mode mention' });
    expect(sent.at(-1).text).toMatch(/mode:mention/);
    expect(await roomForName('devwork').memberState('chatgpt')).toBe('mention');
    await cmds.run({ ...self, body: '/members chatgpt mode all' });
    expect(await roomForName('devwork').memberState('chatgpt')).toBe('active');   // all → active
    // mode change must NOT clobber the persisted adapter/url/targetId
    const m = (await roomForName('devwork').members()).find((x) => x.id === 'chatgpt');
    expect(m).toMatchObject({ adapter: 'chatgpt-cdp', url: 'https://chatgpt.com/c/abc', targetId: 'GPT1' });
  });

  it('an unknown mode word is rejected; an unknown member id is reported', async () => {
    const cdp = { listTabs: async () => threeTabs };
    const { cmds, sent, roomForName } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    await cmds.run({ ...self, body: '/members add tab 1' });
    await cmds.run({ ...self, body: '/members chatgpt mode loud' });
    expect(sent.at(-1).text).toMatch(/disable\|mention\|all|unknown mode/i);
    expect(await roomForName('devwork').memberState('chatgpt')).toBe('muted');   // unchanged
    await cmds.run({ ...self, body: '/members ghost mode all' });
    expect(sent.at(-1).text).toMatch(/no member/i);
  });
});

describe('/activate <id> — reopen a closed tab', () => {
  it('targetId gone from listTabs → openTab(savedUrl), targetId updated, member active', async () => {
    const opened = [];
    // chatgpt's tab GPT1 is CLOSED: listTabs no longer includes it.
    const cdp = {
      listTabs: async () => threeTabs,   // add-time: GPT1 present
      openTab: async (url) => { opened.push(url); return 'GPT-NEW'; },
    };
    const { cmds, sent, roomForName } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    await cmds.run({ ...self, body: '/members add tab 1' });   // chatgpt @ GPT1
    // now the tab is gone — listTabs returns a set WITHOUT GPT1
    cdp.listTabs = async () => ([{ id: 'OTHER', title: 'x', url: 'https://x' }]);
    await cmds.run({ ...self, body: '/activate chatgpt' });
    expect(opened).toEqual(['https://chatgpt.com/c/abc']);   // reopened the SAVED url
    expect(sent.at(-1).text).toMatch(/active/i);
    // targetId was updated to the freshly-opened tab
    expect((await roomForName('devwork').members()).find((x) => x.id === 'chatgpt').targetId).toBe('GPT-NEW');
  });

  it('an already-live member is not reopened', async () => {
    const opened = [];
    const cdp = { listTabs: async () => threeTabs, openTab: async (url) => { opened.push(url); return 'X'; } };
    const { cmds, sent } = harness({ cdp });
    await cmds.run({ ...self, body: '/room devwork join' });
    await cmds.run({ ...self, body: '/members add tab 1' });   // GPT1 still live
    await cmds.run({ ...self, body: '/activate chatgpt' });
    expect(opened).toEqual([]);                       // nothing reopened
    expect(sent.at(-1).text).toMatch(/already active/i);
  });
});
