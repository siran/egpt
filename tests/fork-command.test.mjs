// tests/fork-command.test.mjs — /fork and /end (operator 2026-10-01), the private-fork feature.
//
// /fork (reply /fork to a message in chat C): edit the operator's /fork message into the
// 🤖↔️🤔 placeholder, create a WhatsApp group (operator + Rodz, type:"group"), fork E's thread
// (a COPY of C's current E-thread session under a new thread id), grant the fork being READ-ONLY
// access to C's folder, and persist a mapping fork-group → { original chat, placeholder id, forked
// message id }. /end (reply /end to a message M in a fork group): post M's text back into C as a
// NEW reply to the forked message, delete the placeholder, archive the fork group, clear the mapping.
//
// THE HARD CONSTRAINT: never a real Beeper call. Every bridge op is an injected fake (forkBridge)
// that only RECORDS the call — no group, no WhatsApp, nothing live. The thread copy runs against a
// temp jsonl store (jsonlStoreRoot), never ~/.egpt-jsonl. State is in-memory (loadState/writeState
// closures over one object), except the restart-safety test, which round-trips through the REAL
// readState/writeState to a temp conversations.yaml to prove the mapping survives a reload.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// egpt-home.mjs freezes EGPT_HOME at module load (slugDir below reads CONVERSATIONS_ROOT off it), so
// this must run BEFORE the imports — vi.hoisted does that. A private temp profile, never ~/.egpt.
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-fork-command-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { createCommands, resolveSecondaryParticipantId, rewriteForkSessionJsonl, FORK_PLACEHOLDER, FORK_OPENER } from '../src/spine/commands.mjs';
import { resolveBeingDef, sandboxSharePathsFor } from '../src/spine/brainpool.mjs';
import { ensureContact, recordThread, getBeing, getContact, slugDir, readState as readConvState, writeState as writeConvState } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';

const C_CHAT = '!chatC';
const FORK_CHAT = '!chatFork';
const SRC_THREAD = '11111111-1111-1111-1111-111111111111';
// A real boxed session: every record carries sessionId = the filename id; user records carry cwd =
// the conversation's folder. Plus a non-JSON line (claude sometimes writes stray lines) that must
// survive the transform copy verbatim.
const SRC_LINES = [
  JSON.stringify({ type: 'user', sessionId: SRC_THREAD, cwd: 'C:/orig', uuid: 'u1', message: { role: 'user', content: 'hola E' } }),
  'not-json: a stray line claude sometimes writes',
  JSON.stringify({ type: 'assistant', sessionId: SRC_THREAD, uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', content: 'hey' } }),
];
const SRC_CONTENT = SRC_LINES.join('\n') + '\n';

// AN's primary + Rodz's secondary phones, the pair config.peer_spine.accounts names. idKey/
// resolveSecondaryParticipantId reads the phone — the one id form that crosses the two accounts.
const AN = '+16468217865';
const RODZ = '+13472576794';

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

let base;      // a fresh temp root per test
let STORE;     // the fake jsonl store root (jsonlStoreRoot)
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'egpt-fork-'));
  STORE = join(base, 'jsonl');
  mkdirSync(STORE, { recursive: true });
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

// C's contact with E holding an active thread (SRC_THREAD) — the thing /fork forks from.
function seedState() {
  let st = ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: 'Proyecto X' }).state;
  st = recordThread(st, 'whatsapp', C_CHAT, SRC_THREAD, '2026-10-01T00:00:00Z', 'e');
  return st;
}

