// members-add-group-resolves-on-the-ear.test.mjs — A NAME THE OPERATOR TYPES IS A CHAT THE
// OPERATOR CAN SEE, AND THE OPERATOR'S ACCOUNT IS THE EAR.
//
// THE LIVE FAULT ON kg (operator 2026-09-11). The ear is `primary` (anrodz42) and the default
// mouth is `secondary` (dolly.egpt). `/members add group <name>` resolves that name through the
// `resolveChatId` seam src/spine/boot.mjs injects into createCommands — and that seam was taken
// off the FAN-OUT FACADE, which delegates every non-inbound method to the default mouth. So the
// name was looked up in dolly.egpt's chat list and an id from dolly.egpt's account was written
// into the roster.
//
// WHY THAT ROSTER ENTRY IS DEAD ON ARRIVAL, and why it is silent about it. One real group is a
// DIFFERENT Matrix room per Beeper account (src/bridges/beeper.mjs crossAccountChatKey's header,
// measured live). The group's actual arrivals come in on the EAR and therefore carry PRIMARY's
// room id; the roster holds SECONDARY's. They never match, nothing is ever relayed, and nothing
// anywhere says so — the add reported success and the id it printed even looks plausible.
//
// THE RULING: RESOLVE THE NAME AGAINST THE EAR. This is not the outbound question
// (outboundConnectionFor — "the mouth speaks wherever the mouth can reach the chat"), because
// there is no chat id yet to ask reachability about and no config declaration to lean on. The
// input is a NAME TYPED AT COMMAND TIME, and the only account that can be meant is the one the
// operator is looking at, which is the account this node HEARS on.
//
// The same seam feeds the chat LIST (`listChats`) that words `add group`'s "no chat named …"
// near-miss suggestion, so it moves with it: offering names off the mouth's account would answer
// a question about the ear's chats with a list of somebody else's.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid and heartbeats.readonly.yaml and /members writes
// a roster into config/rooms.yaml, and files running in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-members-add-group-ear-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, emptyState;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});
const live = [];
afterEach(async () => {
  while (live.length) { try { live.pop().stop(); } catch { /* already stopped */ } }
  // The roster is written to config/rooms.yaml for real — clear it so one case cannot seat a
  // member the next one then reads back as "already a member here".
  try { await fs.rm(`${_PRIVATE_HOME}/config`, { recursive: true, force: true }); } catch {}
});

// ── the two connections, named the way the live node names them ─────────────────────────────
const PRIMARY = 'TOK-primary';       // anrodz42 — the EAR (boot's ear rule: 'primary' by name)
const SECONDARY = 'TOK-secondary';   // dolly.egpt — the MOUTH the names resolve output to
const NAME_OF = { [PRIMARY]: 'primary', [SECONDARY]: 'secondary' };

const SELF_DM = '!self-dm-as-primary-sees-it';
// The operator's real group name, and the two rooms it is — one per account.
const GROUP_NAME = 'perrito traducciones';
const ON_PRIMARY = 'pGroupAsPrimarySeesIt';
const ON_SECONDARY = 'sGroupAsSecondarySeesIt';

// Each account's OWN chat list. `chats` is what listChats hands back and what resolveChatId
// matches names in — the same normalized shape src/bridges/beeper.mjs listChats produces.
function fakeTransport(chatsByToken) {
  const built = [];
  const start = async (opts) => {
    const chats = chatsByToken[opts.beeperToken] ?? [];
    const spy = {
      connection: NAME_OF[opts.beeperToken] ?? opts.beeperToken, token: opts.beeperToken,
      onIncoming: opts.onIncoming, sent: [], resolves: [], lists: 0,
    };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams = spy.streams ?? []; spy.streams.push(h); return h;
      },
      async chatHasParticipant() { return null; },
      // THE TWO SEAMS UNDER TEST, per account. A '!' id short-circuits in commands.mjs and never
      // reaches here, so every call recorded below is a NAME lookup.
      async resolveChatId(nameOrId) { spy.resolves.push(nameOrId); return chats.find((c) => c.name === nameOrId)?.id ?? null; },
      async listChats() { spy.lists += 1; return chats; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// Complete in-memory fs seam — same shape as tests/node-announce-follows-the-chat.test.mjs.
function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (path, to) => { if (!files.has(path)) throw missing(path); files.set(to, files.get(path)); files.delete(path); },
  };
}

const fakeSession = (opts) => ({ sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} });
const fakeProbe = async () => ({ ok: false, status: 0 });
const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

// kg's live shape: two connections, NO `beeper.use`, no `owner_node`, Self-DM declared.
// Output → 'secondary' (nameDerivedConnection), ingest → 'primary' (the ear rule).
const KG = () => ({
  node_name: 'kg',
  user_name: 'An',
  networks: { whatsapp: { chat_ids: [SELF_DM], allowed_users: ['u-1'] } },
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY },
    secondary: { account: 'dolly.egpt@example.com', token: SECONDARY },
  },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
});

// A ONE-CONNECTION NODE — the INTENT.md baseline, where the ear IS the mouth.
const SINGLE = () => { const c = KG(); delete c.beeper.secondary; return c; };

