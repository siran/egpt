// link-peer-side-groups.test.mjs — a peer's side groups replayed through this node's linkSideGroup
// (src/tools/link-peer-side-groups.mjs, operator 2026-11-02) leave exactly the entries the live openers do.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-link-peer-side-groups-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { ensureContact, recordThread, aliasContact, forkContact, patchContact, setAliasMouthChat, parse, serialize, slugDir, getContact } from '../src/conversations-state.mjs';
import { encodeNodeSignature, encodeChatCanary } from '../src/node-signature.mjs';
import { peerSideGroups, linkPeerSideGroups, liveSpinePid, formatRow } from '../src/tools/link-peer-side-groups.mjs';

const ORIGIN = 'muestra1';
const AUTO = 'autoSide000000000001';
const SPLIT = 'splitSide00000000001';
const AUTO_TITLE = 'SI+MUESTRA';
const SPLIT_TITLE = 'SI+MUESTRA-viaje';
const AN = '+15550100001';
const RODZ = '+15550100002';
const AN_ID = '@anaprueba:beeper.local';
const MOUTH = { [AUTO]: 'rodzAuto000000000001', [SPLIT]: 'rodzSplit00000000001' };

// kg's state, as the copy of its conversations.yaml reads back: an automatic group and a /split of MUESTRA.
function peerState() {
  let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: 'MUESTRA' }).state;
  st = recordThread(st, 'whatsapp', ORIGIN, 'kg-thread', '2026-10-01T00:00:00Z', 'e');
  st = aliasContact(st, 'whatsapp', AUTO, ORIGIN, { transcript: AUTO_TITLE, automatic: true });
  st = forkContact(st, 'whatsapp', SPLIT, ORIGIN, { pushedName: SPLIT_TITLE, transcript: 'si-muestra-viaje' });
  st = patchContact(st, 'whatsapp', SPLIT, { split: { tunnel: false } });
  for (const id of [AUTO, SPLIT]) st = setAliasMouthChat(st, id, MOUTH[id]);
  return parse(serialize(st));
}
// This node (NU): MUESTRA heard, its being n with a thread there.
function nodeState() {
  const st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: 'MUESTRA' }).state;
  return recordThread(st, 'whatsapp', ORIGIN, 'nu-thread', '2026-11-01T00:00:00Z', 'n');
}
const config = (extra = {}) => ({ beeper: { primary: { phone: AN }, secondary: { phone: RODZ } }, node_name: 'nu', agents: { n: { handles: ['n'] } }, ...extra });
const memory = (st) => ({ loadState: async () => st, writeState: async (s) => { st = s; }, get: () => st });
// A new thread id is random on every fork: compared by shape.
const THREAD_KEYS = new Set(['threadId', 'threadCreatedAt', 'identityInjectedAt']);
const shape = (v) => JSON.parse(JSON.stringify(v, (k, x) => (THREAD_KEYS.has(k) ? '*' : x)));

// The live way: each opener (kg's frame + canary) arriving in its group on this node's spine, Rodz's copy already arrived.
async function viaLiveOpeners(cfg) {
  const m = memory(nodeState());
  const openers = [
    { chatId: AUTO, chatName: AUTO_TITLE, canary: { group: AUTO, origin: ORIGIN, kind: 'automatic', transcript: AUTO_TITLE } },
    { chatId: SPLIT, chatName: SPLIT_TITLE, canary: { group: SPLIT, origin: ORIGIN, kind: 'split' } },
  ].map((o) => ({ ...o, text: `🔗 opener${encodeNodeSignature('kg', 'e')}${encodeChatCanary(o.canary)}` }));
  const arrived = openers.map((o) => ({ chatID: MOUTH[o.chatId], text: o.text }));
  const cmds = createCommands({ getConfig: () => cfg, loadState: m.loadState, writeState: m.writeState, chromeHost: null, forkBridge: { awaitMouthMessage: async (test) => arrived.find(test) ?? null } });
  const spine = createSpine({
    bridge: { onMessage() {}, stop() {}, wasSentByUs: () => false, send() { return { ok: true }; }, startStream() { return { update() {}, async finish() {} }; } },
    brain: { async turn() { return { text: 'ok' }; } },
    identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => cfg.agents, getConfig: () => cfg }),
    gating: createGating({ getConfig: () => cfg, loadState: m.loadState, sideGroupFor: (ev, o) => cmds.autoSideGroup(ev, o) }),
    commands: cmds, sender: createSender({ bridge: { send() {}, startStream() {} } }), transcript: { async log() {} }, heartbeats: { runDue() {} },
    mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode: (ev) => ev?.fromNode === 'nu', isSelfChat: () => false, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  for (const o of openers) await spine.handleInbound({ body: o.text, from: { network: 'whatsapp', chatId: o.chatId, chatName: o.chatName, userId: AN_ID, senderName: 'An', isSender: true, msgKey: `k-${o.chatId}` } });
  return m.get();
}

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

