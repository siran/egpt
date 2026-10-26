// tests/fork-command.test.mjs — /split, /send and /end (operator 2026-10-03); /join retired 2026-10-25.
//
//   /split — REAL FORK. Create a group (operator + Rodz, type:"group") backed by a NEW conversation (own
//            slug/folder/entry, NOT an alias) whose resident beings' threads are COPIED under new thread
//            ids so it DIVERGES; the parent chatId is recorded on the new entry.
//   /send  — relay a replied-to message back to the original chat (recorded parent_chat, or the alias
//            target of an existing /join room); honours config.send.post_back_from.
//   /end   — archive the group and drop its mapping.
//   /join  — retired: answers with /split, makes nothing. Its existing alias rooms keep working.
//
// THE HARD CONSTRAINT: never a real Beeper call. Every bridge op is an injected fake (forkBridge) that
// only RECORDS the call — incl. the `via` account /send chose. State is in-memory (loadState/
// writeState over one object), except the restart-safety tests, which round-trip the REAL readState/
// writeState. /split's thread copy runs against a temp jsonl store (jsonlStoreRoot), never ~/.egpt-jsonl.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// egpt-home.mjs freezes EGPT_HOME at module load (slugDir reads CONVERSATIONS_ROOT off it), so this
// must run BEFORE the imports — vi.hoisted does that. A private temp profile, never ~/.egpt.
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-fork-command-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { createCommands, resolveSecondaryParticipantId, rewriteForkSessionJsonl, SPLIT_PLACEHOLDER_DEFAULT, GROUP_TITLE_DEFAULT, SPLIT_OPENER_DEFAULT, SEND_POST_BACK_FROM_DEFAULT, SIDE_GROUP_PREFIX } from '../src/spine/commands.mjs';
import { resolveBeingDef, sandboxSharePathsFor } from '../src/spine/brainpool.mjs';
import { ensureContact, recordThread, getContact, getBeing, slugDir, aliasContact, aliasTargetOf, patchContact, patchBeing, readState as readConvState, writeState as writeConvState } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature, encodeChatCanary } from '../src/node-signature.mjs';
import { Room } from '../src/room-core.mjs';
import { TEMPLATES } from '../src/tools/template.mjs';

// The variables each fill call was handed, by template text: checked against TEMPLATES.
const filled = vi.hoisted(() => new Map());
vi.mock('../src/tools/template.mjs', async (real) => {
  const t = await real();
  return { ...t, fill: (tpl, vars) => (filled.set(tpl, Object.keys(vars).sort()), t.fill(tpl, vars)) };
});
const documented = (key) => Object.keys(TEMPLATES[key]).sort();

const C_CHAT = '!chatC';
// createGroup returns the FULL matrix id; the spine keys every conversation by the SHORT id
// (shortChatId). The alias/entry MUST be keyed short or a short-form incoming misses it and spawns a
// separate folder+thread (the 2026-10-04 "side-room has no context" bug). The fakes below return the
// _FULL ids; everything else (alias key, incoming ev.chatId, seeded state) uses the SHORT ids.
const JOIN_CHAT_FULL = '!chatJoin:beeper.local';
const SPLIT_CHAT_FULL = '!chatSplit:beeper.local';
const JOIN_CHAT = shortChatId(JOIN_CHAT_FULL);
const SPLIT_CHAT = shortChatId(SPLIT_CHAT_FULL);
// The SECONDARY (Rodz) account's OWN room ids for the new groups — DIFFERENT from the primary's
// JOIN_CHAT/SPLIT_CHAT (a group is a different Matrix room per account). Rodz's copy of the opener
// arrives there, and that is how the group's mouth room is learned (by id, never by title).
const SEC_JOIN_ROOM = '!secJoin';
const SEC_SPLIT_ROOM = '!secSplit';
const secRoomOf = (chatId) => ({ [JOIN_CHAT]: SEC_JOIN_ROOM, [SPLIT_CHAT]: SEC_SPLIT_ROOM }[chatId] ?? `!sec-${chatId}`);
const SRC_E = '11111111-1111-1111-1111-11111111111e';
const SRC_W = '22222222-2222-2222-2222-22222222222w';

// A real boxed session per being: every record carries sessionId = the filename id; user records carry
// cwd = the conversation's folder. Plus a non-JSON line (claude writes stray lines) that must survive
// the transform copy verbatim.
const srcLines = (sid) => [
  JSON.stringify({ type: 'user', sessionId: sid, cwd: 'C:/orig', uuid: 'u1', message: { role: 'user', content: `hola ${sid}` } }),
  'not-json: a stray line claude sometimes writes',
  JSON.stringify({ type: 'assistant', sessionId: sid, uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', content: 'hey' } }),
].join('\n') + '\n';

// AN's primary + Rodz's secondary phones, named by config.beeper.{primary,secondary}.phone.
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_DIGITS = '13472576794';
// Rodz's BEEPER USER ID — what the WhatsApp create actually wants (a `+phone` is rejected).
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
const beeperCfg = (primary, secondary) => ({ beeper: { primary: { phone: primary }, secondary: { phone: secondary } } });

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

let base;      // a fresh temp root per test
let STORE;     // the fake jsonl store root (jsonlStoreRoot) for /split's copy
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'egpt-fork-'));
  STORE = join(base, 'jsonl');
  mkdirSync(STORE, { recursive: true });
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

