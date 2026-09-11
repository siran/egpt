// beeper-inbound-outbound.test.mjs — THE EAR AND THE MOUTH ARE TWO DIFFERENT ANSWERS.
//
// Operator, 2026-09-10: *"do not use `use:`, instead `primary` is the one to 'use' and `secondary`
// is the one to use as output, agent could `use:` a configuration for it's output"*.
//
//   · `primary`   is the INGEST connection — the node's EAR.
//   · `secondary` is the OUTPUT connection when it exists, else `primary`.
//   · an agent may name its OWN output connection with `use:` (alias: the older
//     `beeper_connection`, which is in both live configs and must keep working).
//
// WHY THIS COULD NOT WORK BEFORE. ONE binding served BOTH directions:
//
//   · boot opened one bridge per connection an agent RIDES
//     (`for (const being of Object.keys(agents())) bridgeForEndpoint(endpointFor(connectionOf(being)))`),
//     so a declared connection nobody speaks on was never dialled and therefore never heard;
//   · router.mjs's connection gate compared `connectionOf(hit.name) === ev.connection`, so even a
//     bridge that WAS open on primary dropped an `@handle` whose agent spoke on secondary.
//
// Consequence on the operator's own machine, measured: `~/.egpt` declares `primary`
// (anrodz42@gmail.com), `secondary` (dolly.egpt@gmail.com) and `primary_gui` (anrodz42 again, a
// SECOND install). With the default resolving to `secondary`, kg dialled dolly.egpt alone and went
// DEAF on anrodz42 — including the operator command channel, which is An's own Self-DM. The only
// thing keeping it alive was a hand-added `use: primary` in the live config, marked TEMPORARY.
//
// TWO MEASURED FACTS THIS FILE ENCODES:
//   1. `~/.egpt`'s `secondary` token is BYTE-IDENTICAL to `~/.egpt2`'s `main` token (md5 of the
//      token string agrees, e2dbc018c2c6 both) — they are one Beeper install. A node must never
//      dial one endpoint twice as two ears.
//   2. `primary` and `primary_gui` are the SAME ACCOUNT on two different installs (two different
//      tokens, so nothing downstream collapses them). Dialling both would ingest every message on
//      anrodz42 TWICE. Only one of them may be an ear, and it is `primary`.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid and heartbeats.readonly.yaml, and files running
// in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-beeper-inbound-outbound-home`;
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

// ── the live ~/.egpt shape, with the tokens replaced ────────────────────────────────────────
const T_PRIMARY = 'TOK-primary';
const T_SECONDARY = 'TOK-secondary';
const T_GUI = 'TOK-primary-gui';
const NAME_OF = { [T_PRIMARY]: 'primary', [T_SECONDARY]: 'secondary', [T_GUI]: 'primary-gui' };

const LIVE_BEEPER = () => ({
  primary: { account: 'anrodz42@example.com', token: T_PRIMARY },
  secondary: { account: 'dolly@example.com', token: T_SECONDARY },
  primary_gui: { account: 'anrodz42@example.com', token: T_GUI },   // SAME account, SECOND install
});

const AG = () => ({ egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } });

// Complete in-memory fs seam — same shape as tests/single-account-node.test.mjs.
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
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} };
}

// Nothing answers the port probe — no case here asserts on discovery.
const fakeProbe = async () => ({ ok: false, status: 0 });