// The source session on disk, in the box store at <STORE>/<srcId>/projects/<projDir>/<srcId>.jsonl
// (findThreadJsonl scans projects/ by id).
function seedSourceThread() {
  const projDir = join(STORE, SRC_THREAD, 'projects', 'C--orig');
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${SRC_THREAD}.jsonl`), SRC_CONTENT, 'utf8');
}

function harness({ config = {}, selfIds = [AN], state, resolveForkPartner, rooms = new Map(), io } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { edit: [], create: [], post: [], del: [], archive: [] };
  const forkBridge = {
    editMessage: async (chatId, msgId, text) => { calls.edit.push({ chatId, msgId, text }); return true; },
    createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: FORK_CHAT }; },
    postReply: async (chatId, text, replyToMessageID) => { calls.post.push({ chatId, text, replyToMessageID }); return { ok: true }; },
    deleteMessage: async (chatId, msgId) => { calls.del.push({ chatId, msgId }); return true; },
    archiveChat: async (chatId) => { calls.archive.push({ chatId }); return true; },
    chatAccountId: async () => 'whatsapp',
    chatTitle: async () => null,
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
    selfIds: async () => selfIds,
    ...(resolveForkPartner ? { resolveForkPartner } : {}),
    ...(io ? { io } : {}),
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, calls, forkBridge, getState: () => st };
}

function roomsWithC() {
  const m = new Map();
  m.set(C_CHAT, new TmpRoom(join(base, 'conv-C'), 'proyecto-x'));
  return m;
}

// ── /fork ───────────────────────────────────────────────────────────────────────────────────────
describe('/fork — happy path (fake bridge, temp store, in-memory state)', () => {
  const CFG = { peer_spine: { accounts: [AN, RODZ] } };
  const EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' };

  it('edits the /fork message to the placeholder', async () => {
    seedSourceThread();
    const { cmds, calls } = harness({ config: CFG, rooms: roomsWithC() });
    await cmds.run({ ...EV });
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0]).toEqual({ chatId: C_CHAT, msgId: 'cmd1', text: FORK_PLACEHOLDER });
  });

  it('creates a type:"group" with the right title, participants incl. the resolved Rodz id, and the opener', async () => {
    seedSourceThread();
    const { cmds, calls } = harness({ config: CFG, rooms: roomsWithC() });
    await cmds.run({ ...EV });
    expect(calls.create).toHaveLength(1);
    const c = calls.create[0];
    expect(c.type).toBe('group');
    expect(c.title).toBe('egpt fork Proyecto X');
    expect(c.messageText).toBe(FORK_OPENER);
    expect(c.participantIDs).toContain(RODZ);       // the resolved secondary (Rodz)
    expect(c.participantIDs).toContain(AN);         // the operator too
    expect(c.accountID).toBe('whatsapp');
  });

  it('forks the thread — the copy IS the new session (sessionId + cwd rewritten per record), the original is byte-unchanged', async () => {
    seedSourceThread();
    const { cmds, getState } = harness({ config: CFG, rooms: roomsWithC() });
    await cmds.run({ ...EV });

    const st = getState();
    const newId = getBeing(st, 'whatsapp', FORK_CHAT, 'e')?.threadId;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(SRC_THREAD);
    const forkFolder = slugDir('whatsapp', getContact(st, 'whatsapp', FORK_CHAT).slug);

    // the copy lives under the NEW thread's store (projects/<fork cwd dir>/<newId>.jsonl)
    const projects = join(STORE, newId, 'projects');
    const copy = readdirSync(projects).map((d) => join(projects, d, `${newId}.jsonl`)).find((p) => existsSync(p));
    expect(copy, 'a <newId>.jsonl copy under the new thread store').toBeTruthy();
    const outLines = readFileSync(copy, 'utf8').split('\n');

    // record 0: sessionId + cwd rewritten to the fork's; every other field intact
    const r0 = JSON.parse(outLines[0]);
    expect(r0.sessionId).toBe(newId);
    expect(r0.cwd).toBe(forkFolder);
    expect(r0.uuid).toBe('u1');
    expect(r0.message).toEqual({ role: 'user', content: 'hola E' });
    // the non-JSON line survives verbatim
    expect(outLines[1]).toBe('not-json: a stray line claude sometimes writes');
    // record 2: sessionId rewritten; it had no cwd so none is added; uuid/parentUuid intact
    const r2 = JSON.parse(outLines[2]);
    expect(r2.sessionId).toBe(newId);
    expect('cwd' in r2).toBe(false);
    expect(r2.uuid).toBe('u2');
    expect(r2.parentUuid).toBe('u1');

    // the ORIGINAL file is BYTE-UNCHANGED (still the old id/cwd), and C's thread record is untouched
    const srcPath = join(STORE, SRC_THREAD, 'projects', 'C--orig', `${SRC_THREAD}.jsonl`);
    expect(readFileSync(srcPath, 'utf8')).toBe(SRC_CONTENT);
    expect(getBeing(st, 'whatsapp', C_CHAT, 'e')?.threadId).toBe(SRC_THREAD);
  });

  it('an existing dest is refused (EEXIST from flag:wx) — nothing written, group still registered, operator told', async () => {
    seedSourceThread();
    // io.writeFile throws EEXIST exactly as `flag:'wx'` would against a pre-existing dest; readFile
    // and mkdir fall through to real fs. writeState is its own seam, so the fork is still registered.
    const io = { writeFile: async () => { const e = new Error('file already exists'); e.code = 'EEXIST'; throw e; } };
    const { cmds, sent, calls, getState } = harness({ config: CFG, rooms: roomsWithC(), io });
    await cmds.run({ ...EV });
    expect(calls.create).toHaveLength(1);                                     // group created
    expect(sent.some((s) => /thread copy failed/i.test(s.text))).toBe(true);  // operator told
    expect(getBeing(getState(), 'whatsapp', FORK_CHAT, 'e')?.threadId).toBeTruthy();  // registered anyway
  });

  it('sets the fork being\'s READ-ONLY allowed_path to C\'s folder', async () => {
    seedSourceThread();
    const rooms = roomsWithC();
    const cFolder = rooms.get(C_CHAT).baseDir();
    const { cmds, getState } = harness({ config: CFG, rooms });
    await cmds.run({ ...EV });
    const ap = getContact(getState(), 'whatsapp', FORK_CHAT)?.entry?.agents?.e?.allowed_paths;
    expect(ap).toBeTruthy();
    expect(ap[cFolder]).toEqual({ allowed_tools: ['Read', 'Glob', 'Grep'] });   // no write tools ⇒ read-only
  });

  it('persists the /end mapping on the fork conversation entry', async () => {
    seedSourceThread();
    const { cmds, getState } = harness({ config: CFG, rooms: roomsWithC() });
    await cmds.run({ ...EV });
    const fork = getContact(getState(), 'whatsapp', FORK_CHAT)?.entry?.fork;
    expect(fork).toEqual({ originalChatId: C_CHAT, placeholderId: 'cmd1', forkedMessageId: 'M0' });
  });
});

describe('/fork — refusals create nothing', () => {
  it('no reply target → an error, and NOTHING is created', async () => {
    seedSourceThread();
    const { cmds, sent, calls } = harness({ config: { peer_spine: { accounts: [AN, RODZ] } }, rooms: roomsWithC() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: null, chatName: 'Proyecto X', body: '/fork' });
    expect(sent[0].text).toMatch(/reply to a message with \/fork/);
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
  });

  it('Rodz id unresolvable → the handler refuses + logs, and creates NOTHING (no group, no placeholder edit)', async () => {
    seedSourceThread();
    const { cmds, sent, logs, calls, getState } = harness({ config: {}, rooms: roomsWithC() });   // no peer_spine ⇒ null
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' });
    expect(sent[0].text).toMatch(/cannot resolve Rodz/i);
    expect(logs.some((l) => /could not resolve the secondary \(Rodz\)/i.test(l))).toBe(true);
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
    // no fork conversation was registered
    expect(getContact(getState(), 'whatsapp', FORK_CHAT)).toBeFalsy();
  });

  it('ambiguous config (both accounts, no self id to disambiguate) → refuses, creates nothing', async () => {
    seedSourceThread();
    const { cmds, sent, calls } = harness({ config: { peer_spine: { accounts: [AN, RODZ] } }, selfIds: [], rooms: roomsWithC() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' });
    expect(sent[0].text).toMatch(/cannot resolve Rodz/i);
    expect(calls.create).toHaveLength(0);
  });

  it('an injected resolver returning null also refuses (the STOP seam is honored)', async () => {
    seedSourceThread();
    const { cmds, sent, calls } = harness({ config: {}, resolveForkPartner: async () => null, rooms: roomsWithC() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' });
    expect(sent[0].text).toMatch(/cannot resolve Rodz/i);
    expect(calls.create).toHaveLength(0);
  });
});

// ── /end ────────────────────────────────────────────────────────────────────────────────────────
// A fork conversation carrying the mapping + a transcript with the chosen message M (#M1).
function stateWithFork() {
  let st = seedState();
  st = ensureContact(st, 'whatsapp', FORK_CHAT, { pushedName: 'egpt fork Proyecto X' }).state;
  // the mapping /fork would have written
  const c = getContact(st, 'whatsapp', FORK_CHAT);
  st = { ...st, contacts: { ...st.contacts, whatsapp: { ...st.contacts.whatsapp,
    [c.jid]: { ...st.contacts.whatsapp[c.jid], fork: { originalChatId: C_CHAT, placeholderId: 'cmd1', forkedMessageId: 'M0' } } } } };
  return st;
}

function roomsWithFork() {
  const m = new Map();
  const forkRoom = new TmpRoom(join(base, 'conv-fork'), 'egpt-fork-proyecto-x');
  mkdirSync(forkRoom.baseDir(), { recursive: true });
  writeFileSync(forkRoom.transcriptPath, 'An@[egpt fork Proyecto X].wa (14:35) #M1: la respuesta elegida\n\n', 'utf8');
  m.set(FORK_CHAT, forkRoom);
  return m;
}

describe('/end — sends the chosen message back, deletes the placeholder, archives, clears the mapping', () => {
  it('posts M\'s text as a NEW reply to the original forked message in C, then deletes + archives + clears', async () => {
    const { cmds, calls, getState } = harness({ state: stateWithFork(), rooms: roomsWithFork() });
    await cmds.run({ chatId: FORK_CHAT, surface: 'whatsapp', msgId: 'end1', replyToId: 'M1', body: '/end' });
    expect(calls.post).toEqual([{ chatId: C_CHAT, text: 'la respuesta elegida', replyToMessageID: 'M0' }]);
    expect(calls.del).toEqual([{ chatId: C_CHAT, msgId: 'cmd1' }]);
    expect(calls.archive).toEqual([{ chatId: FORK_CHAT }]);
    // mapping cleared ⇒ a second /end is inert
    expect(getContact(getState(), 'whatsapp', FORK_CHAT)?.entry?.fork ?? null).toBe(null);
  });

  it('outside a fork group (no mapping) → error, nothing posted/archived', async () => {
    const { cmds, sent, calls } = harness({ state: seedState(), rooms: roomsWithC() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'end1', replyToId: 'x', body: '/end' });
    expect(sent[0].text).toMatch(/not a fork group/i);
    expect(calls.post).toHaveLength(0);
    expect(calls.archive).toHaveLength(0);
  });

  it('in a fork group but no reply target → error, nothing posted', async () => {
    const { cmds, sent, calls } = harness({ state: stateWithFork(), rooms: roomsWithFork() });
    await cmds.run({ chatId: FORK_CHAT, surface: 'whatsapp', msgId: 'end1', replyToId: null, body: '/end' });
    expect(sent[0].text).toMatch(/reply to a message with \/end/i);
    expect(calls.post).toHaveLength(0);
  });
});

// ── restart safety ────────────────────────────────────────────────────────────────────────────
describe('restart safety — the /end mapping survives a reload', () => {
  it('round-trips through the real readState/writeState (conversations.yaml)', async () => {
    const yamlPath = join(base, 'conversations.yaml');
    await writeConvState(yamlPath, stateWithFork());
    const reloaded = await readConvState(yamlPath);
    const fork = getContact(reloaded, 'whatsapp', FORK_CHAT)?.entry?.fork;
    expect(fork).toEqual({ originalChatId: C_CHAT, placeholderId: 'cmd1', forkedMessageId: 'M0' });
  });
});

// ── the shared-path change /fork relies on (brainpool.resolveBeingDef) ──────────────────────────
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

// ── the fork-copy transform (pure) ──────────────────────────────────────────────────────────────
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
    expect('cwd' in r2).toBe(false);   // cwd is not ADDED where it was absent
    expect(out[3]).toBe('');
  });
});

// ── the Rodz resolution rule (pure) ─────────────────────────────────────────────────────────────
describe('resolveSecondaryParticipantId — phone-only, non-self, exactly-one-or-null', () => {
  it('returns the account that is NOT this install, by phone', () => {
    expect(resolveSecondaryParticipantId({ peer_spine: { accounts: [AN, RODZ] } }, [AN])).toBe(RODZ);
  });
  it('ignores the @dolly-egpt:beeper.com form (not a phone) and resolves the phone', () => {
    expect(resolveSecondaryParticipantId({ peer_spine: { accounts: [RODZ, '@dolly-egpt:beeper.com'] } }, [AN])).toBe(RODZ);
  });
  it('ambiguous (both accounts, no self) ⇒ null', () => {
    expect(resolveSecondaryParticipantId({ peer_spine: { accounts: [AN, RODZ] } }, [])).toBe(null);
  });
  it('no peer_spine ⇒ null', () => {
    expect(resolveSecondaryParticipantId({}, [AN])).toBe(null);
    expect(resolveSecondaryParticipantId({ peer_spine: { accounts: [] } }, [AN])).toBe(null);
  });
  it('normalizes phone shapes (digits-only compare) when excluding self', () => {
    expect(resolveSecondaryParticipantId({ peer_spine: { accounts: ['+1 (646) 821-7865', RODZ] } }, ['16468217865'])).toBe(RODZ);
  });
});
