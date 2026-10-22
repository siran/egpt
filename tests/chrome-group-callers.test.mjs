// tests/chrome-group-callers.test.mjs — every SPINE-side browser caller drives ITS chat's browser-group
// Chrome (plans/2610091931 rev 2026-10-11, chunk 2). One resolver: commands.browserConversationOf
// (registry row → chromeConversationOf against browsers.yaml). brain → brain's pipe Chrome;
// unlisted → the `shared` pipe Chrome; ambiguous → no browser + one log line; conversation-less → brain.
// NO REAL CHROME: each group's Chrome is a fake child over two PassThroughs (tests/fake-pipe-chrome.mjs).
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCommands, CHROME_BRAIN_PROFILE, loginProfilePathOf } from '../src/spine/commands.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';
import { createBeingLink } from '../src/spine/being-link.mjs';
import { chatIdForEntity } from '../src/spine/boot.mjs';
import { dropContact } from '../src/conversations-state.mjs';
import { fakePipeChrome } from './fake-pipe-chrome.mjs';

const MB = 1024 * 1024;
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const STATE = {
  contacts: {
    whatsapp: {
      '!admin': { slug: 'eGPT Admin-2609121344', conversation_path: '.egpt/conversations/whatsapp/eGPT Admin-2609121344' },
      '!reinie': { slug: 'Reinie Alvino-2607150057', conversation_path: '.egpt/conversations/whatsapp/Reinie Alvino-2607150057' },
      '!dup': { slug: 'Twice-2601010000', conversation_path: '.egpt/conversations/whatsapp/Twice-2601010000' },
    },
    room: { acim: { conversation_path: '.egpt/rooms/acim' } },
  },
};
const GROUPS = { brain: ['eGPT Admin', 'eGPT Rodz Lulu An', 'acim', 'tpoef'], work: ['Twice'] , other: ['Twice'] };

function build({ state = STATE, groups = GROUPS, requestLogin, ...seams } = {}) {
  const logs = [], sent = [], brainCloses = [], brainOpens = [];
  const brain = {
    listTabs: async () => [{ id: 'B1', title: 'Gmail', url: 'https://mail.google.com/' }],
    closeTab: async (id) => { brainCloses.push(id); },
    openTab: async (url) => { brainOpens.push(url); return 'B9'; },
  };
  const pipe = { listTabs: async () => [{ id: 'P1', url: 'https://pipe.example/', title: 'PipeTab' }] };
  const { chromeHost, calls } = fakePipeChrome((o) => (o.profileDir === CHROME_BRAIN_PROFILE ? brain : pipe));
  let t = 0;
  const cmds = createCommands({
    getConfig: () => ({ node_name: 'kg', agents: { e: {} }, whatsapp: { chat_id: '!admin' } }),
    chromeHost,
    profileHolder: () => null,
    freeMem: () => 8192 * MB,
    rssOf: () => null,
    onChromeLog: (m) => logs.push(m),
    browserGroups: async () => groups,
    loadState: state ? async () => state : null,
    writeState: async () => {},
    now: () => (t += 1),
    sleep: async () => {},
    send: async (chatId, text) => sent.push({ chatId, text }),
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
    ...(requestLogin ? { requestLogin } : {}),
    ...seams,
  });
  return { cmds, calls, logs, sent, brainCloses, brainOpens };
}

const sharedDir = join(dirname(CHROME_BRAIN_PROFILE), 'shared');
const run = (cmds, chatId, body) => cmds.run({ chatId, surface: 'whatsapp', authorized: true, body });

describe('browserConversationOf — THE resolver every browser caller routes through', () => {
  it('a chat → its registry row → its group; unlisted → shared; listed twice → null + why', async () => {
    const { cmds } = build();
    expect(await cmds.browserConversationOf('whatsapp', '!admin')).toEqual({ key: 'eGPT Admin-2609121344', name: 'eGPT Admin', group: 'brain' });
    expect((await cmds.browserConversationOf('whatsapp', '!reinie')).group).toBe('shared');
    const dup = await cmds.browserConversationOf('whatsapp', '!dup');
    expect(dup.group).toBe(null);
    expect(dup.why).toMatch(/work, other/);
  });

  it('a ROOM is listed by its rooms.yaml slug: its row (conversation_path) or, with none, its fixed slug', async () => {
    const { cmds } = build();
    expect((await cmds.browserConversationOf('room', 'acim')).group).toBe('brain');   // .egpt/rooms/acim
    expect((await cmds.browserConversationOf('room', 'tpoef')).group).toBe('brain');  // no row → fixedSlugFor
    expect((await cmds.browserConversationOf('room', 'dj-son')).group).toBe('shared');
  });

  it('no registry wired (standalone construction) → null, the conversation-less brain path', async () => {
    const { cmds } = build({ state: null });
    expect(await cmds.browserConversationOf('whatsapp', '!admin')).toBe(null);
  });
});