// C's contact with the named beings each holding an active thread — so a being RESIDES here (the gate
// needs a resident being to carry/copy the thread). Each being b gets thread SRC_<b>.
const SRC_BY_BEING = { e: SRC_E, wren: SRC_W };
function seedStateBeing(...beings) {
  let st = ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: 'Proyecto X' }).state;
  for (const b of beings) st = recordThread(st, 'whatsapp', C_CHAT, SRC_BY_BEING[b], '2026-10-01T00:00:00Z', b);
  return st;
}
function seedState() { return seedStateBeing('e'); }
// Each seeded being's source session on disk, in the box store at <STORE>/<srcId>/projects/C--orig/.
function seedSourceThreads(...beings) {
  for (const b of beings) {
    const sid = SRC_BY_BEING[b];
    const projDir = join(STORE, sid, 'projects', 'C--orig');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${sid}.jsonl`), srcLines(sid), 'utf8');
  }
}
// C as above, PLUS an existing /join room aliased to it (made before /join was retired), `extra` as /join wrote it.
function stateWithJoin(extra = {}) {
  const st = seedState();
  const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
  return aliasContact(st, 'whatsapp', JOIN_CHAT, primaryJid, extra);
}
// C as above, PLUS a /split group: its OWN conversation entry carrying parent_chat (NOT an alias).
function stateWithSplit() {
  let st = seedState();
  st = ensureContact(st, 'whatsapp', SPLIT_CHAT, { pushedName: 'egpt split Proyecto X', slugHint: 'egpt-split-proyecto-x' }).state;
  st = recordThread(st, 'whatsapp', SPLIT_CHAT, 'split-thread-e', '2026-10-01T00:00:00Z', 'e');
  st = patchContact(st, 'whatsapp', SPLIT_CHAT, { parent_chat: C_CHAT });
  return st;
}

// node_role=primary with node_name kg; + Rodz phones + fork texts. CFG(role, nodeName, extra).
const PLACEHOLDER_SPLIT = '🍴 bifurcando…';
const OPENER_SPLIT = '🍴 bifurcación de {group}';
const GROUP_TITLE = 'egpt {name} de {group}';
function cfg({ node_name = 'kg', node_role = 'primary', texts = true, send, peer_nodes } = {}) {
  return {
    ...beeperCfg(AN, RODZ), node_name, node_role, agents: { e: {} },
    ...(peer_nodes ? { peer_nodes } : {}),
    ...(texts ? { group_title: GROUP_TITLE, split: { placeholder: PLACEHOLDER_SPLIT, opener: OPENER_SPLIT } } : {}),
    ...(send ? { send } : {}),
  };
}

function harness({ config, state, rooms = new Map(), rodzUserId = RODZ_USER_ID, copyArrives = true, throwOnPost = false, messages = null, chatRaw = null, createChatId = null } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { edit: [], create: [], post: [], archive: [], resolve: [], byTitle: [], list: [] };
  const mouthWaiters = [];
  let lastBody = '';
  const forkBridge = {
    editMessage: async (chatId, msgId, text) => { calls.edit.push({ chatId, msgId, text }); return true; },
    createGroup: async (opts, o = {}) => { calls.create.push({ ...opts, ...(o.via ? { via: o.via } : {}) }); return { success: true, chatID: createChatId ? createChatId(opts) : (opts.title?.includes('split') || /^\/split\b/i.test(lastBody) ? SPLIT_CHAT_FULL : JOIN_CHAT_FULL) }; },
    // records the via account /send + the opener chose (4th arg) so a test can assert which connection posts.
    // `unsigned` / `canary` are recorded ONLY when the caller passes them (the /send relay passes the
    // first, the opener the second), so each side's exact-shape toEqual assertions stay minimal.
    // What the primary posts reaches Rodz's account too, in Rodz's own room, carrying the canary.
    postReply: async (chatId, text, replyToMessageID, opts = {}) => {
      calls.post.push({ chatId, text, replyToMessageID, via: opts.via ?? null, ...(opts.unsigned !== undefined ? { unsigned: opts.unsigned } : {}), ...(opts.canary != null ? { canary: opts.canary } : {}) });
      if (throwOnPost) throw new Error('beeper down');
      if (opts.via === 'primary' && copyArrives) {
        const copy = { chatID: secRoomOf(chatId), text: `${text}${encodeChatCanary(opts.canary ?? '')}` };
        for (const w of [...mouthWaiters]) if (w.test(copy)) { mouthWaiters.splice(mouthWaiters.indexOf(w), 1); w.done(copy); }
      }
      return { ok: true };
    },
    archiveChat: async (chatId) => { calls.archive.push({ chatId }); return true; },
    chatAccountId: async () => 'whatsapp',
    chatTitle: async () => null,
    resolveUserIdByPhone: async (digits, opts) => { calls.resolve.push({ digits, opts }); return digits === RODZ_DIGITS ? rodzUserId : null; },
    awaitMouthMessage: (test) => new Promise((done) => { if (copyArrives) mouthWaiters.push({ test, done }); else done(null); }),
    // Nothing may look a group up by its title (operator 2026-10-18): these only record a call.
    resolveSecondaryChatIdByTitle: async (title, opts) => { calls.byTitle.push({ title, opts }); return '!byTitle'; },
    resolvePrimaryChatIdByTitle: async (title, opts) => { calls.byTitle.push({ title, opts }); return '!byTitle'; },
    // the chat's recent raw messages (Beeper's own payload shape). Opt-in, like the resolver above.
    ...(messages ? { listMessagesRaw: async (chatId) => { calls.list.push(chatId); return messages; } } : {}),
    // the group's roster read (GET /v1/chats/{id}). Opt-in, like the resolvers above.
    ...(chatRaw ? { chatRaw: async (chatId) => chatRaw(chatId) } : {}),
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    resolveConvRoom: async (_surface, chatId) => rooms.get(chatId) ?? null,
    jsonlStoreRoot: STORE,
    forkBridge,
    onLog: (m) => logs.push(m),
  });
  return { cmds: { ...cmds, run: (ev) => { lastBody = String(ev?.body ?? ''); return cmds.run(ev); } }, sent, logs, calls, forkBridge, getState: () => st };
}
// A nameless /join or /split's {name}: 5 random lowercase letters/digits (2026-10-19).
const RANDOM_NAME = /^[a-z0-9]{5}$/;
const nameIn = (title, before, after = '') => title.slice(before.length, title.length - after.length);

// The transcript a /send reads M out of.
function roomWith(chatId, bodyLine = 'An@[egpt Proyecto X].wa (14:35) #M1: la respuesta elegida\n\n') {
  const m = new Map();
  const room = new TmpRoom(join(base, `conv-${chatId.replace(/\W/g, '')}`), 'proyecto-x');
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(room.transcriptPath, bodyLine, 'utf8');
  m.set(chatId, room);
  return m;
}

// ── /join is retired (operator 2026-10-25): it answers with /split and makes nothing ────────────────
describe('/join — retired: a pointer to /split, nothing made', () => {
  const EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', isSender: true, body: '/join' };

  it('/join <name> answers with /split <name>; no group, no edit, no state write (a leftover join: block is ignored)', async () => {
    const state = seedState();
    const { cmds, sent, calls, getState } = harness({ config: { ...cfg(), join: { placeholder: 'x', member_cap: 1 } }, state });
    await cmds.run({ ...EV, body: '/join parachat' });
    await cmds.run({ ...EV, msgId: 'cmd2' });
    expect(sent).toEqual([
      { chatId: C_CHAT, text: '`/join` is retired — /e split parachat makes a fork: same agents and files, its own thread.' },
      { chatId: C_CHAT, text: '`/join` is retired — /e split makes a fork: same agents and files, its own thread.' },
    ]);
    expect(calls.create).toEqual([]);
    expect(calls.edit).toEqual([]);
    expect(calls.post).toEqual([]);
    expect(getState()).toBe(state);
  });
});

// ── the shared creation mechanics, through /split ─────────────────────────────────────────────────
describe('/split — the group create: type, title, who is invited', () => {
  const EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', isSender: true, body: '/split' };

  it('creates a type:"group" titled from group_title, ONLY Rodz, NO inline messageText (the opener is a separate post)', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.run({ ...EV });
    expect(calls.create).toHaveLength(1);
    const c = calls.create[0];
    expect(c.type).toBe('group');
    expect(nameIn(c.title, 'SI+egpt ', ' de Proyecto X')).toMatch(RANDOM_NAME);   // group_title with {name}=a random name + {group}
    expect('messageText' in c).toBe(false);
    expect(c.participantIDs).toEqual([RODZ_USER_ID]);
    expect(c.accountID).toBe('whatsapp');
  });

  it('a <name> arg fills {name} in the title (and is NOT treated as a node)', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.run({ ...EV, body: '/split spoiler' });
    expect(calls.create[0].title).toBe('SI+egpt spoiler de Proyecto X');
  });

  it('group_title_prefix replaces "SI+": "" + group_title "{name}" → "/split an" makes "an"', async () => {
    const { cmds, calls } = harness({ config: { ...cfg(), group_title_prefix: '', group_title: '{name}' } });
    await cmds.run({ ...EV, body: '/split an' });
    expect(calls.create[0].title).toBe('an');
  });

  it('group_title_prefix set → that prefix; a suffix is part of group_title', async () => {
    const { cmds, calls } = harness({ config: { ...cfg(), group_title_prefix: 'EW·', group_title: '{name} ({group})' } });
    await cmds.run({ ...EV, body: '/split viaje' });
    expect(calls.create[0].title).toBe('EW·viaje (Proyecto X)');
  });

  it('placeholder + title fall back to the built-in defaults when the texts are unset', async () => {
    const { cmds, calls } = harness({ config: cfg({ texts: false }) });
    await cmds.run({ ...EV });
    const name = nameIn(calls.create[0].title, `${SIDE_GROUP_PREFIX}Proyecto X-`);
    expect(name).toMatch(RANDOM_NAME);
    expect(calls.edit[0].text).toBe(SPLIT_PLACEHOLDER_DEFAULT);
    expect(calls.create[0].title).toBe(SIDE_GROUP_PREFIX + GROUP_TITLE_DEFAULT.replace('{name}', name).replace('{group}', 'Proyecto X'));
  });

  it('Rodz unresolvable → logs only (no chat reply), creates nothing', async () => {
    const { cmds, sent, logs, calls, getState } = harness({ config: cfg({ texts: false }), rodzUserId: null });
    await cmds.run({ ...EV });
    expect(sent).toHaveLength(0);
    expect(logs.some((l) => /could not resolve Rodz/i.test(l))).toBe(true);
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT)).toBe(null);
  });

  it('participant is Rodz\'s resolved user id, resolver scoped to the chat account', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.run({ ...EV });
    expect(calls.resolve).toEqual([{ digits: RODZ_DIGITS, opts: { accountID: 'whatsapp' } }]);
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID]);
  });
});

// ── /split (REAL FORK — new conversation, diverging thread copy) ────────────────────────────────────
describe('/split — new conversation with each resident being\'s thread COPIED to a new, diverging id', () => {
  const EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', isSender: true, body: '/split' };

  it('creates a NEW conversation (own slug, NOT an alias), records parent_chat, edits placeholder from config.split', async () => {
    seedSourceThreads('e');
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.run({ ...EV });
    const st = getState();
    expect(nameIn(calls.create[0].title, 'SI+egpt ', ' de Proyecto X')).toMatch(RANDOM_NAME);
    // NOT an alias: SPLIT_CHAT is its own primary entry with its own slug
    expect(aliasTargetOf(st, 'whatsapp', SPLIT_CHAT)).toBe(null);
    const splitSlug = getContact(st, 'whatsapp', SPLIT_CHAT).slug;
    expect(splitSlug).not.toBe(getContact(st, 'whatsapp', C_CHAT).slug);
    expect(getContact(st, 'whatsapp', SPLIT_CHAT).entry.parent_chat).toBe(C_CHAT);
    expect(calls.edit).toEqual([{ chatId: C_CHAT, msgId: 'cmd1', text: PLACEHOLDER_SPLIT }]);
  });

  it('copies EACH resident being\'s thread to a NEW threadId (sessionId + cwd rewritten); the ORIGINALS are byte-unchanged', async () => {
    seedSourceThreads('e', 'wren');
    const { cmds, getState } = harness({ config: cfg(), state: seedStateBeing('e', 'wren') });
    await cmds.run({ ...EV });
    const st = getState();
    const splitFolder = slugDir('whatsapp', getContact(st, 'whatsapp', SPLIT_CHAT).slug);

    for (const being of ['e', 'wren']) {
      const newId = getBeing(st, 'whatsapp', SPLIT_CHAT, being)?.threadId;
      expect(newId, `${being} has a new split thread`).toBeTruthy();
      expect(newId).not.toBe(SRC_BY_BEING[being]);   // diverged — a new id

      // the copy lives under the NEW thread's store (projects/<split cwd dir>/<newId>.jsonl)
      const projects = join(STORE, newId, 'projects');
      const copy = readdirSync(projects).map((d) => join(projects, d, `${newId}.jsonl`)).find((p) => existsSync(p));
      expect(copy, `a <newId>.jsonl copy for ${being}`).toBeTruthy();
      const out = readFileSync(copy, 'utf8').split('\n');
      const r0 = JSON.parse(out[0]);
      expect(r0.sessionId).toBe(newId);          // the copy IS the new session
      expect(r0.cwd).toBe(splitFolder);          // and points at the split's own folder
      expect(r0.uuid).toBe('u1');
      expect(out[1]).toBe('not-json: a stray line claude sometimes writes');   // non-JSON verbatim
      const r2 = JSON.parse(out[2]);
      expect(r2.sessionId).toBe(newId);
      expect('cwd' in r2).toBe(false);           // cwd NOT added where it was absent

      // the ORIGINAL jsonl is byte-unchanged and C's thread record is untouched
      const srcPath = join(STORE, SRC_BY_BEING[being], 'projects', 'C--orig', `${SRC_BY_BEING[being]}.jsonl`);
      expect(readFileSync(srcPath, 'utf8')).toBe(srcLines(SRC_BY_BEING[being]));
      expect(getBeing(st, 'whatsapp', C_CHAT, being)?.threadId).toBe(SRC_BY_BEING[being]);
    }
  });

  it('an existing dest is refused (EEXIST from flag:wx) — the group + conversation still register, nothing clobbered', async () => {
    seedSourceThreads('e');
    const io = { writeFile: async () => { const e = new Error('file already exists'); e.code = 'EEXIST'; throw e; } };
    let st = seedState();
    const forkBridge = {
      editMessage: async () => true,
      createGroup: async () => ({ success: true, chatID: SPLIT_CHAT_FULL }),
      postReply: async () => ({ ok: true }), archiveChat: async () => true,
      chatAccountId: async () => 'whatsapp', chatTitle: async () => null,
      resolveUserIdByPhone: async () => RODZ_USER_ID,
    };
    const logs = [];
    const cmds = createCommands({
      getConfig: () => cfg(), send: async () => {},
      loadState: async () => st, writeState: async (s) => { st = s; },
      resolveConvRoom: async () => null, jsonlStoreRoot: STORE, forkBridge, io, onLog: (m) => logs.push(m),
    });
    await cmds.run({ ...EV });
    expect(logs.some((l) => /thread copy for e.*failed/i.test(l))).toBe(true);
    expect(getBeing(st, 'whatsapp', SPLIT_CHAT, 'e')?.threadId).toBeTruthy();   // thread id recorded anyway
    expect(getContact(st, 'whatsapp', SPLIT_CHAT).entry.parent_chat).toBe(C_CHAT);
  });

  it('node_role picks nothing (2026-10-19): a node_role secondary runs /split, `/split do` included (a node name is no override)', async () => {
    for (const body of ['/split', '/split do']) {
      seedSourceThreads('e');
      const dolly = harness({ config: cfg({ node_name: 'do', node_role: 'secondary' }) });
      await dolly.cmds.run({ ...EV, body });
      expect(dolly.calls.create, body).toHaveLength(1);
    }
  });
});

// ── the other node links a /split from its opener (2026-10-19): /split's own copy, its own residents ──
describe('linkSideGroup — a /split opener on the other node forks THIS node\'s residents through /split\'s copy', () => {
  it('REPRODUCE: its own conversation with parent_chat; each resident\'s thread copied to a new id (sessionId + cwd rewritten); nothing created', async () => {
    seedSourceThreads('e', 'wren');
    const { cmds, calls, getState } = harness({ config: cfg({ node_name: 'do', node_role: 'secondary' }), state: seedStateBeing('e', 'wren'), copyArrives: false });
    await cmds.linkSideGroup({ chatId: SPLIT_CHAT, surface: 'whatsapp', chatName: 'SI+egpt split de Proyecto X', fromNode: 'kg', canary: { group: SPLIT_CHAT, origin: C_CHAT, kind: 'split', transcript: null } });
    const st = getState();
    const split = getContact(st, 'whatsapp', SPLIT_CHAT);
    expect(split.jid).toBe(SPLIT_CHAT);
    expect(split.entry.parent_chat).toBe(C_CHAT);
    const splitFolder = slugDir('whatsapp', split.slug);
    for (const being of ['e', 'wren']) {
      const newId = getBeing(st, 'whatsapp', SPLIT_CHAT, being)?.threadId;
      expect(newId).toBeTruthy();
      expect(newId).not.toBe(SRC_BY_BEING[being]);
      const projects = join(STORE, newId, 'projects');
      const copy = readdirSync(projects).map((d) => join(projects, d, `${newId}.jsonl`)).find((p) => existsSync(p));
      const r0 = JSON.parse(readFileSync(copy, 'utf8').split('\n')[0]);
      expect([r0.sessionId, r0.cwd]).toEqual([newId, splitFolder]);
      expect(getBeing(st, 'whatsapp', C_CHAT, being)?.threadId).toBe(SRC_BY_BEING[being]);
    }
    expect(calls.create).toEqual([]);
    expect(calls.post).toEqual([]);
  });
});

//// ── the OPENER (posted by the primary so the empty group surfaces in Beeper) ───────────────────────────
// Rodz's copy of it names Rodz's own room for the group: stored as its mouth_chat, by id, never by title.
describe('opener — posted into the new group by the primary; Rodz\'s copy gives the mouth room', () => {
  const SPLIT_EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', isSender: true, body: '/split' };

  it('/split posts config.split.opener into the new group from the primary; its own entry gets the mouth room', async () => {
    seedSourceThreads('e');
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.run({ ...SPLIT_EV });
    expect(calls.post).toEqual([{ chatId: SPLIT_CHAT, text: '🍴 bifurcación de Proyecto X', replyToMessageID: null, via: 'primary', canary: { group: SPLIT_CHAT, origin: C_CHAT, kind: 'split', transcript: null } }]);
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT).entry.mouth_chat).toBe(SEC_SPLIT_ROOM);
    expect(calls.byTitle).toEqual([]);
  });

  it('Rodz\'s copy never arrives: no mouth room is stored and it is logged; the group stands', async () => {
    const { cmds, calls, logs, getState } = harness({ config: cfg(), copyArrives: false });
    await cmds.run({ ...SPLIT_EV });
    expect(calls.post).toHaveLength(1);
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT).entry).toMatchObject({ parent_chat: C_CHAT });
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT).entry.mouth_chat).toBeUndefined();
    expect(logs.some((l) => /did not arrive/.test(l))).toBe(true);
  });

  it('a FAILING opener post does NOT abort /split — the conversation is written and the placeholder edited', async () => {
    const { cmds, calls, getState } = harness({ config: cfg(), throwOnPost: true });
    await cmds.run({ ...SPLIT_EV });
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT).entry.parent_chat).toBe(C_CHAT);           // conversation intact
    expect(calls.edit).toEqual([{ chatId: C_CHAT, msgId: 'cmd1', text: PLACEHOLDER_SPLIT }]);         // placeholder intact
    expect(calls.post).toHaveLength(1);                                                               // it tried and threw — swallowed, no re-throw
  });

  it('opener falls back to the built-in DEFAULT when config unset ({group} still filled)', async () => {
    seedSourceThreads('e');
    const s = harness({ config: cfg({ texts: false }) });
    await s.cmds.run({ ...SPLIT_EV });
    expect(s.calls.post).toEqual([{ chatId: SPLIT_CHAT, text: SPLIT_OPENER_DEFAULT.replace('{group}', 'Proyecto X').replaceAll('{handle}', 'e'), replyToMessageID: null, via: 'primary', canary: { group: SPLIT_CHAT, origin: C_CHAT, kind: 'split', transcript: null } }]);
  });
});

// ── side-room titles: nothing finds a group by its title (operator 2026-10-18), so a title may repeat ──
describe('side-room titles — used as given; a repeated title is fine, each group is known by its id', () => {
  const SPLIT_EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', isSender: true, body: '/split' };
  const BASE_SPLIT = 'SI+egpt viaje de Proyecto X';                     // group_title with {name}=viaje

  it('/split viaje twice: the same title twice, no suffix; each opener goes to its own group by id', async () => {
    let n = 0;
    const createChatId = () => (++n === 1 ? SPLIT_CHAT_FULL : '!chatSplit2:beeper.local');
    const { cmds, calls, getState } = harness({ config: cfg(), createChatId });
    await cmds.run({ ...SPLIT_EV, body: '/split viaje' });
    await cmds.run({ ...SPLIT_EV, msgId: 'cmd2', body: '/split viaje' });
    expect(calls.create.map((c) => c.title)).toEqual([BASE_SPLIT, BASE_SPLIT]);
    const second = shortChatId('!chatSplit2:beeper.local');
    expect(calls.post.map((p) => p.chatId)).toEqual([SPLIT_CHAT, second]);
    expect(getState().contacts.whatsapp[second]).toBeTruthy();
    expect(calls.byTitle).toEqual([]);
  });

  it('split.default_name is retired (2026-10-19): ignored; a nameless /split gets a fresh random name', async () => {
    seedSourceThreads('e');
    const sc = cfg(); sc.split = { ...sc.split, default_name: 'splitty' };
    const s = harness({ config: sc });
    await s.cmds.run({ ...SPLIT_EV });
    expect(nameIn(s.calls.create[0].title, 'SI+egpt ', ' de Proyecto X')).toMatch(RANDOM_NAME);
  });
});

// ── /split from C's members (operator 2026-10-18): anyone in a GROUP C may run it ────────────────────
describe('/split — the member gate', () => {
  const MEMBER = '@whatsapp_lid-777000:beeper.local';
  const memberSplit = (body, over = {}) => ({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'm7', chatName: 'Proyecto X', senderId: MEMBER, senderName: 'Emely', isSender: false, authorized: false, raw: { chatType: 'group' }, body, ...over });

  it('isCommand admits /split /send /end from any sender (each handler gates it); /join and /agents verbs do not', async () => {
    const { cmds } = harness({ config: cfg() });
    const admitted = (body) => cmds.isCommand(cmds.commandOf(memberSplit(body)) ?? memberSplit(body));
    for (const body of ['/e split x', '/e send', '/e end']) expect(await admitted(body), body).toBe(true);
    for (const body of ['/e join emely', '/e agents rethread e', '/e agents reset e', '/e agents mode on e', '/e splitx', '/split emely']) {
      expect(await admitted(body), body).toBe(false);
    }
  });

  it('a member: the primary creates the group with Rodz and them in it; the opener is their answer (nothing said in C)', async () => {
    const { cmds, calls, sent } = harness({ config: cfg() });
    await cmds.run(memberSplit('/split emely'));
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ participantIDs: [RODZ_USER_ID, MEMBER], via: 'primary' });
    expect(calls.edit).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it('a member no resident being would answer (allowed_users) may /split too: anyone in the group', async () => {
    const c = { ...cfg(), agents: { e: { conversation_defaults: { allowed_users: ['@someone-else:beeper.local'] } } } };
    const { cmds, calls } = harness({ config: c });
    await cmds.run(memberSplit('/split emely'));
    expect(calls.create).toHaveLength(1);
  });

  it('the conversation tier wins: a per-conversation allowed_users naming the member lets them in', async () => {
    const c = { ...cfg(), agents: { e: { conversation_defaults: { allowed_users: ['@someone-else:beeper.local'] } } } };
    const st = patchBeing(seedState(), 'whatsapp', C_CHAT, 'e', { allowed_users: [MEMBER] });
    const { cmds, calls } = harness({ config: c, state: st });
    await cmds.run(memberSplit('/split emely'));
    expect(calls.create).toHaveLength(1);
  });

  it('a conversation whose own agent denies a stranger: they may still /split (membership is the gate)', async () => {
    const c = { ...cfg(), agents: { e: {}, mk: {} } };
    const st = patchBeing(seedState(), 'whatsapp', C_CHAT, 'mk', { default: true, allowed_users: [] });
    const { cmds, calls } = harness({ config: c, state: st });
    await cmds.run(memberSplit('/split emely'));
    expect(calls.create).toHaveLength(1);
  });

  it('not widened in a 1:1: the other party of a private chat cannot /split', async () => {
    const { cmds, calls, sent } = harness({ config: cfg() });
    await cmds.run(memberSplit('/split emely', { raw: { chatType: 'private' } }));
    expect(calls.create).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('a member whose id cannot be invited (not a bridged :beeper.local id) is told so; nothing created', async () => {
    const { cmds, calls, sent } = harness({ config: cfg() });
    await cmds.run(memberSplit('/split emely', { senderId: '@someone:beeper.com' }));
    expect(calls.create).toHaveLength(0);
    expect(sent).toEqual([{ chatId: C_CHAT, text: expect.stringMatching(/can't add you/i) }]);
  });
});

// ── /send (works in both; post_back_from routes the posting account) ────────────────────────────────
describe('/send — relays the replied-to message back to the original (alias OR recorded parent)', () => {
  it('in a /join group: posts to the alias target (primary = the original chat directly); repeatable, no close', async () => {
    const { cmds, calls, getState } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg({ send: { post_back_from: 'primary' } }) });
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true });
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].chatId).toBe(C_CHAT);
    expect(calls.post[0].via).toBe('primary');
    expect(calls.post[0].text).toBe('la respuesta elegida');
    expect(calls.archive).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', JOIN_CHAT)).toBe(getContact(getState(), 'whatsapp', C_CHAT).jid);
  });

  // Both nodes hold the group once the other links it from the opener; the handle picks which one
  // runs /send (2026-10-19), so a node_role secondary relays it like any node.
  it('on the node_role secondary node holding the same linked group, /send relays to the original', async () => {
    for (const state of [stateWithJoin(), stateWithSplit()]) {
      const chatId = state.contacts.whatsapp[JOIN_CHAT] ? JOIN_CHAT : SPLIT_CHAT;
      const { cmds, calls } = harness({ state, rooms: roomWith(chatId), config: cfg({ node_name: 'do', node_role: 'secondary' }) });
      await cmds.run({ chatId, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true });
      expect(calls.post.map((p) => p.chatId), chatId).toEqual([C_CHAT]);
    }
  });

  it('REPRODUCE-FIRST: the relay requests an UNSIGNED post (unsigned:true) so it lands as the operator, with no node signature', async () => {
    const { cmds, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg({ send: { post_back_from: 'primary' } }) });
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true });
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].unsigned).toBe(true);   // routed INTO the existing send path with the unsigned flag
  });

  it('in a /split group: posts to the recorded parent_chat (primary = directly)', async () => {
    const { cmds, calls } = harness({ state: stateWithSplit(), rooms: roomWith(SPLIT_CHAT), config: cfg({ send: { post_back_from: 'primary' } }) });
    await cmds.run({ chatId: SPLIT_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true });
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].chatId).toBe(C_CHAT);
    expect(calls.post[0].text).toBe('↪ from egpt split Proyecto X:\nla respuesta elegida');   // send.origin auto names the split
  });

  it('post_back_from secondary: hands the ORIGINAL\'s own id to the mouth (boot finds Rodz\'s room by id) — no lookup by title', async () => {
    const { cmds, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg({ send: { post_back_from: 'secondary' } }) });
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true });
    expect(calls.post[0]).toMatchObject({ chatId: C_CHAT, via: 'secondary' });
    expect(calls.byTitle).toEqual([]);
  });

  it('post_back_from: primary (default, operator 2026-10-04) routes via the operator; secondary routes via the mouth', async () => {
    const def = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg() });              // unset → primary
    await def.cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 's', replyToId: 'M1', body: '/send', isSender: true });
    expect(def.calls.post[0].via).toBe('primary');
    expect(def.calls.post[0].chatId).toBe(C_CHAT);                                                            // primary posts into the original directly

    const sec = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg({ send: { post_back_from: 'secondary' } }) });
    await sec.cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 's', replyToId: 'M1', body: '/send', isSender: true });
    expect(sec.calls.post[0].via).toBe('secondary');

    const prim = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg({ send: { post_back_from: 'primary' } }) });
    await prim.cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 's', replyToId: 'M1', body: '/send', isSender: true });
    expect(prim.calls.post[0].via).toBe('primary');
  });

  it('SILENT outside a join/split group (no alias, no parent) → nothing posted/sent', async () => {
    const { cmds, sent, calls } = harness({ state: seedState(), rooms: roomWith(C_CHAT), config: cfg() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true });
    expect(sent).toHaveLength(0);
    expect(calls.post).toHaveLength(0);
  });

  it('in a group but no reply target → an error, nothing posted', async () => {
    const { cmds, sent, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg() });
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: null, body: '/send', isSender: true });
    expect(sent[0].text).toMatch(/reply to a message with \/e send/i);
    expect(calls.post).toHaveLength(0);
  });
});

// ── /send relays the CURRENT text of an EDITED message, cleaned (operator 2026-10-04 live bug) ────────
// A being's reply is delivered by EDITING a "⏳ Thinking…" placeholder in place; a co-account peer
// records the placeholder as the `#<id>:` entry and the settled text as a SEPARATE `edited #<id>`
// stage-direction. The live bug: /send relayed the stale placeholder (bodyForMessageId returned the
// entry body, blind to the edit) AND, had it found the right body, it was the round-tripped
// "🐶 E: <text> 🏰<kg>" form whose INLINE persona stamp cleanQuotedBody did not strip. Both are fixed:
// bodyForMessageId is edit-aware (transcript-log.mjs) and stripPersonaStampHeader strips a leading
// inline "<stamp>: " (commands.mjs). The transcript carries config.agents' stamp + bridge close.
describe('/send — edited-placeholder + inline-stamp cleaning (the end-to-end fix)', () => {
  // cfg + the two keys the cleaning reads: the agent stamp set (body_emoji + name) and the bridge close.
  const sendCfg = () => ({ ...cfg({ send: { post_back_from: 'primary' } }), agents: { egpt: { body_emoji: '🐶', name: 'E' } }, bridge_signature_close: '🏰' });
  const EV = { chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', body: '/send', isSender: true };
  // The EXACT live shape: a placeholder entry #21005 then its settled poem as an `edited #21005` block
  // (its `+` side round-trips the persona stamp + signature + the stage-direction's trailing ` ]`).
  const EDITED_TRANSCRIPT = [
    'Rodz@[SPOILER ALERT: chat de EyAy-caro].wa (11:46) #21005: 🐶 E: ⏳ Thinking… 🏰<kg>', '',
    '[ Rodz@[SPOILER ALERT: chat de EyAy-caro].wa (11:46): edited #21005',
    '    - 🐶 E: ⏳ Thinking… 🏰<kg>',
    '    + 🐶 E: Carolina, tu nombre es un verano, porque a tu lado hasta la luz se asombra. 🏰<kg> ]', '',
  ].join('\n');

  it('REPRODUCE-FIRST: relays the FINAL poem (edit-aware), stamp + signature + inline bridge close all stripped — NOT the "⏳ Thinking…" placeholder', async () => {
    const { cmds, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, EDITED_TRANSCRIPT), config: sendCfg() });
    await cmds.run({ ...EV, replyToId: '21005' });
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].text).not.toContain('Thinking');     // not the placeholder (edit-awareness)
    expect(calls.post[0].text.startsWith('🐶 E')).toBe(false); // inline persona stamp stripped
    // "no body emoji, no SIGNATURE" (operator): the stamp, the rendered <kg>, AND the inline
    // bridge_signature_close 🏰 are all gone — exactly the reply, nothing else.
    expect(calls.post[0].text).toBe('Carolina, tu nombre es un verano, porque a tu lado hasta la luz se asombra.');
    expect(calls.post[0].text).not.toMatch(/🏰/);
    expect(calls.post[0].text).not.toMatch(/<kg>/);
  });

  it('a one-line reply with an inline stamp and NO signature cleans to exactly the reply', async () => {
    const t = 'Rodz@[x].wa (12:00) #M2: 🐶 E: hola mundo\n\n';
    const { cmds, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, t), config: sendCfg() });
    await cmds.run({ ...EV, replyToId: 'M2' });
    expect(calls.post[0].text).toBe('hola mundo');
  });

  it('REGRESSION (stripBridgeClose): own-line close still stripped; no close untouched; an UNRELATED trailing emoji is left', async () => {
    // a close on its OWN line (the legacy multi-line shape) is still removed by the whole-line match
    const ownLine = 'Rodz@[x].wa (12:20) #M5: hola de la sala\n🏰\n\n';
    const a = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, ownLine), config: sendCfg() });
    await a.cmds.run({ ...EV, replyToId: 'M5' });
    expect(a.calls.post[0].text).toBe('hola de la sala');

    // a body with NO close token is untouched
    const noClose = 'Rodz@[x].wa (12:25) #M6: just text, no close\n\n';
    const b = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, noClose), config: sendCfg() });
    await b.cmds.run({ ...EV, replyToId: 'M6' });
    expect(b.calls.post[0].text).toBe('just text, no close');

    // a trailing emoji that is NOT the configured close (✅ vs 🏰) is left verbatim — only the exact
    // configured close token is stripped off the tail, never a guess at "any trailing emoji"
    const otherEmoji = 'Rodz@[x].wa (12:30) #M7: listo ✅\n\n';
    const c = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, otherEmoji), config: sendCfg() });
    await c.cmds.run({ ...EV, replyToId: 'M7' });
    expect(c.calls.post[0].text).toBe('listo ✅');
  });

  it('REGRESSION: a non-configured emoji prefix is untouched; a standalone stamp LINE is still removed', async () => {
    // "🐶 Carol:" is NOT a configured stamp (the agent name is "E"), so it is left verbatim — only an
    // EXACT configured stamp is stripped, never a pattern-guess at emoji+word+colon.
    const notAStamp = 'Rodz@[x].wa (12:05) #M3: 🐶 Carol: hey there\n\n';
    const a = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, notAStamp), config: sendCfg() });
    await a.cmds.run({ ...EV, replyToId: 'M3' });
    expect(a.calls.post[0].text).toBe('🐶 Carol: hey there');

    // a whole-LINE stamp (the standalone-header form) is still removed as before
    const standalone = 'Rodz@[x].wa (12:10) #M4: 🐶 E\nhola de nuevo\n\n';
    const b = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, standalone), config: sendCfg() });
    await b.cmds.run({ ...EV, replyToId: 'M4' });
    expect(b.calls.post[0].text).toBe('hola de nuevo');
  });
});

