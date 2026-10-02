// tests/fork-command.test.mjs — /fork, /send and /end (operator 2026-10-01), the ALIAS model.
//
// /fork (reply /fork to a message in chat C): create a WhatsApp group (operator + Rodz,
// type:"group") and ALIAS its chatId to C's conversation (conversations-state aliasOf), so the
// being keeps its ONE shared thread and the group is just a second surface — no thread copy, no
// folder, no access grant, nothing told to the model. Then edit the operator's /fork message into
// the configured placeholder marker.
// /send (reply /send to a message M in the fork group): relay M's text back into the ORIGINAL chat.
// /end (reply /end in the fork group): archive the group and drop its alias.
//
// THE HARD CONSTRAINT: never a real Beeper call. Every bridge op is an injected fake (forkBridge)
// that only RECORDS the call. State is in-memory (loadState/writeState over one object), except the
// restart-safety test, which round-trips the alias through the REAL readState/writeState.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// egpt-home.mjs freezes EGPT_HOME at module load, so this must run BEFORE the imports — vi.hoisted
// does that. A private temp profile, never ~/.egpt.
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-fork-command-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { createCommands, resolveSecondaryParticipantId, FORK_PLACEHOLDER_DEFAULT, FORK_TITLE_DEFAULT } from '../src/spine/commands.mjs';
import { resolveBeingDef, sandboxSharePathsFor } from '../src/spine/brainpool.mjs';
import { ensureContact, recordThread, getContact, aliasContact, aliasTargetOf, readState as readConvState, writeState as writeConvState } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';

const C_CHAT = '!chatC';
const FORK_CHAT = '!chatFork';
const SRC_THREAD = '11111111-1111-1111-1111-111111111111';

// AN's primary + Rodz's secondary phones, named by config.beeper.{primary,secondary}.phone.
const AN = '+16468217865';
const RODZ = '+13472576794';
const beeperCfg = (primary, secondary) => ({ beeper: { primary: { phone: primary }, secondary: { phone: secondary } } });

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-fork-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

// C's contact with E holding an active thread — so a being RESIDES here (the /fork gate).
function seedState() {
  let st = ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: 'Proyecto X' }).state;
  st = recordThread(st, 'whatsapp', C_CHAT, SRC_THREAD, '2026-10-01T00:00:00Z', 'e');
  return st;
}
// C as above, PLUS the fork group aliased to it — the state /fork leaves behind (for /send + /end).
function stateWithFork() {
  const st = seedState();
  const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
  return aliasContact(st, 'whatsapp', FORK_CHAT, primaryJid);
}

function harness({ config = {}, selfIds = [AN], state, resolveForkPartner, rooms = new Map() } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { edit: [], create: [], post: [], archive: [] };
  const forkBridge = {
    editMessage: async (chatId, msgId, text) => { calls.edit.push({ chatId, msgId, text }); return true; },
    createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: FORK_CHAT }; },
    postReply: async (chatId, text, replyToMessageID) => { calls.post.push({ chatId, text, replyToMessageID }); return { ok: true }; },
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
    defaultKey: 'e',
    forkBridge,
    selfIds: async () => selfIds,
    ...(resolveForkPartner ? { resolveForkPartner } : {}),
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, calls, forkBridge, getState: () => st };
}

// The SHARED transcript (C's folder) the fork group's lines also land in. /send reads M out of it.
function roomsWithFork() {
  const m = new Map();
  const shared = new TmpRoom(join(base, 'conv-C'), 'proyecto-x');
  mkdirSync(shared.baseDir(), { recursive: true });
  writeFileSync(shared.transcriptPath, 'An@[egpt fork Proyecto X].wa (14:35) #M1: la respuesta elegida\n\n', 'utf8');
  m.set(FORK_CHAT, shared);    // resolveConvRoom(FORK_CHAT) follows the alias → the shared room
  m.set(C_CHAT, shared);
  return m;
}