// The live case (operator 2026-10-21): a /split of "eGPT Rodz Lulu An" (brain) is its own entry with
// parent_chat; a /join of it is an alias.
const SPLIT_KEY = 'SI+eGPT Rodz Lulu An-lulu-amazon-2610220339';
const SPLIT_STATE = { contacts: { ...STATE.contacts, whatsapp: {
  ...STATE.contacts.whatsapp,
  '!lulu': { slug: 'eGPT Rodz Lulu An-2609201419', conversation_path: '.egpt/conversations/whatsapp/eGPT Rodz Lulu An-2609201419' },
  '!split': { slug: SPLIT_KEY, conversation_path: `.egpt/conversations/whatsapp/${SPLIT_KEY}`, parent_chat: '!lulu' },
  '!split2': { slug: 'SI+lulu-amazon-cart-2610220400', conversation_path: '.egpt/conversations/whatsapp/SI+lulu-amazon-cart-2610220400', parent_chat: '!split' },
  '!orphan': { slug: 'Reinie fork-2610220339', conversation_path: '.egpt/conversations/whatsapp/Reinie fork-2610220339', parent_chat: '!reinie' },
  '!join': { aliasOf: '!lulu', transcript: 'eGPT Rodz Lulu An-gnossis', join_name: 'gnossis', join_by: 'An', mouth_chat: '!mouth' },
} } };

describe('a /split inherits its parent\'s browser group; /end ends it', () => {
  // boot's being-link wiring: the being's slug → its chat (chatIdForEntity) → browserConversationOf.
  const beingGroup = async (state, slug, groups) => {
    const { cmds } = build({ state, groups });
    const started = [];
    const link = createBeingLink({
      port: 1, clientPath: 'C:/x/ask-spine.mjs',
      startBrowser: async (c) => { started.push(c); return { ok: true }; },
      conversationOf: async (who) => cmds.browserConversationOf(who.surface, chatIdForEntity(state, `${who.surface}/${who.slug}`)?.chatId ?? who.slug),
    });
    await link.ask({ being: 'e', surface: 'whatsapp', slug, boxed: true }, { ask: 'browser', action: 'start', extra: [] });
    return started[0]?.group;
  };

  it('split → the parent\'s group under its own key/name, through the commands resolver and the being link', async () => {
    const { cmds } = build({ state: SPLIT_STATE });
    expect(await cmds.browserConversationOf('whatsapp', '!split')).toEqual({ key: SPLIT_KEY, name: 'SI+eGPT Rodz Lulu An-lulu-amazon', group: 'brain' });
    expect((await cmds.browserConversationOf('whatsapp', '!split2')).group).toBe('brain');
    expect(await beingGroup(SPLIT_STATE, SPLIT_KEY)).toBe('brain');
  });

  it('the split listed explicitly → that group', async () => {
    const groups = { ...GROUPS, amazon: ['SI+eGPT Rodz Lulu An-lulu-amazon'] };
    const { cmds } = build({ state: SPLIT_STATE, groups });
    expect((await cmds.browserConversationOf('whatsapp', '!split')).group).toBe('amazon');
    expect(await beingGroup(SPLIT_STATE, SPLIT_KEY, groups)).toBe('amazon');
  });

  it('parent unlisted → shared', async () => {
    const { cmds } = build({ state: SPLIT_STATE });
    expect((await cmds.browserConversationOf('whatsapp', '!orphan')).group).toBe('shared');
  });

  it('after /end (mapping dropped) or with no parent_chat → shared again', async () => {
    const ended = dropContact(SPLIT_STATE, 'whatsapp', '!split');
    expect((await build({ state: ended }).cmds.browserConversationOf('whatsapp', '!split')).group).toBe('shared');
    expect(await beingGroup(ended, SPLIT_KEY)).toBe('shared');
    const { parent_chat, ...unparented } = SPLIT_STATE.contacts.whatsapp['!split'];
    const plain = { contacts: { whatsapp: { ...SPLIT_STATE.contacts.whatsapp, '!split': unparented } } };
    expect((await build({ state: plain }).cmds.browserConversationOf('whatsapp', '!split')).group).toBe('shared');
  });

  it('a /join alias, by its own chat id, resolves to the parent\'s conversation; after /end → shared', async () => {
    const { cmds } = build({ state: SPLIT_STATE });
    expect(await cmds.browserConversationOf('whatsapp', '!join')).toEqual({ key: 'eGPT Rodz Lulu An-2609201419', name: 'eGPT Rodz Lulu An', group: 'brain' });
    const ended = dropContact(SPLIT_STATE, 'whatsapp', '!join');
    expect((await build({ state: ended }).cmds.browserConversationOf('whatsapp', '!join')).group).toBe('shared');
  });
});