// ── /send keeps the message's paragraphs (2026-10-11 live bug, -super room → SPOILER) ───────────────
// E's reply lands by editing its "⏳ Thinking…" placeholder, so the transcript holds its text only as
// editAction's flattened `+` line. The relay must come from the chat's own copy of the message.
describe('/send — relays the live message, line breaks intact', () => {
  const sendCfg = () => ({ ...cfg({ send: { post_back_from: 'primary' } }), agents: { egpt: { body_emoji: '🐶', name: 'E' } }, bridge_signature_close: '🏰' });
  const EV = { chatId: JOIN_CHAT, surface: 'whatsapp', msgId: '26881', body: '/send', isSender: true };
  const CHAT = 'SPOILER ALERT: chat de EyAy-super 1457-10112026';
  const FLAT = '🐶 E: ¡Qué lindo, Caro! Te dejo un texto listo para reenviar 👇 📚 *Este miércoles 14 de octubre, 18 h*, presento *Yo te cielo* junto a otras cuatro autoras de Metrópolis, en un encuentro íntimo para conversar, narrar y compartirnos. 📍 Casa PAM!, Aguirre 130, Villa Crespo (CABA) Me encantaría verles ahí. Traigan a quien quieran 💙 Si me dices el tono que buscas, más formal o más canchero, o si es para Instagram, lo adapto. 🏰<kg>';
  const TRANSCRIPT = [
    `Rodz@[${CHAT}].wa (15:09) #26875: 🐶 E: ⏳ Thinking… 🏰<kg>`, '',
    `[ Rodz@[${CHAT}].wa (15:09): edited #26875`,
    '    - 🐶 E: ⏳ Thinking… 🏰<kg>',
    `    + ${FLAT} ]`, '',
  ].join('\n');
  // Beeper's payload for #26875, verbatim (GET /v1/chats/{c}/messages): HTML, close + invisible node frame.
  const LIVE = {
    id: '26875', senderName: 'Rodz', type: 'TEXT', isSender: false,
    text: '🐶 E: ¡Qué lindo, Caro! Te dejo un texto listo para reenviar 👇<br><br>📚 <em>Este miércoles 14 de octubre, 18 h</em>, presento <em>Yo te cielo</em> junto a otras cuatro autoras de Metrópolis, en un encuentro íntimo para conversar, narrar y compartirnos.<br>📍 Casa PAM!, Aguirre 130, Villa Crespo (CABA)<br>Me encantaría verles ahí. Traigan a quien quieran 💙<br><br>Si me dices el tono que buscas, más formal o más canchero, o si es para Instagram, lo adapto. 🏰'
      + encodeNodeSignature('kg', 'egpt'),
  };

  it('REPRODUCE-FIRST: paragraphs, single breaks, italics and emoji survive; stamp, close and node frame stripped', async () => {
    const { cmds, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, TRANSCRIPT), config: sendCfg(), messages: [{ id: '26874', text: 'x' }, LIVE] });
    await cmds.run({ ...EV, replyToId: '26875' });
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].text).toBe([
      '¡Qué lindo, Caro! Te dejo un texto listo para reenviar 👇',
      '',
      '📚 *Este miércoles 14 de octubre, 18 h*, presento *Yo te cielo* junto a otras cuatro autoras de Metrópolis, en un encuentro íntimo para conversar, narrar y compartirnos.',
      '📍 Casa PAM!, Aguirre 130, Villa Crespo (CABA)',
      'Me encantaría verles ahí. Traigan a quien quieran 💙',
      '',
      'Si me dices el tono que buscas, más formal o más canchero, o si es para Instagram, lo adapto.',
    ].join('\n'));
    expect(calls.list).toEqual([JOIN_CHAT]);   // read on the side-room's own account, where #26875 is its id
  });

  it('a message no longer in the chat\'s recent list still relays from the transcript, cleaned as before', async () => {
    const { cmds, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT, TRANSCRIPT), config: sendCfg(), messages: [{ id: '26874', text: 'x' }] });
    await cmds.run({ ...EV, replyToId: '26875' });
    expect(calls.post[0].text).toBe(FLAT.replace('🐶 E: ', '').replace(' 🏰<kg>', ''));
  });
});