// ── /fork ───────────────────────────────────────────────────────────────────────────────────────
const FORK_PLACEHOLDER_CFG = '🔀 forking, un momento…';
const FORK_TITLE_CFG = 'egpt bifurcación de {group}';
describe('/fork — happy path (alias model, fake bridge, in-memory state)', () => {
  const CFG = { ...beeperCfg(AN, RODZ), fork: { placeholder: FORK_PLACEHOLDER_CFG, title: FORK_TITLE_CFG } };
  const EV = { chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' };

  it('creates a type:"group" titled from config.fork.title ({group} filled), participants incl. Rodz, NO opener', async () => {
    const { cmds, calls } = harness({ config: CFG });
    await cmds.run({ ...EV });
    expect(calls.create).toHaveLength(1);
    const c = calls.create[0];
    expect(c.type).toBe('group');
    expect(c.title).toBe('egpt bifurcación de Proyecto X');
    expect('messageText' in c).toBe(false);          // NO opener — the group inherits C's thread by the alias
    expect(c.participantIDs).toContain(RODZ);
    expect(c.participantIDs).toContain(AN);
    expect(c.accountID).toBe('whatsapp');
  });

  it('writes a pure { aliasOf: <original> } entry for the new group chatId', async () => {
    const { cmds, getState } = harness({ config: CFG });
    await cmds.run({ ...EV });
    const st = getState();
    const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
    expect(st.contacts.whatsapp[FORK_CHAT]).toEqual({ aliasOf: primaryJid });
    expect(aliasTargetOf(st, 'whatsapp', FORK_CHAT)).toBe(primaryJid);
    // the fork chat now resolves to the SAME folder + the SAME being thread as C — one shared thread
    expect(getContact(st, 'whatsapp', FORK_CHAT).slug).toBe(getContact(st, 'whatsapp', C_CHAT).slug);
  });

  it('edits the /fork message to config.fork.placeholder via an editMessage that EXISTS', async () => {
    const { cmds, calls, forkBridge } = harness({ config: CFG });
    expect(typeof forkBridge.editMessage).toBe('function');   // the method the live node was missing
    await cmds.run({ ...EV });
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0]).toEqual({ chatId: C_CHAT, msgId: 'cmd1', text: FORK_PLACEHOLDER_CFG });
  });

  it('placeholder + title fall back to the built-in defaults when config.fork is unset', async () => {
    const { cmds, calls } = harness({ config: beeperCfg(AN, RODZ) });   // no fork block
    await cmds.run({ ...EV });
    expect(calls.edit[0].text).toBe(FORK_PLACEHOLDER_DEFAULT);
    expect(calls.create[0].title).toBe(FORK_TITLE_DEFAULT.replace('{group}', 'Proyecto X'));
  });
});

describe('/fork — refusals + silent stand-down create nothing', () => {
  const CFG = { ...beeperCfg(AN, RODZ), fork: { placeholder: FORK_PLACEHOLDER_CFG, title: FORK_TITLE_CFG } };

  it('SILENT stand-down when no being resides on this node — sends NOTHING, creates nothing', async () => {
    // C exists as a contact but has NO resident being (no thread) — the node that lacks the being.
    const noBeing = ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: 'Proyecto X' }).state;
    const { cmds, sent, logs, calls, getState } = harness({ config: CFG, state: noBeing });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' });
    expect(sent).toHaveLength(0);                                   // NO chat reply
    expect(logs.some((l) => /\/fork/.test(l))).toBe(false);        // the gate emits no fork log either
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', FORK_CHAT)).toBe(null);
  });

  it('no reply target → an error, and NOTHING is created (gate passed first, so only this node answers)', async () => {
    const { cmds, sent, calls } = harness({ config: CFG });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: null, chatName: 'Proyecto X', body: '/fork' });
    expect(sent[0].text).toMatch(/reply to a message with \/fork/);
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
  });

  it('Rodz unresolvable → logs to the daemon ONLY (no chat reply), creates nothing', async () => {
    const { cmds, sent, logs, calls, getState } = harness({ config: {} });   // no beeper phones ⇒ null
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' });
    expect(sent).toHaveLength(0);                 // silent to the chat
    expect(logs.some((l) => /could not resolve the secondary \(Rodz\)/i.test(l))).toBe(true);
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', FORK_CHAT)).toBe(null);
  });

  it('an injected resolver returning null also refuses (the STOP seam is honored)', async () => {
    const { cmds, sent, calls } = harness({ config: {}, resolveForkPartner: async () => null });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'cmd1', replyToId: 'M0', chatName: 'Proyecto X', body: '/fork' });
    expect(sent).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
  });
});