// One spy per startBridge CALL. `connection` is derived from the TOKEN, so it names the account
// dialled rather than whatever label boot happened to pick.
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { connection: NAME_OF[opts.beeperToken] ?? opts.beeperToken ?? '(none)', token: opts.beeperToken, opts, onIncoming: opts.onIncoming, sent: [], streams: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async chatHasParticipant() { return null; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

async function bootWith(config) {
  const { start, built } = fakeTransport();
  const lines = [];
  let convState = emptyState();
  const app = await boot({
    readConfig: () => ({ node_name: 'kg', user_name: 'An', ...config }),
    startBridge: start,
    makeSession: fakeSession,
    probeEndpoint: fakeProbe,
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  const dialled = () => built.map((s) => s.connection).sort();
  const replies = () => built.flatMap((s) => s.streams.map((h) => ({ connection: s.connection, text: h.finals[0] })));
  return { app, built, byConnection, dialled, replies, lines };
}

// One arrival, shaped the way the real bridge shapes it. atEStart/atEAnywhere is the BRIDGE's own
// mention finding (this stub never computes it), so it is stated here.
const deliver = (spy, body, chatId = '!room') => spy.onIncoming(body, {
  chatId, chatName: 'room', network: 'whatsapp',
  userId: '+34658515045', senderName: 'Dando', authorized: true, msgKey: `m-${chatId}-${body.length}`,
  atEStart: true, atEAnywhere: true,
});

describe('the ear and the mouth are two answers (operator 2026-09-10)', () => {
  // ── THE REPRODUCTION ──────────────────────────────────────────────────────────────────────
  // The smallest shape that failed: `primary` and `secondary` declared, no `use:` anywhere. The
  // single binding resolved to `secondary` for BOTH directions, so `primary` was never dialled and
  // an `@e` typed on the operator's own account reached nothing at all.
  it('primary + secondary, no use: anywhere → the node HEARS on primary and its MOUTH is secondary', async () => {
    const { byConnection, dialled, replies, app } = await bootWith({
      agents: AG(),
      beeper: { primary: { account: 'an@example.com', token: T_PRIMARY }, secondary: { account: 'rodz@example.com', token: T_SECONDARY } },
    });
    // BOTH are dialled — the ear because it is the ear, the mouth because someone speaks on it.
    // THAT is what the split delivers, and it is what this case is for.
    expect(dialled()).toEqual(['primary', 'secondary']);

    await deliver(byConnection.primary, '@e hola');

    // …AND THE REPLY GOES BACK OUT THE EAR (operator 2026-09-11: *"if rodz is not in, reply flows
    // back from primary"*). This assertion read `['secondary']` until then, and that was the
    // defect the crutch in the live config was hiding: `secondary` is a DIFFERENT Beeper account,
    // so `!room` — a chatId minted by primary's Desktop — names a Matrix room secondary's install
    // is not in. The reply did not come out of the wrong mouth, it came out into nowhere. The
    // MOUTH still means what it meant: it is what the peer link is offered against, and it is what
    // a chat this node has never heard is spoken into. See tests/reply-follows-the-arrival.test.mjs.
    expect(replies().map((r) => r.connection)).toEqual(['primary']);
    app.stop();
  });

  // …and the mouth is NOT a second ear. An arrival on `secondary` is swallowed: its inbound
  // registrations are no-ops, exactly as a connection owned by another node already was.
  it('the OUTPUT connection is not an ear — an arrival on secondary wakes nothing', async () => {
    const { byConnection, replies, app } = await bootWith({
      agents: AG(),
      beeper: { primary: { account: 'an@example.com', token: T_PRIMARY }, secondary: { account: 'rodz@example.com', token: T_SECONDARY } },
    });
    await deliver(byConnection.secondary, '@e hola', '!room-on-secondary');
    expect(replies()).toEqual([]);
    app.stop();
  });

  // ── THE LIVE ~/.egpt SHAPE ────────────────────────────────────────────────────────────────
  // primary + secondary + primary_gui, no `use:`. primary_gui is the operator's OWN Beeper window
  // on the SAME account as primary; dialling it as a second ear would ingest every message on
  // anrodz42 twice, and the two tokens differ so nothing downstream would collapse them.
  it('primary_gui is NEVER an ear — the same account on a second install is not dialled', async () => {
    const { dialled, byConnection, replies, app } = await bootWith({ agents: AG(), beeper: LIVE_BEEPER() });
    expect(dialled()).toEqual(['primary', 'secondary']);
    expect(byConnection['primary-gui']).toBeUndefined();

    await deliver(byConnection.primary, '@e hola');
    // …and the reply flows back out the ear, because `secondary` is another account (2026-09-11).
    expect(replies().map((r) => r.connection)).toEqual(['primary']);
    app.stop();
  });

  // …and it stays out of the EAR set even when an agent deliberately SPEAKS on it. The pin moves
  // the mouth and only the mouth.
  //
  // AND THE PIN IS STILL HONOURED HERE, which is the other half of the 2026-09-11 rule: a locally
  // placed reply goes back out the ear only when the being's own connection CANNOT REACH the chat.
  // `primary_gui` is the SAME Beeper ACCOUNT as `primary` on a second Desktop install, so it sees
  // the same Matrix rooms under the same ids and the pin costs nothing. (Same-account is also
  // precisely why the ear rules above refuse to claim both.)
  it('an agent pinned to primary_gui speaks there and the node still hears only on primary', async () => {
    const { dialled, byConnection, replies, app } = await bootWith({
      agents: { ...AG(), gui: { configuration: 'egpt', handles: ['gui'], use: 'primary_gui', conversation_defaults: { access_level: 'regular' } } },
      beeper: LIVE_BEEPER(),
    });
    expect(dialled()).toEqual(['primary', 'primary-gui', 'secondary']);

    // The GUI connection is held, and it is still deaf.
    await deliver(byConnection['primary-gui'], '@gui hola', '!room-on-gui');
    expect(replies()).toEqual([]);

    // The ear hears it, and @gui answers on its own pin.
    await deliver(byConnection.primary, '@gui hola', '!room-on-primary');
    expect(replies().map((r) => r.connection)).toEqual(['primary-gui']);
    app.stop();
  });

  // ── PER-AGENT `use:` — OUTPUT ONLY, NEVER INGEST ──────────────────────────────────────────
  it('per-agent use: moves the MOUTH and never the ear', async () => {
    const { byConnection, replies, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        gui: { configuration: 'egpt', handles: ['gui'], use: 'primary_gui', conversation_defaults: { access_level: 'regular' } },
      },
      beeper: LIVE_BEEPER(),
    });
    // Both beings are addressed on the ONE ear…
    await deliver(byConnection.primary, '@e hola', '!c1');
    await deliver(byConnection.primary, '@gui hola', '!c2');
    // …and each answers on the connection that can actually reach the chat: E's mouth is
    // `secondary`, ANOTHER account, so its reply flows back out the ear (2026-09-11); @gui's pin is
    // the same account as the ear on a second install, so the pin stands.
    expect(replies().map((r) => r.connection)).toEqual(['primary', 'primary-gui']);
    app.stop();
  });

  // THE ALIAS. `beeper_connection` is the older spelling and is in both live configs; it means
  // exactly what `use:` means and must keep working unchanged.
  it('beeper_connection is still an alias for use:', async () => {
    const { byConnection, replies, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        gui: { configuration: 'egpt', handles: ['gui'], beeper_connection: 'primary_gui', conversation_defaults: { access_level: 'regular' } },
      },
      beeper: LIVE_BEEPER(),
    });
    await deliver(byConnection.primary, '@gui hola');
    expect(replies().map((r) => r.connection)).toEqual(['primary-gui']);
    app.stop();
  });

  it('use: WINS over beeper_connection when an agent carries both', async () => {
    const { byConnection, replies, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        gui: { configuration: 'egpt', handles: ['gui'], use: 'primary_gui', beeper_connection: 'primary', conversation_defaults: { access_level: 'regular' } },
      },
      beeper: LIVE_BEEPER(),
    });
    await deliver(byConnection.primary, '@gui hola');
    expect(replies().map((r) => r.connection)).toEqual(['primary-gui']);
    app.stop();
  });

  // ── ONE ENDPOINT IS ONE EAR ───────────────────────────────────────────────────────────────
  // Two connection NAMES on one token is one Beeper install. It is dialled ONCE, and the second
  // name never becomes a second ear — which is the shape `~/.egpt`'s `secondary` and `~/.egpt2`'s
  // `main` already are on the operator's machine (byte-identical tokens, one install).
  it('a connection whose token duplicates an ear already claimed is not dialled twice', async () => {
    const { built, dialled, app } = await bootWith({
      agents: AG(),
      beeper: {
        primary: { account: 'an@example.com', token: T_PRIMARY, owner_node: 'kg' },
        primary_again: { account: 'an@example.com', token: T_PRIMARY, owner_node: 'kg' },
        secondary: { account: 'rodz@example.com', token: T_SECONDARY },
      },
    });
    expect(dialled()).toEqual(['primary', 'secondary']);
    expect(built.filter((s) => s.token === T_PRIMARY)).toHaveLength(1);
    app.stop();
  });

  // ── TWO EARS, SAID OUT LOUD ───────────────────────────────────────────────────────────────
  // The default is ONE ear. A node that genuinely wants to wake on two accounts says so with the
  // key that already means exactly that — `owner_node`, "which node WAKES on this connection".
  // No new concept, and no parallel one.
  it('owner_node naming THIS node claims a connection as an ear, and several may be claimed', async () => {
    const { byConnection, dialled, replies, app } = await bootWith({
      agents: AG(),
      beeper: {
        primary: { account: 'an@example.com', token: T_PRIMARY, owner_node: 'kg' },
        secondary: { account: 'rodz@example.com', token: T_SECONDARY, owner_node: 'kg' },
      },
    });
    expect(dialled()).toEqual(['primary', 'secondary']);
    await deliver(byConnection.primary, '@e hola', '!c1');
    await deliver(byConnection.secondary, '@e hola', '!c2');
    // TWO EARS, and each conversation is answered where it lives (2026-09-11). `!c1` and `!c2` are
    // rooms on two different accounts; before that rule both replies left on E's own `secondary`
    // and the `!c1` one addressed a room that account does not have.
    expect(replies().map((r) => r.connection)).toEqual(['primary', 'secondary']);
    app.stop();
  });

  // …and an explicit claim EXCLUDES what it does not name. `primary` would be the ear by name; a
  // config that claims `secondary` alone has said something more specific, and it wins — `primary`
  // is then held only because an agent speaks there, and it is DEAF.
  it('an explicit owner_node claim beats the primary-by-name default', async () => {
    const { dialled, byConnection, replies, app } = await bootWith({
      agents: { ...AG(), pin: { configuration: 'egpt', handles: ['pin'], use: 'primary', conversation_defaults: { access_level: 'regular' } } },
      beeper: {
        primary: { account: 'an@example.com', token: T_PRIMARY },
        secondary: { account: 'rodz@example.com', token: T_SECONDARY, owner_node: 'kg' },
      },
    });
    expect(dialled()).toEqual(['primary', 'secondary']);

    await deliver(byConnection.primary, '@e hola', '!c1');
    expect(replies()).toEqual([]);                                       // primary is a mouth here, not an ear

    await deliver(byConnection.secondary, '@e hola', '!c2');
    expect(replies().map((r) => r.connection)).toEqual(['secondary']);   // the claimed ear is the one that hears
    app.stop();
  });

  // ── THE SHAPES THAT MUST NOT MOVE ─────────────────────────────────────────────────────────
  // INTENT.md's baseline: a fresh clone, ONE account, no ceremony. One connection is ear and mouth
  // both, whatever it is called, with no selector and no naming convention.
  it('a single connection, oddly named, is unchanged — one bridge, ear and mouth', async () => {
    const { built, byConnection, replies, app } = await bootWith({
      agents: AG(),
      beeper: { whatever_i_called_it: { account: 'a@b', token: 'TOK-odd' } },
    });
    expect(built).toHaveLength(1);
    await deliver(byConnection['TOK-odd'], '@e hola');
    expect(replies()).toHaveLength(1);
    app.stop();
  });

  // ~/.egpt2 (node kg2) ships exactly this and gets the same deploy.
  it('~/.egpt2\'s `use: main` over a lone `main` block is untouched — one bridge, ear and mouth', async () => {
    const { built, replies, app } = await bootWith({
      node_name: 'kg2',
      agents: AG(),
      beeper: { use: 'main', main: { account: 'dolly@example.com', token: T_SECONDARY } },
    });
    expect(built).toHaveLength(1);
    expect(built[0].token).toBe(T_SECONDARY);
    await deliver(built[0], '@e hola');
    expect(replies().map((r) => r.connection)).toEqual(['secondary']);
    app.stop();
  });

  // No beeper: block at all — the legacy top-level token path, and not a word about ears.
  it('no beeper: block → the legacy beeper_token still resolves, and nothing is said about ingest', async () => {
    const { built, lines, replies, app } = await bootWith({ agents: AG(), beeper_token: 'TOK-legacy' });
    expect(built).toHaveLength(1);
    expect(built[0].token).toBe('TOK-legacy');
    expect(lines.filter((l) => /no INGEST connection/.test(l))).toEqual([]);
    await deliver(built[0], '@e hola');
    expect(replies()).toHaveLength(1);
    app.stop();
  });

  // ── NO EAR ⇒ LOUD ─────────────────────────────────────────────────────────────────────────
  // Half-alive is worse than down (INTENT.md). A node that declares connections and resolves no
  // ingest connection hears NOTHING, and that is invisible from the outside — it looks exactly
  // like a quiet day. It boots anyway (refusing would take the node down over a config the
  // operator can fix while it runs) and it says so, once, naming what it looked for.
  it('several connections, none named primary, no use:, no owner_node → boots and says it has NO EAR', async () => {
    const { lines, app } = await bootWith({
      agents: AG(),
      beeper: { alpha: { account: 'a@b', token: 'TOK-a' }, beta: { account: 'c@d', token: 'TOK-b' } },
    });
    const loud = lines.filter((l) => /no INGEST connection/.test(l));
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain("'alpha'");
    expect(loud[0]).toContain("'beta'");
    expect(loud[0]).toMatch(/owner_node/);
    app.stop();
  });

  // …and the one connection every ear rule would otherwise pick, owned by ANOTHER node, is the
  // same answer: held for outbound, never an ear, and the node says it is deaf.
  it('the only connection owned by another node → held as a mouth, and the node says it has NO EAR', async () => {
    const { dialled, byConnection, replies, lines, app } = await bootWith({
      agents: AG(),
      beeper: { primary: { account: 'an@example.com', token: T_PRIMARY, owner_node: 'some-other-node' } },
    });
    expect(dialled()).toEqual(['primary']);
    await deliver(byConnection.primary, '@e hola');
    expect(replies()).toEqual([]);
    expect(lines.filter((l) => /no INGEST connection/.test(l))).toHaveLength(1);
    app.stop();
  });
});