// ── /send names the side group it came from (config.send.origin, 2026-10-16) ───────────────────────
describe('/send — origin prefix (send.origin auto|always|never, send.origin_template)', () => {
  const originCfg = (send = {}) => ({ ...cfg({ send }), group_title: '{group}-{name}' });
  const inC = (body, over = {}) => ({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'EduWeb', senderName: 'An', isSender: true, authorized: true, raw: { chatType: 'group' }, body, ...over });
  const sendFrom = (chatId, over = {}) => ({ chatId, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true, ...over });
  const relayed = (calls) => calls.post.filter((p) => p.chatId === C_CHAT);

  // An existing /join room "SI+EduWeb-nue11", as /join stored it. discreet: what a retired phrase trigger stored (still read).
  async function joined({ send, discreet = false } = {}) {
    const state = stateWithJoin({ transcript: 'SI+EduWeb-nue11', join_name: 'nue11', join_by: 'An', ...(discreet ? { discreet: true } : {}) });
    return harness({ config: originCfg(send), state, rooms: roomWith(JOIN_CHAT) });
  }
  async function splitted({ send, discreet = false } = {}) {
    const h = harness({ config: originCfg(send), rooms: roomWith(SPLIT_CHAT), createChatId: () => SPLIT_CHAT_FULL });
    await h.cmds.run(inC('/split nue11'));
    if (discreet) getContact(h.getState(), 'whatsapp', SPLIT_CHAT).entry.discreet = true;
    return h;
  }

  it('an existing /join room nue11: the relay starts with "↪ from SI+EduWeb-nue11:" (title from the stored alias)', async () => {
    const { cmds, calls } = await joined();
    await cmds.run(sendFrom(JOIN_CHAT));
    expect(relayed(calls)).toHaveLength(1);
    expect(relayed(calls)[0].text).toBe('↪ from SI+EduWeb-nue11:\nla respuesta elegida');
  });

  it('the live chat name wins over the stored title', async () => {
    const { cmds, calls } = await joined();
    await cmds.run(sendFrom(JOIN_CHAT, { chatName: 'renamed room' }));
    expect(relayed(calls)[0].text).toBe('↪ from renamed room:\nla respuesta elegida');
  });

  it('a legacy discreet /join room (discreet: true): origin auto adds no prefix', async () => {
    const { cmds, calls } = await joined({ discreet: true });
    await cmds.run(sendFrom(JOIN_CHAT));
    expect(relayed(calls)[0].text).toBe('la respuesta elegida');
  });

  it('origin never: no prefix', async () => {
    const { cmds, calls } = await joined({ send: { origin: 'never' } });
    await cmds.run(sendFrom(JOIN_CHAT));
    expect(relayed(calls)[0].text).toBe('la respuesta elegida');
  });

  it('origin always: prefix even when discreet', async () => {
    const { cmds, calls } = await joined({ send: { origin: 'always' }, discreet: true });
    await cmds.run(sendFrom(JOIN_CHAT));
    expect(relayed(calls)[0].text).toBe('↪ from SI+EduWeb-nue11:\nla respuesta elegida');
  });

  it('an empty origin_template: no prefix', async () => {
    const { cmds, calls } = await joined({ send: { origin: 'always', origin_template: '' } });
    await cmds.run(sendFrom(JOIN_CHAT));
    expect(relayed(calls)[0].text).toBe('la respuesta elegida');
  });

  it('a custom origin_template fills {group}; an invalid origin falls back to auto', async () => {
    const { cmds, calls } = await joined({ send: { origin: 'sometimes', origin_template: '[{group}] ' } });
    await cmds.run(sendFrom(JOIN_CHAT));
    expect(relayed(calls)[0].text).toBe('[SI+EduWeb-nue11] la respuesta elegida');
  });

  it('a normal /split: prefixed with the split group\'s title', async () => {
    const { cmds, calls, getState } = await splitted();
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT).entry.discreet).toBeUndefined();
    await cmds.run(sendFrom(SPLIT_CHAT));
    expect(relayed(calls)[0].text).toBe('↪ from SI+EduWeb-nue11:\nla respuesta elegida');
  });

  it('a legacy discreet /split room (discreet: true beside parent_chat): auto adds no prefix', async () => {
    const { cmds, calls, getState } = await splitted({ discreet: true });
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT).entry).toMatchObject({ parent_chat: C_CHAT, discreet: true });
    await cmds.run(sendFrom(SPLIT_CHAT));
    expect(relayed(calls)[0].text).toBe('la respuesta elegida');
  });

  it('a room made before the flag: a random token in the title\'s {name} slot reads as discreet', async () => {
    const legacy = (transcript) => {
      const st = seedState();
      return aliasContact(st, 'whatsapp', JOIN_CHAT, getContact(st, 'whatsapp', C_CHAT).jid, { transcript });
    };
    const a = harness({ config: originCfg(), state: legacy('SI+EduWeb-3fa9c'), rooms: roomWith(JOIN_CHAT) });
    await a.cmds.run(sendFrom(JOIN_CHAT));
    expect(a.calls.post[0].text).toBe('la respuesta elegida');
    const b = harness({ config: originCfg(), state: legacy('SI+EduWeb-3fa9c 1048-10042026'), rooms: roomWith(JOIN_CHAT) });
    await b.cmds.run(sendFrom(JOIN_CHAT));
    expect(b.calls.post[0].text).toBe('la respuesta elegida');
    const c = harness({ config: originCfg(), state: legacy('SI+EduWeb-emely'), rooms: roomWith(JOIN_CHAT) });
    await c.cmds.run(sendFrom(JOIN_CHAT));
    expect(c.calls.post[0].text).toBe('↪ from SI+EduWeb-emely:\nla respuesta elegida');
  });

  it('no title anywhere: no prefix', async () => {
    const { cmds, calls } = harness({ config: originCfg(), state: stateWithJoin(), rooms: roomWith(JOIN_CHAT) });
    await cmds.run(sendFrom(JOIN_CHAT));
    expect(calls.post[0].text).toBe('la respuesta elegida');
  });
});

