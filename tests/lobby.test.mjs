// lobby.test.mjs — the LOBBY: the console's durable home Room (plans/260724-LOBBY-DEFAULT-ROOM.md).
//
// Reproduce-first locks for v1 (the core): opening the shell lands the operator in a
// stable `lobby` conversation instead of the throwaway shell-<yymmddhhmm> auto slug, the
// lobby inherits the Room machinery (transcript, members, phase-4 relay) for free, and
// /members lists this node's local beings E/D/L.
//
// 2026-08-28 — THE LOBBY IS A ROOM. Operator: *"rooms is a shell… but shell/rooms/* makes no
// sense. in the same way naming it 'beeper' would make it confusing and we called it
// conversations. in this same way, we can call 'rooms' what is a shell. so we can have
// rooms/lobby, rooms/dj-son, rooms/radio."* So the shell is a TRANSPORT (a network), not a
// storage surface: rooms/ holds exactly ONE surface, `room`, and the console's own seat is
// (room, lobby) at rooms/lobby/. Section 0 below is the reproduce-first lock for that.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
// A PRIVATE profile for this file — the SAME fix, for the same reason, as
// tests/rooms-members.test.mjs and tests/list-entity-dirs.test.mjs.
//
// Section 4 writes a member roster through Room.setMember, which read-modify-writes ONE
// process-global config/rooms.yaml (rooms-file.roomsFilePath). The suite's SHARED throwaway
// profile (tests/setup-egpt-home.mjs) is written CONCURRENTLY by other files —
// remote-command.test.mjs lands the mesh lobby's row in the very same file — and vitest's
// `forks` pool puts them in DIFFERENT PROCESSES, so no in-process serializer can order them:
// the two simply lose each other's updates. `/members add tab` writes the member, the other
// file's write clobbers the row, and the next `/members mode mention chatgpt` throws
// `Room.setMemberState: no member "chatgpt"`.
//
// The window scales with the file, and NOTHING prunes it (it had reached 179 KB / 6.5k junk
// rows on this machine), so this was a coin the suite had been winning rather than a hazard it
// did not have. Adding section 0 above shifted this file's write a few ms into the other's
// window and the coin started landing tails every time.
//
// egpt-home.mjs freezes EGPT_HOME at module load, so the override must run BEFORE the imports
// below — vi.hoisted is what does that. (os/path are not importable in a hoisted block, which
// runs before the imports it precedes, so the temp root comes from the env — which is what
// os.tmpdir() reads anyway.) The beforeAll below is the tripwire + the prune that keeps THIS
// profile from becoming the next 179 KB file.
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-lobby-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  emptyState, ensureContact, getContact, slugDir, fixedSlugFor, LOBBY_SLUG,
} from '../src/conversations-state.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { createIdentity, surfaceOf, SHELL_SURFACE } from '../src/spine/identity.mjs';
import { chatIdForEntity } from '../src/spine/boot.mjs';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';

const norm = (p) => String(p).replace(/\\/g, '/');