async function bootWith(config, chatsByToken) {
  const { start, built } = fakeTransport(chatsByToken);
  const lines = [];
  let convState = emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: start,
    makeSession: fakeSession,
    probeEndpoint: fakeProbe,
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(),
    ingest: false,
    spawn: fakeSpawn,
    reapPort: () => 0,
    now: () => Date.UTC(2026, 8, 11, 14, 5),
    tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  live.push(app);
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  const posted = () => built.flatMap((s) => s.sent.map((m) => ({ connection: s.connection, chatId: m.chatId, text: m.text })));
  return { app, built, byConnection, posted, lines };
}

async function waitFor(check, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

const deliver = (spy, chatId, body) => spy.onIncoming(body, {
  chatId, chatName: chatId.replace(/^!/, ''), network: 'whatsapp',
  userId: 'u-1', senderName: 'An', authorized: true, msgKey: `m-${chatId}-${body.length}-${Math.random()}`,
  atEStart: false, atEAnywhere: false,
});

describe('/members add group <name> resolves the name on the EAR, not on the default mouth', () => {
  // ── THE REPRODUCTION, IN ITS WORST FORM ───────────────────────────────────────────────────
  // BOTH accounts have a chat by that name — they are two different rooms for the same real
  // group. The mouth's lookup therefore SUCCEEDS and writes a plausible-looking id that the
  // group's own arrivals (which come in on the ear) can never match. Nothing reports it.
  it('BOTH accounts have the name: the id written is the EAR\'s, and the mouth is never asked', async () => {
    const { byConnection, posted } = await bootWith(KG(), {
      [PRIMARY]: [{ id: ON_PRIMARY, name: GROUP_NAME }],
      [SECONDARY]: [{ id: ON_SECONDARY, name: GROUP_NAME }],
    });
    // The precondition: this really is the split shape — both connections held, only one ear.
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    await deliver(byConnection.primary, SELF_DM, `/members add group ${GROUP_NAME}`);
    await waitFor(() => posted().length > 0);

    expect(posted()[0].text).toContain(`added group '${GROUP_NAME}' → '${ON_PRIMARY}'`);
    expect(posted()[0].text).not.toContain(ON_SECONDARY);
    expect(byConnection.primary.resolves).toEqual([GROUP_NAME]);
    expect(byConnection.secondary.resolves).toEqual([]);   // never consulted at all
  });

  // ── AND THE FORM THAT SIMPLY REFUSED ──────────────────────────────────────────────────────
  // A group only anrodz42 is in. The mouth's list has no such name, so the add was rejected
  // outright — "no chat named …" for a chat the operator was looking at while typing it.
  it('a group only the EAR can see is ADDED, not refused', async () => {
    const { byConnection, posted } = await bootWith(KG(), {
      [PRIMARY]: [{ id: ON_PRIMARY, name: GROUP_NAME }],
      [SECONDARY]: [],
    });

    await deliver(byConnection.primary, SELF_DM, `/members add group ${GROUP_NAME}`);
    await waitFor(() => posted().length > 0);

    expect(posted()[0].text).toContain(`added group '${GROUP_NAME}' → '${ON_PRIMARY}'`);
    expect(posted()[0].text).not.toMatch(/no chat named/);
    expect(byConnection.secondary.resolves).toEqual([]);
  });

  // ── THE NEAR-MISS SUGGESTION MOVES WITH IT ────────────────────────────────────────────────
  // `add group`'s "did you mean …?" is built from the chat LIST off the same seam (operator
  // 2026-08-31, after a one-letter typo cost four attempts). Offering the MOUTH's chat names
  // for a name typed about the EAR's chats is the same mistake one layer down.
  it('the "did you mean" near-miss is offered off the EAR\'s chat list', async () => {
    const { byConnection, posted } = await bootWith(KG(), {
      [PRIMARY]: [{ id: ON_PRIMARY, name: GROUP_NAME }],
      [SECONDARY]: [{ id: ON_SECONDARY, name: 'dolly only chat' }],
    });

    await deliver(byConnection.primary, SELF_DM, '/members add group perrito traduciones');   // the live typo
    await waitFor(() => posted().length > 0);

    const reply = posted()[0].text;
    expect(reply).toMatch(/no chat named 'perrito traduciones'/);
    expect(reply).toContain(`did you mean: '${GROUP_NAME}'`);
    expect(reply).not.toContain('dolly only chat');
    expect(byConnection.secondary.lists).toBe(0);
  });

  // ── THE BASELINE LOCK ─────────────────────────────────────────────────────────────────────
  // One connection: the ear IS the mouth, there is nothing to choose between, and this costs it
  // nothing.
  it('a ONE-connection node is untouched', async () => {
    const { built, byConnection, posted } = await bootWith(SINGLE(), {
      [PRIMARY]: [{ id: ON_PRIMARY, name: GROUP_NAME }],
    });
    expect(built.map((s) => s.connection)).toEqual(['primary']);

    await deliver(byConnection.primary, SELF_DM, `/members add group ${GROUP_NAME}`);
    await waitFor(() => posted().length > 0);

    expect(posted()[0].text).toContain(`added group '${GROUP_NAME}' → '${ON_PRIMARY}'`);
    expect(byConnection.primary.resolves).toEqual([GROUP_NAME]);
  });
});