// ── /end (both kinds; posts nothing) ────────────────────────────────────────────────────────────────
describe('/end — archives the group and drops its mapping, posting nothing', () => {
  it('a /join group: archives, drops the alias, sends NOTHING; a second /end is inert', async () => {
    const { cmds, sent, calls, getState } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg() });
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'end1', body: '/end' });
    expect(calls.archive).toEqual([{ chatId: JOIN_CHAT }]);
    expect(sent).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', JOIN_CHAT)).toBe(null);
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'end2', body: '/end' });
    expect(calls.archive).toHaveLength(1);
  });

  it('a /split group: archives and retires the split conversation\'s mapping (parent_chat), posts nothing', async () => {
    const { cmds, sent, calls, getState } = harness({ state: stateWithSplit(), rooms: roomWith(SPLIT_CHAT), config: cfg() });
    await cmds.run({ chatId: SPLIT_CHAT, surface: 'whatsapp', msgId: 'end1', body: '/end' });
    expect(calls.archive).toEqual([{ chatId: SPLIT_CHAT }]);
    expect(sent).toHaveLength(0);
    expect(getContact(getState(), 'whatsapp', SPLIT_CHAT)).toBeFalsy();   // mapping dropped
  });

  it('SILENT outside a join/split group → nothing archived, nothing sent', async () => {
    const { cmds, sent, calls } = harness({ state: seedState(), rooms: roomWith(C_CHAT), config: cfg() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'end1', body: '/end' });
    expect(sent).toHaveLength(0);
    expect(calls.archive).toHaveLength(0);
  });
});