// ── 0. THE SHELL IS A TRANSPORT; ITS SURFACE IS `room`, ITS SEAT IS `lobby` ───
// REPRODUCE-FIRST for the 2026-08-28 ruling. Before it, surfaceOf('shell') was 'shell', the
// console seat was chatId 'main', and the lobby's folder sat inside conversations/ — the
// BEEPER tree, which the shell does not arrive through. Every assertion here failed.
describe('the shell is a transport onto surface `room` — the console seat is (room, lobby)', () => {
  it('surfaceOf maps the shell NETWORK onto surface `room` — the ONE map', () => {
    expect(surfaceOf('shell')).toBe('room');
    expect(SHELL_SURFACE).toBe('room');
    expect(surfaceOf('shell_2')).toBe('room');       // the instance-prefix fold still folds first
    expect(surfaceOf('room')).toBe('room');           // a room-native event is already there
    expect(surfaceOf('whatsapp')).toBe('whatsapp');   // no other surface moves
    expect(surfaceOf('telegram')).toBe('telegram');
    expect(surfaceOf('googlevoice')).toBe('googlevoice');
  });

  it("the shell port's default console seat IS the lobby — one string is the chatId, the slug and the folder", () => {
    // The seat id is what an editor frame that omits chatId lands on; claim/owns is the
    // registry that proves which id this limb answers for.
    const port = createShellPort();
    port.claim(LOBBY_SLUG);
    expect(port.owns(LOBBY_SLUG)).toBe(true);
    expect(fixedSlugFor('room', LOBBY_SLUG)).toBe(LOBBY_SLUG);   // chatId → slug is the identity function
  });

  it('an inbound shell frame builds an event on surface `room` — network, node tag and AUTHORITY unchanged', () => {
    const identity = createIdentity({ now: () => 1000 });
    const ev = identity.build({
      body: 'hola',
      from: { chatId: LOBBY_SLUG, chatName: 'shell', network: 'shell', userId: 'operator', senderName: 'operator', authorized: true },
    });
    expect(ev.surface).toBe('room');
    expect(ev.chatId).toBe(LOBBY_SLUG);
    expect(ev.node).toBe('sh');          // the TRANSPORT tag is still the shell — the dispatch line is unchanged
    expect(ev.authorized).toBe(true);    // the console's authority is untouched by the surface move
    expect(ev.senderId).toBe('operator');
  });

  it('ONE folder and ONE namespace: rooms/lobby and room/lobby', () => {
    const lobby = Room.forChat('room', LOBBY_SLUG);
    expect(lobby.ns()).toBe('room/lobby');
    expect(norm(lobby.baseDir())).toMatch(/\/rooms\/lobby$/);
    expect(norm(lobby.baseDir())).not.toMatch(/conversations/);
    expect(norm(slugDir('room', LOBBY_SLUG))).toBe(norm(lobby.baseDir()));
  });

  it('the lobby needs NO registry row — its chatId IS its name, so the walk resolves it alone', () => {
    expect(chatIdForEntity(emptyState(), 'room/lobby')).toEqual({ surface: 'room', chatId: LOBBY_SLUG });
  });

  it('ONE registry row when it does get one: contacts.room.lobby, pointing at rooms/lobby', () => {
    const ens = ensureContact(emptyState(), 'room', LOBBY_SLUG, { pushedName: 'shell' });
    expect(ens.slug).toBe(LOBBY_SLUG);
    expect(Object.keys(ens.state.contacts.room)).toEqual([LOBBY_SLUG]);
    expect(ens.state.contacts.shell).toBeUndefined();               // nothing lands on the old surface
    expect(norm(ens.entry.conversation_path)).toMatch(/\/rooms\/lobby$/);
    expect(norm(ens.entry.conversation_path)).not.toMatch(/conversations/);
  });

  it('the lobby is a room among rooms — same kind, same tree, same rung key shape', () => {
    for (const name of [LOBBY_SLUG, 'dj-son', 'radio']) {
      const r = Room.forChat('room', name);
      expect(r.ns()).toBe(`room/${name}`);
      expect(norm(r.baseDir())).toMatch(new RegExp(`/rooms/${name}$`));
      expect(norm(r.transcriptPath)).toMatch(new RegExp(`/rooms/${name}/transcript\\.md$`));
    }
  });
});