describe('startBrowser(conversation)', () => {
  it('eGPT Admin (brain) → brain\'s pipe Chrome on the brain profile', async () => {
    const { cmds, calls } = build();
    const r = await cmds.startBrowser(await cmds.browserConversationOf('whatsapp', '!admin'));
    expect(r).toMatchObject({ ok: true, launched: true });
    expect(r.detail).toMatch(/the "brain" browser is up/);
    expect(calls.map((c) => c.profileDir)).toEqual([CHROME_BRAIN_PROFILE]);
  });

  it('an unlisted chat → its shared group pipe Chrome', async () => {
    const { cmds, calls } = build();
    const r = await cmds.startBrowser(await cmds.browserConversationOf('whatsapp', '!reinie'));
    expect(r).toMatchObject({ ok: true, launched: true });
    expect(calls.map((c) => c.profileDir)).toEqual([sharedDir]);
  });

  it('ambiguous → no browser, one log line, never the brain', async () => {
    const { cmds, calls, logs } = build();
    const r = await cmds.startBrowser(await cmds.browserConversationOf('whatsapp', '!dup'));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/work, other/);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "Twice"/.test(l))).toHaveLength(1);
  });

  it('conversation-less → brain\'s pipe Chrome; a second start reports it already running', async () => {
    const { cmds, calls } = build();
    expect(await cmds.startBrowser()).toMatchObject({ ok: true, launched: true });
    expect(await cmds.startBrowser()).toEqual({ ok: true, alreadyRunning: true, detail: 'the "brain" browser is already running (pid 1001)' });
    expect(calls.map((c) => c.profileDir)).toEqual([CHROME_BRAIN_PROFILE]);
  });
});

describe('/chrome resolves the chat it was typed in', () => {
  it('in eGPT Admin → brain\'s pipe Chrome report', async () => {
    const { cmds, sent, calls } = build();
    await run(cmds, '!admin', '/chrome kg');
    expect(sent[0].text).toMatch(/attached: the "brain" browser \(pipe\)/);
    expect(sent[0].text).toMatch(/Gmail/);
    expect(calls.map((c) => c.profileDir)).toEqual([CHROME_BRAIN_PROFILE]);
  });

  it('in an unlisted chat → the shared group Chrome\'s tabs, not the brain\'s', async () => {
    const { cmds, sent, calls } = build();
    await run(cmds, '!reinie', '/chrome kg');
    expect(sent[0].text).toMatch(/PipeTab/);
    expect(sent[0].text).not.toMatch(/Gmail|9221/);
    expect(calls.map((c) => c.profileDir)).toEqual([sharedDir]);
  });

  it('ambiguous → no browser, nothing launched', async () => {
    const { cmds, sent, calls } = build();
    await run(cmds, '!dup', '/chrome kg');
    expect(sent[0].text).toMatch(/no browser/);
    expect(sent[0].text).not.toMatch(/Gmail/);
    expect(calls).toHaveLength(0);
  });
});

describe('/tabs /close drive the chat\'s group Chrome', () => {
  it('/tabs in eGPT Admin lists the brain; in an unlisted chat the shared group', async () => {
    const { cmds, sent } = build();
    await run(cmds, '!admin', '/tabs');
    await run(cmds, '!reinie', '/tabs');
    expect(sent[0].text).toMatch(/1 · Gmail/);
    expect(sent[1].text).toMatch(/1 · PipeTab/);
    expect(sent[1].text).not.toMatch(/Gmail/);
  });

  it('/close 1 in an unlisted chat never touches a brain tab', async () => {
    const { cmds, sent, brainCloses } = build();
    await run(cmds, '!admin', '/tabs');   // brain's Chrome is up too
    await run(cmds, '!reinie', '/close 1');
    expect(sent[1].text).toMatch(/closed 1 · PipeTab/);
    expect(brainCloses).toEqual([]);
  });

  it('/tabs in an ambiguous chat → no tabs, nothing spawned', async () => {
    const { cmds, sent, calls } = build();
    await run(cmds, '!dup', '/tabs');
    expect(sent[0].text).not.toMatch(/Gmail|PipeTab/);
    expect(calls).toHaveLength(0);
  });
});