// ── the phrase triggers are gone (operator 2026-10-19: config/commands_alias.yaml replaced them) ──────
describe('no phrase triggers: a command is its "/"-form or an alias (commands-alias.test.mjs)', () => {
  it('a leftover config.join.triggers phrase is an ordinary message; the module has no phrase entry point', async () => {
    const { cmds, calls } = harness({ config: { ...cfg(), join: { triggers: ['dame un segundo'] } } });
    const ev = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', authorized: true, isSender: true, body: 'dame un segundo' };
    expect(await cmds.isCommand(ev)).toBe(false);
    expect(cmds.phraseCommand).toBeUndefined();
    expect(cmds.runPhrase).toBeUndefined();
    expect(calls.create).toEqual([]);
  });

  it('SEND_POST_BACK_FROM_DEFAULT is primary (PART A)', () => {
    expect(SEND_POST_BACK_FROM_DEFAULT).toBe('primary');
  });
});

// ── restart safety ────────────────────────────────────────────────────────────────────────────────
describe('restart safety — the mappings survive a reload', () => {
  it('an existing /join alias round-trips through the real readState/writeState', async () => {
    const yamlPath = join(base, 'conversations.yaml');
    await writeConvState(yamlPath, stateWithJoin());
    const reloaded = await readConvState(yamlPath);
    const primaryJid = getContact(reloaded, 'whatsapp', C_CHAT).jid;
    expect(aliasTargetOf(reloaded, 'whatsapp', JOIN_CHAT)).toBe(primaryJid);
    expect(getContact(reloaded, 'whatsapp', JOIN_CHAT).slug).toBe(getContact(reloaded, 'whatsapp', C_CHAT).slug);
  });

  it('a /split parent_chat + diverging thread round-trip through the real readState/writeState', async () => {
    const yamlPath = join(base, 'conversations.yaml');
    await writeConvState(yamlPath, stateWithSplit());
    const reloaded = await readConvState(yamlPath);
    expect(getContact(reloaded, 'whatsapp', SPLIT_CHAT).entry.parent_chat).toBe(C_CHAT);
    expect(getBeing(reloaded, 'whatsapp', SPLIT_CHAT, 'e').threadId).toBe('split-thread-e');
    expect(aliasTargetOf(reloaded, 'whatsapp', SPLIT_CHAT)).toBe(null);   // NOT an alias
  });
});

