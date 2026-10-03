// tests/fork-command.test.mjs — /join, /split, /send and /end (operator 2026-10-03).
//
// A "fork" was always two things, now two commands:
//   /join  — SUPERPOSITION. Create a WhatsApp group (operator + Rodz, type:"group") and ALIAS its
//            chatId to this chat's conversation (conversations-state aliasOf): one shared thread, two
//            surfaces, nothing copied. A VIEW.
//   /split — REAL FORK. Create a group backed by a NEW conversation (own slug/folder/entry, NOT an
//            alias) whose resident beings' threads are COPIED under new thread ids so it DIVERGES; the
//            parent chatId is recorded on the new entry.
//   /send  — relay a replied-to message back to the original chat (alias target for /join, recorded
//            parent_chat for /split); honours config.send.post_back_from.
//   /end   — archive the group (both kinds) and drop its mapping.
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
import { createCommands, resolveSecondaryParticipantId, rewriteForkSessionJsonl, JOIN_PLACEHOLDER_DEFAULT, SPLIT_PLACEHOLDER_DEFAULT, GROUP_TITLE_DEFAULT } from '../src/spine/commands.mjs';
import { resolveBeingDef, sandboxSharePathsFor } from '../src/spine/brainpool.mjs';
import { ensureContact, recordThread, getContact, getBeing, slugDir, aliasContact, aliasTargetOf, patchContact, readState as readConvState, writeState as writeConvState } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';

const C_CHAT = '!chatC';
const JOIN_CHAT = '!chatJoin';
const SPLIT_CHAT = '!chatSplit';
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
// C as above, PLUS a /join group aliased to it — the state /join leaves behind (for /send + /end).
function stateWithJoin() {
  const st = seedState();
  const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
  return aliasContact(st, 'whatsapp', JOIN_CHAT, primaryJid);
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
const PLACEHOLDER_JOIN = '🔀 uniendo…';
const PLACEHOLDER_SPLIT = '🍴 bifurcando…';
const GROUP_TITLE = 'egpt {name} de {group}';
function cfg({ node_name = 'kg', node_role = 'primary', texts = true, send, peer_nodes } = {}) {
  return {
    ...beeperCfg(AN, RODZ), node_name, node_role,
    ...(peer_nodes ? { peer_nodes } : {}),
    ...(texts ? { group_title: GROUP_TITLE, join: { placeholder: PLACEHOLDER_JOIN }, split: { placeholder: PLACEHOLDER_SPLIT } } : {}),
    ...(send ? { send } : {}),
  };
}

function harness({ config, state, rooms = new Map(), rodzUserId = RODZ_USER_ID } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { edit: [], create: [], post: [], archive: [], resolve: [] };
  const forkBridge = {
    editMessage: async (chatId, msgId, text) => { calls.edit.push({ chatId, msgId, text }); return true; },
    createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: opts.title?.includes('split') ? SPLIT_CHAT : JOIN_CHAT }; },
    // records the via account /send chose (4th arg) so a test can assert which connection posts.
    postReply: async (chatId, text, replyToMessageID, opts = {}) => { calls.post.push({ chatId, text, replyToMessageID, via: opts.via ?? null }); return { ok: true }; },
    archiveChat: async (chatId) => { calls.archive.push({ chatId }); return true; },
    chatAccountId: async () => 'whatsapp',
    chatTitle: async () => null,
    resolveUserIdByPhone: async (digits, opts) => { calls.resolve.push({ digits, opts }); return digits === RODZ_DIGITS ? rodzUserId : null; },
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    resolveConvRoom: async (_surface, chatId) => rooms.get(chatId) ?? null,
    jsonlStoreRoot: STORE,
    defaultKey: 'e',
    forkBridge,
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, calls, forkBridge, getState: () => st };
}

// The transcript a /send reads M out of.
function roomWith(chatId, bodyLine = 'An@[egpt Proyecto X].wa (14:35) #M1: la respuesta elegida\n\n') {
  const m = new Map();
  const room = new TmpRoom(join(base, `conv-${chatId.replace(/\W/g, '')}`), 'proyecto-x');
  mkdirSync(room.baseDir(), { recursive: true });
  writeFileSync(room.transcriptPath, bodyLine, 'utf8');
  m.set(chatId, room);
  return m;
}