describe('/login follows the chat\'s group', () => {
  const recorder = () => { const seen = []; return { seen, requestLogin: async (site, o) => { seen.push({ site, ...o }); return 'logged-in'; } }; };

  it('eGPT Admin → the brain conversation + brain\'s pipe client', async () => {
    const rec = recorder();
    const { cmds } = build({ requestLogin: rec.requestLogin });
    await run(cmds, '!admin', '/login example.com');
    expect(rec.seen).toHaveLength(1);
    expect(rec.seen[0].conversation.group).toBe('brain');
    expect((await rec.seen[0].client.listTabs()).map((t) => t.title)).toEqual(['Gmail']);
  });

  it('an unlisted chat → the shared conversation + the shared pipe client', async () => {
    const rec = recorder();
    const { cmds } = build({ requestLogin: rec.requestLogin });
    await run(cmds, '!reinie', '/login example.com');
    expect(rec.seen[0].conversation.group).toBe('shared');
    expect(await rec.seen[0].client.listTabs()).toEqual([{ id: 'P1', type: 'page', url: 'https://pipe.example/', title: 'PipeTab' }]);
  });

  it('ambiguous → the limb is never asked', async () => {
    const rec = recorder();
    const { cmds, sent } = build({ requestLogin: rec.requestLogin });
    await run(cmds, '!dup', '/login example.com');
    expect(rec.seen).toHaveLength(0);
    expect(sent[0].text).toMatch(/no browser/);
  });
});

describe('/members, /activate and /status reach the chat\'s group Chrome', () => {
  const ADAPTERS = [{ name: 'pipe-cdp', urlMatch: /pipe\.example/, homeUrl: 'https://pipe.example/' }];
  function withRoom(members = []) {
    const room = { slug: 'r', members: async () => members, setMember: async (m) => { const i = members.findIndex((x) => x.id === m.id); if (i >= 0) members[i] = m; else members.push(m); } };
    return { members, ...build({ loadAdapters: async () => ADAPTERS, resolveConvRoom: async () => room, dueFor: () => ({ due: false }) }) };
  }

  it('/members add tab 1 in an unlisted chat adds the tab /tabs numbers there — shared\'s, never brain\'s', async () => {
    const { cmds, sent, calls, members } = withRoom();
    await run(cmds, '!reinie', '/members add tab 1');
    expect(sent[0].text).toMatch(/added 'pipe'/);
    expect(members.map((m) => [m.url, m.targetId])).toEqual([['https://pipe.example/', 'P1']]);
    expect(calls.map((c) => c.profileDir)).toEqual([sharedDir]);
  });

  it('/members reads presence from the group Chrome only when it is up — a roster never launches one', async () => {
    const { cmds, sent, calls } = withRoom([{ kind: 'brain', id: 'pipe', state: 'muted', adapter: 'pipe-cdp', url: 'https://pipe.example/', targetId: 'P1' }]);
    await run(cmds, '!reinie', '/members');
    expect(sent[0].text).toMatch(/pipe {3}brain {3}inactive/);
    expect(calls).toHaveLength(0);
    await run(cmds, '!reinie', '/tabs');
    await run(cmds, '!reinie', '/members');
    expect(sent[2].text).toMatch(/pipe {3}brain {3}active/);
  });

  it('/activate in eGPT Admin reopens the member\'s tab in brain\'s Chrome', async () => {
    const { cmds, sent, calls, brainOpens } = withRoom([{ kind: 'brain', id: 'gm', state: 'muted', adapter: 'gm', url: 'https://mail.google.com/', targetId: 'gone' }]);
    await run(cmds, '!admin', '/activate gm');
    expect(sent[0].text).toBe('reopened https://mail.google.com/ · tab B9 · active');
    expect(brainOpens).toEqual(['https://mail.google.com/']);
    expect(calls.map((c) => c.profileDir)).toEqual([CHROME_BRAIN_PROFILE]);
  });

  it('/activate in a chat with no browser says so, and opens nothing', async () => {
    const { cmds, sent, calls } = withRoom([{ kind: 'brain', id: 'gm', state: 'muted', adapter: 'gm', url: 'https://mail.google.com/', targetId: 'gone' }]);
    await run(cmds, '!dup', '/activate gm');
    expect(sent[0].text).toMatch(/^`\/activate`: no browser for this chat — .*work, other/);
    expect(calls).toHaveLength(0);
  });

  it('/status reads the chat\'s group Chrome only when it is up — and never launches one', async () => {
    const { cmds, sent, calls } = withRoom();
    await run(cmds, '!reinie', '/status');
    expect(sent[0].text).toMatch(/chrome: off/);
    expect(calls).toHaveLength(0);
    await run(cmds, '!reinie', '/tabs');
    await run(cmds, '!reinie', '/status');
    expect(sent[2].text).toMatch(/chrome: up · 1 brain tabs/);
    expect(calls.map((c) => c.profileDir)).toEqual([sharedDir]);
  });
});