// ── the ensureContact alias guard (a group message never renames the primary it aliases) ────────────
describe('ensureContact — an alias never renames its primary (so /join\'s two chats share ONE folder)', () => {
  it('a message on the aliased /join chat (its own group title) does not re-slug the original', async () => {
    const st0 = stateWithJoin();
    const origSlug = getContact(st0, 'whatsapp', C_CHAT).slug;
    // the fork group's own title arrives as a pushedName on the ALIAS jid — must NOT rename the primary
    const after = ensureContact(st0, 'whatsapp', JOIN_CHAT, { pushedName: 'egpt join de Proyecto X' }).state;
    expect(getContact(after, 'whatsapp', C_CHAT).slug).toBe(origSlug);
    expect(getContact(after, 'whatsapp', JOIN_CHAT).slug).toBe(origSlug);   // still the shared folder
  });
});

// ── the general per-conversation allowed_paths plumbing (kept; no longer written by /join) ──────────
describe('resolveBeingDef merges a per-conversation allowed_paths as a READ-ONLY share path', () => {
  it('a conv allowed_paths grant with no write tools becomes a read-only (not writable) share path', () => {
    const def = resolveBeingDef('e', 'C:/conv', {
      getConfig: () => ({}),
      convAllowedPaths: { 'C:/the/original/folder': { allowed_tools: ['Read', 'Glob', 'Grep'] } },
    });
    const { readOnly, writable } = sandboxSharePathsFor(def);
    expect(readOnly).toHaveLength(1);
    expect(readOnly[0].toLowerCase()).toContain('original');
    expect(writable).not.toContain(readOnly[0]);
  });

  it('no convAllowedPaths ⇒ byte-identical (no extra share paths from this seam)', () => {
    const def = resolveBeingDef('e', 'C:/conv', { getConfig: () => ({}) });
    const { readOnly } = sandboxSharePathsFor(def);
    expect(readOnly).toHaveLength(0);
  });
});