describe('link-peer-side-groups: the replay is linkSideGroup', () => {
  it('reads the peer\'s side groups: splits first, each with its origin, title, mouth room and tunnel', () => {
    expect(peerSideGroups(peerState())).toEqual([
      { surface: 'whatsapp', chatId: SPLIT, kind: 'split', origin: ORIGIN, transcript: null, title: SPLIT_TITLE, mouth: MOUTH[SPLIT], tunnel: false },
      { surface: 'whatsapp', chatId: AUTO, kind: 'automatic', origin: ORIGIN, transcript: AUTO_TITLE, title: AUTO_TITLE, mouth: MOUTH[AUTO] },
    ]);
  });

  for (const [name, extra] of [['node default off', {}], ['node default on', { reply_in_side_group: 'on' }]]) {
    it(`REPRODUCE: one automatic group and one /split leave the entries their live openers leave (${name})`, async () => {
      const live = await viaLiveOpeners(config(extra));
      const m = memory(nodeState());
      const rows = await linkPeerSideGroups(peerState(), { peer: 'kg', getConfig: () => config(extra), loadState: m.loadState, writeState: m.writeState });
      expect(rows.map((r) => [r.chatId, r.outcome])).toEqual([[SPLIT, 'linked'], [AUTO, 'linked']]);
      expect(shape(m.get().contacts.whatsapp)).toEqual(shape(live.contacts.whatsapp));
      const c = m.get().contacts.whatsapp;
      expect(c[AUTO]).toMatchObject({ aliasOf: ORIGIN, transcript: AUTO_TITLE, automatic: true, mouth_chat: MOUTH[AUTO] });
      expect(c[SPLIT]).toMatchObject({ parent_chat: ORIGIN, mouth_chat: MOUTH[SPLIT] });
      expect(c[SPLIT].agents.n.threadId).not.toBe('nu-thread');   // n's thread forked, as live
      expect(c[ORIGIN].reply_in_side_group).toBe(extra.reply_in_side_group ? undefined : 'on');
    });
  }

  it('a second replay finds both held and changes nothing', async () => {
    const m = memory(nodeState());
    const opts = { peer: 'kg', getConfig: () => config(), loadState: m.loadState, writeState: m.writeState };
    await linkPeerSideGroups(peerState(), opts);
    const once = m.get();
    const rows = await linkPeerSideGroups(peerState(), opts);
    expect(rows.map((r) => r.outcome)).toEqual(['held', 'held']);
    expect(m.get()).toBe(once);
  });

  it('a group whose chat this node does not have is not linked, with linkSideGroup\'s reason', async () => {
    const m = memory(ensureContact({ contacts: {} }, 'whatsapp', 'other1', { pushedName: 'X' }).state);
    const rows = await linkPeerSideGroups(peerState(), { peer: 'kg', getConfig: () => config(), loadState: m.loadState, writeState: m.writeState });
    expect(rows.map((r) => r.outcome)).toEqual(['not linked', 'not linked']);
    expect(rows[0].log.join(' ')).toMatch(/which this node does not have/);
    expect(m.get().contacts.whatsapp[AUTO]).toBeUndefined();
  });

  it('dry run (no-op writes): the links are shown and nothing reaches the disk, the forked thread\'s stamp included', async () => {
    const m = memory(nodeState());
    const folder = slugDir('whatsapp', getContact(m.get(), 'whatsapp', ORIGIN).slug);   // MUESTRA's folder, as on a live node
    mkdirSync(folder, { recursive: true });
    const rows = await linkPeerSideGroups(peerState(), { peer: 'kg', getConfig: () => config(), loadState: m.loadState, writeState: m.writeState, io: { mkdir: async () => {}, writeFile: async () => {} } });
    expect(rows.map((r) => r.outcome)).toEqual(['linked', 'linked']);
    expect(readdirSync(folder)).toEqual([]);
    const line = formatRow(rows[0], { dry: true });
    expect(line).toContain(`split     whatsapp/${SPLIT} → ${ORIGIN}  "${SPLIT_TITLE}"  (mouth ${MOUTH[SPLIT]}, tunnel off on the peer)  would link`);
  });
});

describe('link-peer-side-groups: --apply only with the spine stopped', () => {
  const state = (pid, beatAgeMs) => {
    mkdirSync(join(HOME, 'state'), { recursive: true });
    writeFileSync(join(HOME, 'state', 'spine.pid'), String(pid));
    writeFileSync(join(HOME, 'state', 'alive.txt'), 'x');
    const t = (Date.now() - beatAgeMs) / 1000;
    utimesSync(join(HOME, 'state', 'alive.txt'), t, t);
  };
  it('a live pid with a fresh beat is a running spine; a stale beat or no files is not', () => {
    expect(liveSpinePid(HOME)).toBe(null);
    state(process.pid, 1000);
    expect(liveSpinePid(HOME)).toBe(process.pid);
    state(process.pid, 10 * 60_000);
    expect(liveSpinePid(HOME)).toBe(null);
  });
});