// ── /send ───────────────────────────────────────────────────────────────────────────────────────
describe('/send — relays a chosen message from the fork group back to the original chat', () => {
  it('posts the replied-to message\'s text to the ORIGINAL (alias-target) chat; repeatable, no close', async () => {
    const { cmds, calls, getState } = harness({ state: stateWithFork(), rooms: roomsWithFork() });
    await cmds.run({ chatId: FORK_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send' });
    expect(calls.post).toEqual([{ chatId: C_CHAT, text: 'la respuesta elegida', replyToMessageID: null }]);
    expect(calls.archive).toHaveLength(0);                 // /send never closes the room
    expect(aliasTargetOf(getState(), 'whatsapp', FORK_CHAT)).toBe(getContact(getState(), 'whatsapp', C_CHAT).jid);   // still a fork group
  });

  it('SILENT outside a fork group (no alias) → nothing posted, nothing sent', async () => {
    const { cmds, sent, calls } = harness({ state: seedState(), rooms: roomsWithFork() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: 'M1', body: '/send' });
    expect(sent).toHaveLength(0);
    expect(calls.post).toHaveLength(0);
  });

  it('in a fork group but no reply target → an error, nothing posted', async () => {
    const { cmds, sent, calls } = harness({ state: stateWithFork(), rooms: roomsWithFork() });
    await cmds.run({ chatId: FORK_CHAT, surface: 'whatsapp', msgId: 'snd1', replyToId: null, body: '/send' });
    expect(sent[0].text).toMatch(/reply to a message with \/send/i);
    expect(calls.post).toHaveLength(0);
  });
});

// ── /end ────────────────────────────────────────────────────────────────────────────────────────
describe('/end — archives the fork group and drops the alias, posting nothing', () => {
  it('archives the fork chat, drops the alias, and sends NOTHING; a second /end is inert', async () => {
    const { cmds, sent, calls, getState } = harness({ state: stateWithFork(), rooms: roomsWithFork() });
    await cmds.run({ chatId: FORK_CHAT, surface: 'whatsapp', msgId: 'end1', body: '/end' });
    expect(calls.archive).toEqual([{ chatId: FORK_CHAT }]);
    expect(sent).toHaveLength(0);                          // posts nothing back
    expect(aliasTargetOf(getState(), 'whatsapp', FORK_CHAT)).toBe(null);   // alias dropped
    // the room is closed ⇒ a second /end is a silent no-op
    await cmds.run({ chatId: FORK_CHAT, surface: 'whatsapp', msgId: 'end2', body: '/end' });
    expect(calls.archive).toHaveLength(1);
  });

  it('SILENT outside a fork group (no alias) → nothing archived, nothing sent', async () => {
    const { cmds, sent, calls } = harness({ state: seedState(), rooms: roomsWithFork() });
    await cmds.run({ chatId: C_CHAT, surface: 'whatsapp', msgId: 'end1', body: '/end' });
    expect(sent).toHaveLength(0);
    expect(calls.archive).toHaveLength(0);
  });
});

// ── restart safety ────────────────────────────────────────────────────────────────────────────
describe('restart safety — the fork alias survives a reload', () => {
  it('round-trips through the real readState/writeState (conversations.yaml)', async () => {
    const yamlPath = join(base, 'conversations.yaml');
    await writeConvState(yamlPath, stateWithFork());
    const reloaded = await readConvState(yamlPath);
    const primaryJid = getContact(reloaded, 'whatsapp', C_CHAT).jid;
    expect(aliasTargetOf(reloaded, 'whatsapp', FORK_CHAT)).toBe(primaryJid);
    expect(getContact(reloaded, 'whatsapp', FORK_CHAT).slug).toBe(getContact(reloaded, 'whatsapp', C_CHAT).slug);
  });
});

// ── the general per-conversation allowed_paths plumbing (kept; no longer written by /fork) ───────
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

// ── the Rodz resolution rule (pure) ─────────────────────────────────────────────────────────────
describe('resolveSecondaryParticipantId — the two config.beeper phones, non-self, exactly-one-or-null', () => {
  it('returns the beeper phone that is NOT this install', () => {
    expect(resolveSecondaryParticipantId(beeperCfg(AN, RODZ), [AN])).toBe(RODZ);
    expect(resolveSecondaryParticipantId(beeperCfg(AN, RODZ), [RODZ])).toBe(AN);
  });
  it('fewer than two phones ⇒ null (refuse)', () => {
    expect(resolveSecondaryParticipantId(beeperCfg(AN, undefined), [AN])).toBe(null);                 // only one phone set
    expect(resolveSecondaryParticipantId(beeperCfg(AN, '@dolly-egpt:beeper.com'), [AN])).toBe(null);  // a non-phone field
    expect(resolveSecondaryParticipantId({}, [AN])).toBe(null);                                        // no beeper block
  });
  it('no unique partner after excluding self ⇒ null', () => {
    expect(resolveSecondaryParticipantId(beeperCfg(AN, RODZ), [])).toBe(null);   // neither excluded ⇒ 2 remain
    expect(resolveSecondaryParticipantId(beeperCfg(AN, AN), [])).toBe(null);     // same number twice ⇒ <2 unique
  });
  it('normalizes phone shapes (digits-only compare) when excluding self', () => {
    expect(resolveSecondaryParticipantId(beeperCfg('+1 (646) 821-7865', RODZ), ['16468217865'])).toBe(RODZ);
  });
});