// ── the split-copy transform (pure) ─────────────────────────────────────────────────────────────────
describe('rewriteForkSessionJsonl — sessionId + cwd rewrite, non-JSON verbatim', () => {
  it('rewrites sessionId and cwd where present, leaves other fields, passes non-JSON through, keeps the trailing blank', () => {
    const raw = [
      JSON.stringify({ type: 'user', sessionId: 'OLD', cwd: 'C:/orig', uuid: 'u1', message: { x: 1 } }),
      'garbage-not-json',
      JSON.stringify({ type: 'assistant', sessionId: 'OLD', uuid: 'u2' }),
      '',
    ].join('\n');
    const out = rewriteForkSessionJsonl(raw, { sessionId: 'NEW', cwd: 'C:/fork' }).split('\n');
    expect(JSON.parse(out[0])).toEqual({ type: 'user', sessionId: 'NEW', cwd: 'C:/fork', uuid: 'u1', message: { x: 1 } });
    expect(out[1]).toBe('garbage-not-json');
    const r2 = JSON.parse(out[2]);
    expect(r2.sessionId).toBe('NEW');
    expect('cwd' in r2).toBe(false);
    expect(out[3]).toBe('');
  });
});

// ── the Rodz resolution rule (pure) ─────────────────────────────────────────────────────────────────
describe('resolveSecondaryParticipantId — the two config.beeper phones, non-self, exactly-one-or-null', () => {
  it('returns the beeper phone that is NOT this install', () => {
    expect(resolveSecondaryParticipantId(beeperCfg(AN, RODZ), [AN])).toBe(RODZ);
    expect(resolveSecondaryParticipantId(beeperCfg(AN, RODZ), [RODZ])).toBe(AN);
  });
  it('fewer than two phones ⇒ null (refuse)', () => {
    expect(resolveSecondaryParticipantId(beeperCfg(AN, undefined), [AN])).toBe(null);
    expect(resolveSecondaryParticipantId(beeperCfg(AN, '@dolly-egpt:beeper.com'), [AN])).toBe(null);
    expect(resolveSecondaryParticipantId({}, [AN])).toBe(null);
  });
  it('no unique partner after excluding self ⇒ null', () => {
    expect(resolveSecondaryParticipantId(beeperCfg(AN, RODZ), [])).toBe(null);
    expect(resolveSecondaryParticipantId(beeperCfg(AN, AN), [])).toBe(null);
  });
  it('normalizes phone shapes (digits-only compare) when excluding self', () => {
    expect(resolveSecondaryParticipantId(beeperCfg('+1 (646) 821-7865', RODZ), ['16468217865'])).toBe(RODZ);
  });
});

// ── each template key with every variable it takes; an unknown {x} stays as written ────────────────
describe('templates — every variable of each key, today\'s exact text; the call sites pass what TEMPLATES documents', () => {
  beforeEach(() => filled.clear());
  const op = (body, over = {}) => ({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', senderName: 'An', isSender: true, raw: { chatType: 'group' }, body, ...over });
  const texts = (rest = {}) => ({ ...cfg(), group_title: '<{group}|{name}|{x}>', split: { placeholder: '{name}|{x}', opener: '{group}|{handle}|{x}' }, ...rest });
  const title = (name) => `SI+<Proyecto X|${name}|{x}>`;

  it('group_title, split.opener; split.placeholder takes {link} only', async () => {
    seedSourceThreads('e');
    const { cmds, calls } = harness({ config: texts() });
    await cmds.run(op('/split viaje'));
    expect(calls.create[0].title).toBe(title('viaje'));
    expect(calls.edit[0].text).toBe('{name}|{x}');
    expect(calls.post[0].text).toBe('Proyecto X|e|{x}');
    expect(filled.get('<{group}|{name}|{x}>')).toEqual(documented('group_title'));
    expect(filled.get('{group}|{handle}|{x}')).toEqual(documented('split.opener'));
    expect(filled.get('{name}|{x}')).toEqual(documented('split.placeholder'));
  });

  it('send.origin_template', async () => {
    const h = harness({ config: texts({ send: { origin_template: '{group}|{x} ' } }), state: stateWithJoin({ transcript: 'SI+EduWeb-nue11', join_name: 'nue11' }), rooms: roomWith(JOIN_CHAT) });
    await h.cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send', isSender: true });
    expect(h.calls.post.filter((p) => p.chatId === C_CHAT)[0].text).toBe('SI+EduWeb-nue11|{x} la respuesta elegida');
    expect(filled.get('{group}|{x} ')).toEqual(documented('send.origin_template'));
  });
});