// ── 1. the shell's default conversation resolves to the fixed slug `lobby` ────
describe('lobby slug — the shell console seat is the durable lobby, not an auto slug', () => {
  // The RETIRED seat, kept as a READ path only: nothing produces ('shell','main') any more
  // (the console is ('room','lobby') — section 0), but a profile that has not run
  // setup/move-rooms-out-of-conversations.mjs yet still carries a contacts.shell.main row,
  // and this arm is what keeps it resolving to `lobby` instead of minting a shell-<ts> beside
  // it. Delete this arm when every profile has been migrated, not before.
  it('fixedSlugFor maps only the shell "main" seat to lobby', () => {
    expect(fixedSlugFor('shell', 'main')).toBe('lobby');
    expect(fixedSlugFor('shell', '!other')).toBe(null);   // a joined chat is not the lobby
    expect(fixedSlugFor('whatsapp', 'main')).toBe(null);  // other surfaces are unaffected
  });

  // ── the SECOND fixed-slug surface: `room` (operator's ruling 2026-08-09) ──────
  // An operator-named room is a conversation whose chatId IS the typed name, so its slug is
  // a pure function of that name — sanitizeName, no -yymmddhhmm tail, no title-driven
  // re-slug. That is what makes /rooms print a name you can type back, and what lets a READ
  // verb resolve a room without touching conv-state. Added BESIDE the lobby's own cases: the
  // shell arm above is untouched and must keep passing verbatim.
  it('fixedSlugFor makes a room slug the kebab of its name, with no tail', () => {
    expect(fixedSlugFor('room', 'acim')).toBe('acim');
    expect(fixedSlugFor('room', 'Foo')).toBe('foo');            // case folds …
    expect(fixedSlugFor('room', 'My Room')).toBe('my-room');    // … and so does punctuation
    expect(fixedSlugFor('room', 'acim')).not.toMatch(/-\d{10}$/);
  });

  // AGENT joins ROOM (operator 2026-09-01, the global wren). A being pinned node-wide
  // resolves every chat it is addressed in to ONE conversation, and that conversation's
  // folder IS the address — agents/wren/, never agents/wren-2609011200/, and never
  // re-slugged when a title changes. Without this arm the pin still works but lands on a
  // timestamped folder that differs between profiles.
  it('fixedSlugFor gives an agent the kebab of its name too, with no tail', () => {
    expect(fixedSlugFor('agent', 'wren')).toBe('wren');
    expect(fixedSlugFor('agent', 'Wren')).toBe('wren');
    expect(fixedSlugFor('agent', 'Meta Engineer')).toBe('meta-engineer');
    expect(fixedSlugFor('agent', 'wren')).not.toMatch(/-d{10}$/);
    // and it round-trips: the slug an agent registers under IS its chatId
    expect(ensureContact(emptyState(), 'agent', 'wren').slug).toBe('wren');
  });

  it('fixedSlugFor leaves every OTHER surface null — no Beeper conversation loses its tail', () => {
    expect(fixedSlugFor('whatsapp', 'acim')).toBe(null);
    expect(fixedSlugFor('whatsapp', '@1234@s.whatsapp.net')).toBe(null);
    expect(fixedSlugFor('telegram', 'acim')).toBe(null);
    expect(fixedSlugFor('shell', 'acim')).toBe(null);
    // and the tail really is still minted for them
    expect(ensureContact(emptyState(), 'whatsapp', '@x', { pushedName: 'acim' }).slug).toMatch(/^acim-\d{10}$/);
  });

  it('ensureContact("room","acim") mints the suffix-less slug "acim" at rooms/acim', () => {
    const ens = ensureContact(emptyState(), 'room', 'acim');   // no pushedName — a room has no title
    expect(ens.slug).toBe('acim');
    expect(ens.slug).not.toMatch(/-\d{10}$/);
    expect(ens.slug).not.toMatch(/^contact/);   // the placeholder a title-less mint used to give
    expect(norm(slugDir('room', ens.slug))).toMatch(/\/rooms\/acim$/);
  });

  it('a room is never re-slugged, and a second sighting is a no-op (stable folder)', () => {
    const first = ensureContact(emptyState(), 'room', 'acim');
    const again = ensureContact(first.state, 'room', 'acim', { pushedName: 'something else entirely' });
    expect(again.slug).toBe('acim');       // a title cannot move a room's folder
    expect(again.renamedFrom ?? null).toBe(null);
  });

  it('ensureContact("shell","main") mints the suffix-less slug "lobby" (no shell-<ts>)', () => {
    const ens = ensureContact(emptyState(), 'shell', 'main', { pushedName: 'shell', slugHint: 'shell' });
    expect(ens.slug).toBe('lobby');
    expect(ens.slug).not.toMatch(/-\d{10}$/);   // NOT the throwaway shell-2607201416 shape
    expect(norm(slugDir('shell', 'lobby'))).toMatch(/conversations\/shell\/lobby$/);
  });

  it('ensureContact("shell","main") MIGRATES an existing shell-<ts> entry to lobby (fixed slug wins over the stored slug)', () => {
    // The persisted operator contact predates the lobby seat: contacts.shell.main stores the
    // throwaway shell-2607201416 the name-derived path once minted. A fixed-slug seat must WIN —
    // resolve to lobby AND rewrite conversation_path — so transcript/members/relay all key the
    // lobby, not the orphaned old folder. Before the fix, step-1 returned the stored slug unchanged.
    const seeded = {
      contacts: {
        shell: {
          main: {
            slug: 'shell-2607201416',
            conversation_path: '.egpt/conversations/shell/shell-2607201416',
            home_dir: 'stub',
            threadId: null,
            pushedName: 'shell',
          },
        },
      },
    };
    const ens = ensureContact(seeded, 'shell', 'main', { pushedName: 'shell' });
    expect(ens.slug).toBe('lobby');
    expect(ens.changed).toBe(true);
    expect(ens.entry.slug).toBe('lobby');
    expect(norm(ens.entry.conversation_path)).toMatch(/conversations\/shell\/lobby$/);
    // the returned STATE carries the migrated entry (not just the return value)
    expect(getContact(ens.state, 'shell', 'main')?.slug).toBe('lobby');
    // the orphaned old on-disk folder is left as-is — no folder move signalled to the caller
    expect(ens.renamedFrom == null).toBe(true);
  });

  it('contacts.resolve("shell","main") returns lobby and NEVER re-slugs to shell-<ts> on re-sight', async () => {
    let state = emptyState();
    let writes = 0;
    const renames = [];
    const contacts = createContacts({
      loadState: async () => state,
      writeState: async (s) => { state = s; writes++; },
      io: { rename: async (from, to) => { renames.push({ from, to }); }, appendFile: async () => {} },
    });
    // first sight (transcript path passes chatName 'shell'); later sights: bare (resolveConvRoom).
    const first = await contacts.resolve('shell', 'main', { chatName: 'shell' });
    const second = await contacts.resolve('shell', 'main', { chatName: 'shell' });
    const third = await contacts.resolve('shell', 'main');
    expect(first).toBe('lobby');
    expect(second).toBe('lobby');
    expect(third).toBe('lobby');
    expect(renames).toHaveLength(0);                                  // chatName 'shell' must NOT rename lobby → shell-<ts>
    expect(getContact(state, 'shell', 'main')?.slug).toBe('lobby');
    expect(writes).toBeLessThanOrEqual(1);                            // steady-state re-sight does not churn
  });
});