// ── /join (SUPERPOSITION — alias) ─────────────────────────────────────────────────────────────────
describe('/join — alias model, node_role gate', () => {
  const EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', body: '/join' };

  it('on the primary-role node with a resident being: creates a type:"group" titled from group_title, ONLY Rodz, NO opener', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.run({ ...EV });
    expect(calls.create).toHaveLength(1);
    const c = calls.create[0];
    expect(c.type).toBe('group');
    expect(c.title).toBe('egpt join de Proyecto X');   // group_title with {name}=join (default) + {group}
    expect('messageText' in c).toBe(false);
    expect(c.participantIDs).toEqual([RODZ_USER_ID]);
    expect(c.accountID).toBe('whatsapp');
  });

  it('writes a pure { aliasOf: <original> } entry and edits the /join message to config.join.placeholder', async () => {
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.run({ ...EV });
    const st = getState();
    const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
    expect(st.contacts.whatsapp[JOIN_CHAT]).toEqual({ aliasOf: primaryJid });
    expect(aliasTargetOf(st, 'whatsapp', JOIN_CHAT)).toBe(primaryJid);
    expect(getContact(st, 'whatsapp', JOIN_CHAT).slug).toBe(getContact(st, 'whatsapp', C_CHAT).slug);  // same folder
    expect(calls.edit).toEqual([{ chatId: C_CHAT, msgId: 'cmd1', text: PLACEHOLDER_JOIN }]);
  });

  it('a <name> arg fills {name} in the title (and is NOT treated as a node)', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.run({ ...EV, body: '/join spoiler' });
    expect(calls.create[0].title).toBe('egpt spoiler de Proyecto X');
  });

  it('placeholder + title fall back to the built-in defaults when the texts are unset', async () => {
    const { cmds, calls } = harness({ config: cfg({ texts: false }) });
    await cmds.run({ ...EV });
    expect(calls.edit[0].text).toBe(JOIN_PLACEHOLDER_DEFAULT);
    expect(calls.create[0].title).toBe(GROUP_TITLE_DEFAULT.replace('{name}', 'join').replace('{group}', 'Proyecto X'));
  });

  it('SILENT on a non-primary-role node (no override)', async () => {
    const { cmds, sent, calls } = harness({ config: cfg({ node_name: 'do', node_role: 'secondary' }) });
    await cmds.run({ ...EV });
    expect(calls.create).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('SILENT on the primary node when NO being resides here', async () => {
    const stateNoBeing = ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: 'Proyecto X' }).state;
    const { cmds, sent, calls } = harness({ config: cfg(), state: stateNoBeing });
    await cmds.run({ ...EV });
    expect(calls.create).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('`/join do` override acts on node do (a secondary-role node that would otherwise stand down)', async () => {
    const { cmds, calls } = harness({ config: cfg({ node_name: 'do', node_role: 'secondary' }) });
    await cmds.run({ ...EV, body: '/join do' });
    expect(calls.create).toHaveLength(1);            // the override selected this node
    expect(calls.create[0].title).toBe('egpt join de Proyecto X');   // 'do' was the <node>, NOT the <name>
  });

  it('`/join do` on the primary node kg stands down — it addressed do, not kg (both forms: space + =)', async () => {
    for (const body of ['/join do', '/join=do']) {
      const { cmds, calls } = harness({ config: cfg({ node_name: 'kg', node_role: 'primary', peer_nodes: ['do'] }) });
      await cmds.run({ ...EV, body });
      expect(calls.create, body).toHaveLength(0);
    }
  });

  it('Rodz unresolvable → logs only (no chat reply), creates nothing', async () => {
    const { cmds, sent, logs, calls, getState } = harness({ config: cfg({ texts: false }), rodzUserId: null });
    await cmds.run({ ...EV });
    expect(sent).toHaveLength(0);
    expect(logs.some((l) => /could not resolve Rodz/i.test(l))).toBe(true);
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', JOIN_CHAT)).toBe(null);
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
  const EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', chatName: 'Proyecto X', body: '/split' };

  it('creates a NEW conversation (own slug, NOT an alias), records parent_chat, edits placeholder from config.split', async () => {
    seedSourceThreads('e');
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.run({ ...EV });
    const st = getState();
    expect(calls.create[0].title).toBe('egpt split de Proyecto X');
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
      createGroup: async () => ({ success: true, chatID: SPLIT_CHAT }),
      postReply: async () => ({ ok: true }), archiveChat: async () => true,
      chatAccountId: async () => 'whatsapp', chatTitle: async () => null,
      resolveUserIdByPhone: async () => RODZ_USER_ID,
    };
    const logs = [];
    const cmds = createCommands({
      getConfig: () => cfg(), send: async () => {},
      loadState: async () => st, writeState: async (s) => { st = s; },
      resolveConvRoom: async () => null, jsonlStoreRoot: STORE, defaultKey: 'e', forkBridge, io, onLog: (m) => logs.push(m),
    });
    await cmds.run({ ...EV });
    expect(logs.some((l) => /thread copy for e.*failed/i.test(l))).toBe(true);
    expect(getBeing(st, 'whatsapp', SPLIT_CHAT, 'e')?.threadId).toBeTruthy();   // thread id recorded anyway
    expect(getContact(st, 'whatsapp', SPLIT_CHAT).entry.parent_chat).toBe(C_CHAT);
  });

  it('SILENT on a non-primary-role node; `/split do` override acts on do', async () => {
    seedSourceThreads('e');
    const silent = harness({ config: cfg({ node_name: 'do', node_role: 'secondary' }) });
    await silent.cmds.run({ ...EV });
    expect(silent.calls.create).toHaveLength(0);
    expect(silent.sent).toHaveLength(0);

    seedSourceThreads('e');
    const override = harness({ config: cfg({ node_name: 'do', node_role: 'secondary' }) });
    await override.cmds.run({ ...EV, body: '/split do' });
    expect(override.calls.create).toHaveLength(1);
  });
});

// ── /send (works in both; post_back_from routes the posting account) ────────────────────────────────
describe('/send — relays the replied-to message back to the original (alias OR recorded parent)', () => {
  it('in a /join group: posts to the alias target; repeatable, no close', async () => {
    const { cmds, calls, getState } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg() });
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send' });
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].chatId).toBe(C_CHAT);
    expect(calls.post[0].text).toBe('la respuesta elegida');
    expect(calls.archive).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', JOIN_CHAT)).toBe(getContact(getState(), 'whatsapp', C_CHAT).jid);
  });

  it('in a /split group: posts to the recorded parent_chat', async () => {
    const { cmds, calls } = harness({ state: stateWithSplit(), rooms: roomWith(SPLIT_CHAT), config: cfg() });
    await cmds.run({ chatId: SPLIT_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send' });
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].chatId).toBe(C_CHAT);
    expect(calls.post[0].text).toBe('la respuesta elegida');
  });

  it('post_back_from: secondary (default) routes via the mouth; primary routes via the operator', async () => {
    const def = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg() });              // unset → secondary
    await def.cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 's', replyToId: 'M1', body: '/send' });
    expect(def.calls.post[0].via).toBe('secondary');

    const sec = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg({ send: { post_back_from: 'secondary' } }) });
    await sec.cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 's', replyToId: 'M1', body: '/send' });
    expect(sec.calls.post[0].via).toBe('secondary');

    const prim = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg({ send: { post_back_from: 'primary' } }) });
    await prim.cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 's', replyToId: 'M1', body: '/send' });
    expect(prim.calls.post[0].via).toBe('primary');
  });

  it('SILENT outside a join/split group (no alias, no parent) → nothing posted/sent', async () => {
    const { cmds, sent, calls } = harness({ state: seedState(), rooms: roomWith(C_CHAT), config: cfg() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send' });
    expect(sent).toHaveLength(0);
    expect(calls.post).toHaveLength(0);
  });

  it('in a group but no reply target → an error, nothing posted', async () => {
    const { cmds, sent, calls } = harness({ state: stateWithJoin(), rooms: roomWith(JOIN_CHAT), config: cfg() });
    await cmds.run({ chatId: JOIN_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: null, body: '/send' });
    expect(sent[0].text).toMatch(/reply to a message with \/send/i);
    expect(calls.post).toHaveLength(0);
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

// ── restart safety ────────────────────────────────────────────────────────────────────────────────
describe('restart safety — the mappings survive a reload', () => {
  it('a /join alias round-trips through the real readState/writeState', async () => {
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