describe('loginProfilePathOf — the credential comes from the GROUP profile', () => {
  const cfg = { login: { chrome_profile_path: 'C:/x/brain-login' } };
  it('brain (or conversation-less) → the login override, as before', () => {
    expect(loginProfilePathOf(cfg)).toBe('C:/x/brain-login');
    expect(loginProfilePathOf(cfg, { name: 'eGPT Admin', group: 'brain' })).toBe('C:/x/brain-login');
    expect(loginProfilePathOf({})).toBe(CHROME_BRAIN_PROFILE);
  });
  it('another group → that group\'s profile dir, never the brain override', () => {
    expect(loginProfilePathOf(cfg, { name: 'Reinie Alvino', group: 'shared' })).toBe(sharedDir);
  });
  it('no group → null (no credential is read)', () => {
    expect(loginProfilePathOf(cfg, { name: 'Twice', group: null })).toBe(null);
  });
});

describe('room relay hands its seams the room event, so boot can pick the room\'s group Chrome', () => {
  it('activateTarget and streamFromTab both receive the event as their second argument', async () => {
    const seen = [];
    const relay = createRoomRelay({
      resolveMembers: async () => [{ kind: 'brain', id: 'chatgpt', adapter: 'chatgpt-cdp', state: 'active', targetId: 'T9' }],
      adapterOf: async () => ({ injectScript: (t) => t, pollScript: 'p' }),
      streamFromTab: async (o, ev) => { seen.push(['stream', o.targetId, ev]); return ''; },
      activateTarget: async (id, ev) => { seen.push(['activate', id, ev]); },
      openStream: () => ({ update() {}, async finish() {}, async fail() {} }),
    });
    const ev = { surface: 'room', chatId: 'acim', body: 'hi' };
    await relay.fanOut(ev);
    expect(seen).toEqual([['activate', 'T9', ev], ['stream', 'T9', ev]]);
  });
});

describe('boot wires the heartbeat and the room relay through the ONE resolver (source lock)', () => {
  const BOOT_SRC = readFileSync(join(REPO, 'src', 'spine', 'boot.mjs'), 'utf8');
  it('a browser: true beat starts its conversation\'s group Chrome', () => {
    expect(BOOT_SRC).toMatch(/startBrowser: async \(ns\) =>[^\n]*commands\.startBrowser\(await commands\.browserConversationOf\(/);
  });
  it('a being\'s browser asks resolve its chat through browserConversationOf', () => {
    expect(BOOT_SRC).toMatch(/conversationOf: async \(who\) => commands\.browserConversationOf\(who\.surface, chatIdForEntity\(await _loadState\(\), `\$\{who\.surface\}\/\$\{who\.slug\}`\)\?\.chatId \?\? who\.slug\)/);
  });
  it('the relay drives the room\'s group Chrome via commands.chatChromeOf', () => {
    expect(BOOT_SRC).toMatch(/streamFromTab: async \(o, ev\) =>/);
    expect(BOOT_SRC).toMatch(/activateTarget: async \(id, ev\) =>/);
    expect(BOOT_SRC).toMatch(/commands\.chatChromeOf\(ev\?\.surface, ev\?\.chatId\)/);
  });
  it('commands gets no port client — only the chrome log', () => {
    expect(BOOT_SRC).not.toMatch(/^\s+cdp,\s/m);
    expect(BOOT_SRC).not.toMatch(/import \* as cdp from/);
    expect(BOOT_SRC).toMatch(/onChromeLog: \(m\) => log\.line/);
  });
});