// ── 2. /members in the lobby lists the local beings E, D, L ───────────────────
describe('/members in the lobby — lists the node\'s local beings E/D/L', () => {
  function lobbyCommands(agents) {
    const sent = [];
    const room = { slug: LOBBY_SLUG, surface: 'room', members: async () => [] };
    const cmds = createCommands({
      getConfig: () => ({ agents }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      cdp: { listTabs: async () => [] },
      resolveConvRoom: async () => room,
    });
    return { cmds, sent, room };
  }

  it('bare /members shows E (persona), D, L as present being members', async () => {
    const { cmds, sent } = lobbyCommands({
      e: { default: true, name: 'E' },
      d: { name: 'D' },
      l: { name: 'L' },
    });
    await cmds.run({ chatId: LOBBY_SLUG, surface: 'room', body: '/members' });
    const text = sent.at(-1).text;
    expect(text).toContain('lobby (3 members)');
    expect(text).toContain('e   being');
    expect(text).toContain('d   being');
    expect(text).toContain('l   being');
  });

  // A `_`-comment key is skipped — that (and commenting the agent out) IS the disable mechanism.
  // `enabled: false` is INERT since 2026-07-26 (operator: "disabling is just commenting the
  // config. no need to have or check an enabled key in this case"), so an agent carrying it is a
  // lobby member like any other.
  it('a `_`-comment key is skipped; an `enabled: false` key is inert (still a member)', async () => {
    const { cmds, sent } = lobbyCommands({
      e: { default: true },
      _note: 'ignored',
      off: { enabled: false },
    });
    await cmds.run({ chatId: LOBBY_SLUG, surface: 'room', body: '/members' });
    const text = sent.at(-1).text;
    expect(text).toContain('lobby (2 members)');
    expect(text).toContain('e   being');
    expect(text).toContain('off   being');
    expect(text).not.toContain('_note');
  });

  it('a NON-lobby conversation does NOT get the local beings injected', async () => {
    const sent = [];
    const room = { slug: 'diego-2607010101', surface: 'whatsapp', members: async () => [] };
    const cmds = createCommands({
      getConfig: () => ({ agents: { e: { default: true }, l: {} } }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      cdp: { listTabs: async () => [] },
      resolveConvRoom: async () => room,
    });
    await cmds.run({ chatId: '!c', surface: 'whatsapp', body: '/members' });
    const text = sent.at(-1).text;
    expect(text).toContain('(0 members)');
    expect(text).toContain('(no members yet)');
  });
});

// ── 3. a shell message in the lobby logs to rooms/lobby/transcript.md ───────
const readdirOver = (files) => async (dir) => {
  const prefix = norm(dir).replace(/\/$/, '') + '/';
  const out = new Set();
  for (const k of files.keys()) {
    const nk = norm(k);
    if (nk.startsWith(prefix)) { const rest = nk.slice(prefix.length); if (!rest.includes('/')) out.add(rest); }
  }
  return [...out];
};

describe('lobby transcript — a shell message records under rooms/lobby/', () => {
  it('routes the transcript append to the lobby folder (via the shared contacts resolver)', async () => {
    let state = emptyState();
    const contacts = createContacts({
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: { rename: async () => {}, appendFile: async () => {} },
    });
    const files = new Map();
    const io = {
      appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {},
      existsSync: (p) => files.has(p),
      readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      writeFile: async (p, d) => { files.set(p, d); },
      readdir: readdirOver(files),
    };
    const t = createTranscript({ contacts, io });
    const shellEv = {
      surface: 'room', chatId: LOBBY_SLUG, chatName: 'shell',
      senderId: 'operator', ts: Date.UTC(2026, 6, 24, 12, 0),
      line: 'operator@[shell].kg (12:00) #m1: hello lobby', body: 'hello lobby',
    };
    expect(await t.log(shellEv)).toBe(true);
    const transcript = [...files.entries()].find(([p]) => norm(p).endsWith('rooms/lobby/transcript.md'));
    expect(transcript).toBeTruthy();
    expect(transcript[1]).toContain('hello lobby');
  });
});

// ── 4. a chatgpt tab added in the lobby drives the relay for a lobby @chatgpt ──
class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}
const ADAPTERS = [{ name: 'chatgpt-cdp', urlMatch: /chatgpt\.com|chat\.openai\.com/, homeUrl: 'https://chatgpt.com/' }];
const oneTab = [{ id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' }];

function shellHuman(body) {
  return { body, from: { network: 'shell', chatId: LOBBY_SLUG, chatName: 'shell', userId: 'operator', senderName: 'operator', authorized: true, msgKey: 'm1' } };
}

describe('lobby relay — @chatgpt added in the lobby fires the phase-4 relay', () => {
  let base;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-lobby-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  // The SHARED resolver both /members (WRITE) and the relay (READ) go through — the REAL
  // contacts.resolve so ('room','lobby') deterministically keys the lobby Room for both sides.
  function makeLobbyResolveConvRoom() {
    let state = emptyState();
    const contacts = createContacts({
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: { rename: async () => {}, appendFile: async () => {} },
    });
    const rooms = new Map();
    const resolve = async (surface, chatId) => {
      const slug = await contacts.resolve(surface, chatId);
      if (!slug) return null;
      if (!rooms.has(slug)) rooms.set(slug, new TmpRoom(join(base, 'conversations', surface, slug), slug));
      return rooms.get(slug);
    };
    return resolve;
  }

  function commandsFor(resolveConvRoom) {
    const sent = [];
    const cmds = createCommands({
      getConfig: () => ({ agents: { e: { default: true } } }),
      send: async (chatId, text) => sent.push({ chatId, text }),
      cdp: { listTabs: async () => oneTab },
      loadAdapters: async () => ADAPTERS,
      resolveConvRoom,
    });
    return { cmds, sent };
  }

  function spineFor(resolveConvRoom) {
    const relayCalls = [];
    const posts = [];
    let seq = 0;
    const bridge = { sent: [], onMessage() {}, send(chat, text, opts) { this.sent.push({ chat, text, opts }); }, stop() {}, wasSentByUs: () => false };
    const brain = { async turn(being, ev) { return { text: `E:${ev.body}`, sessionId: 's1' }; } };
    const router = { resolve: () => 'e' };
    const gating = { async decide() { return { mode: 'mention', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false };
    const transcript = { async log() {} };
    const heartbeats = { runDue() {} };
    const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
    const guard = createStopGuard({ turns: 6 });
    const identity = createIdentity({ now: () => 1000 });
    const roomRelay = createRoomRelay({
      resolveMembers: async (surface, chatId) => {
        const room = await resolveConvRoom(surface, chatId);
        return room ? await room.members() : [];
      },
      adapterOf: async () => ({ injectScript: (t) => `INJECT[${t}]`, pollScript: 'POLL' }),
      streamFromTab: async ({ targetId, injectScript, onUpdate }) => {
        relayCalls.push({ targetId, injectScript });
        onUpdate?.('…partial…');
        return `brain-reply-${++seq}`;
      },
      openStream: (memberId, chatId, opts) => {
        const rec = { memberId, chatId, opts, final: null };
        posts.push(rec);
        return { update() {}, finish: async (r) => { rec.final = typeof r === 'string' ? r : r?.text; }, fail: async () => {} };
      },
      onLog: () => {},
    });
    const spine = createSpine({
      bridge, brain, identity, router, gating, sender, transcript, heartbeats,
      guard, roomRelay, clock: { now: () => 1000 }, turnTimeoutMs: 0,
    });
    return { spine, relayCalls, posts };
  }

  it('/members add tab in the lobby → a later @chatgpt on the shell console drives the tab', async () => {
    const resolveConvRoom = makeLobbyResolveConvRoom();

    // sanity: the shell console seat resolves to the LOBBY room (not an auto slug).
    expect((await resolveConvRoom('room', LOBBY_SLUG)).slug).toBe('lobby');

    const { cmds, sent } = commandsFor(resolveConvRoom);
    await cmds.run({ chatId: LOBBY_SLUG, surface: 'room', body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    await cmds.run({ chatId: LOBBY_SLUG, surface: 'room', body: '/members mode mention chatgpt' });
    expect(sent.at(-1).text).toMatch(/mode:mention/);

    const { spine, relayCalls, posts } = spineFor(resolveConvRoom);
    await spine.handleInbound(shellHuman('@chatgpt say hi in five words'));

    expect(relayCalls).toHaveLength(1);                              // the relay FIRED on the lobby's roster
    expect(relayCalls[0].targetId).toBe('GPT1');                    // the tab the operator added in the lobby
    expect(relayCalls[0].injectScript).toBe('INJECT[say hi in five words]');
    expect(posts[0].final).toBe('brain-reply-1');                   // streamed back into the lobby
  });
});
