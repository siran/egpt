// single-account-node.test.mjs — THE BASELINE, LOCKED.
//
// Operator, 2026-09-03: *"it is very important to understand that egpt can and must be able to
// run on a single beeper account. like it has always. all in s1. we have expanded the system
// into a multi-account s0->s1(an) dance. but we must keep simplicity for everyone. all that is
// needed in principle is one beeper token and to clone the egpt repo."*
//
// Two days of expansion put a lot of optional machinery around that baseline — `owner_node` on a
// connection, `base_url`/`ws_url`, multi-candidate `endpoints:` with boot-time probing, inbound
// fanout across several bridges, `fallback_handle.unless_peer_alive` with a peer-liveness
// watcher, per-agent `scope:` pins, per-conversation `compaction:`. Every one of them was WRITTEN
// to be additive, and each has its own test proving its own behavior. Nothing, however, was
// proving the OTHER side of that word: that a node configuring NONE of it still costs nothing —
// no probe, no wrapper, no watcher, no second bridge. That is what this file is for.
//
// So every case here boots the SMALLEST config that should work — one `beeper.main` carrying a
// token, `node_name`, `user_name`, and the shipped default `agents:` block — and asserts the
// expansion machinery stayed asleep. The last describe goes one step further and boots the
// SHIPPED SKELETON itself (config/skeletons/config.yaml, the file the README tells a new user to
// copy), so "one token and a clone" is verified against the actual file we hand them, not against
// a hand-written fixture that happens to resemble it.
//
// NOT DUPLICATED HERE, deliberately — each already has its own lock:
//   · fanoutInbound's single-connection identity rule ......... tests/bridge-fanout.test.mjs
//   · fallbackWake on malformed/absent declarations ........... tests/spine-router.test.mjs
//   · `addressed(..., withFallback)` on fallback-less agents ... tests/spine-router.test.mjs:706
//   · a conversation with NO `compaction:` block resolving to the node-global block (and, with no
//     node block either, to the built-in defaults) ............ tests/compaction-overrides.test.mjs
//     ("REGRESSION: afterTurn with NO compaction field resolves exactly as before")
//   · a connection with base_url, and a config with no beeper block, making zero probe calls
//     .......................................................... tests/beeper-endpoint-candidates.test.mjs
//     (this file covers the shape those two do NOT: a `beeper.use` connection with a token and
//     nothing else — the one the skeleton actually ships)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid and heartbeats.readonly.yaml, and files running
// in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-single-account-node-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { fanoutInbound } from '../src/spine/bridge-fanout.mjs';   // no imports of its own → safe to static-import

// boot + the two readers it shares with the spine pull in egpt-home.mjs, so they load AFTER the
// hoisted EGPT_HOME above.
let boot, emptyState, ensureContact, fallbackWake;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
  ({ fallbackWake } = await import('../src/spine/router.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const TOKEN = 'TOK-single';

// THE WHOLE CONFIG. One connection carrying one token, this node's name, the human's name, and
// the shipped persona. No base_url, no ws_url, no owner_node, no endpoints, no fallback_handle,
// no scope, no compaction, no account_peers, no networks block.
const MINIMAL = () => ({
  node_name: 'kg',
  user_name: 'John',
  beeper: { use: 'main', main: { account: 'you@example.com', token: TOKEN } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
});

// Complete in-memory fs seam — transcript/stats run their real read/merge/write paths without
// touching the host filesystem (same shape as tests/spine-v1-boot.test.mjs).
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

// The transport seam. One spy per startBridge CALL (not per token) — the count IS the assertion
// for "exactly one bridge", and each spy holds the onIncoming the port late-binds so a case can
// drive a real inbound through it.
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, sent: [], streams: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// The endpoint probe seam. It records every call and answers nothing useful — a boot that reaches
// it at all has already failed the assertion that matters.
function fakeProbe() {
  const calls = [];
  return { calls, probe: async (baseUrl, token, opts) => { calls.push({ baseUrl, token, timeoutMs: opts?.timeoutMs }); return { ok: false, status: 0 }; } };
}

async function bootWith(config, { state } = {}) {
  const { start, built } = fakeTransport();
  const { probe, calls } = fakeProbe();
  const lines = [];
  let convState = state ?? emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: start,
    makeSession: fakeSession,
    probeEndpoint: probe,
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    now: () => Date.UTC(2026, 8, 3, 14, 5),
    log: { line: (s) => lines.push(s) },
  });
  return { app, built, opts: built[built.length - 1]?.opts, probeCalls: calls, lines };
}

// Pre-seed a conversation's persona mode ('on' replies unconditionally). The persona's mention
// gate reads ev.mention, which the REAL bridge computes from the wake words; this fake transport
// is a stub that never does, so the wake round-trip below seeds the mode instead of relying on it.
function seedOn(chatId = '!room:beeper.com', name = 'fam') {
  const ens = ensureContact(emptyState(), 'whatsapp', chatId, { pushedName: name, slugHint: name });
  const entry = ens.state.contacts.whatsapp[chatId];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
  return ens.state;
}

describe('ONE beeper token, ONE account, ONE node — the baseline that must never grow a requirement', () => {
  it('boots, with one persona agent, on a config that declares nothing but a token, a node name and the shipped agents block', async () => {
    const { app, opts } = await bootWith(MINIMAL());
    expect(app).toBeTruthy();

    // exactly one agent, and it IS the persona — the `default: true` boot refuses to start without
    const declared = Object.entries(app.cfg.agents ?? {});
    expect(declared.map(([name]) => name)).toEqual(['egpt']);
    expect(declared.filter(([, a]) => a?.default === true)).toHaveLength(1);

    // …and boot resolved that persona all the way through to the bridge's wake vocabulary, so
    // "it booted" means "it can be addressed", not merely "it did not throw".
    expect([...opts.wakeWords].sort()).toEqual(['e', 'egpt']);
    expect(app.accountPeers).toEqual([]);   // solo node — no co-account peer set to complete

    app.stop();
  });

  // THE ONE THAT COSTS A NEW USER SOMETHING IF IT BREAKS. Candidate probing (operator 2026-09-03)
  // exists for a Desktop that CHANGES IDENTITY under the node; a plain token-only connection must
  // never pay for it with an HTTP call — nor with the 2s-per-candidate wait a black-holed port
  // costs. tests/beeper-endpoint-candidates.test.mjs locks the base_url and no-beeper-block
  // shapes; this locks the shape the skeleton actually ships, a `beeper.use` connection whose
  // block carries nothing but `account` and `token`.
  it('makes ZERO network probes at boot — candidate resolution stays opt-in', async () => {
    const { app, probeCalls } = await bootWith(MINIMAL());
    expect(probeCalls).toEqual([]);
    app.stop();
  });

  it('constructs exactly ONE bridge, on the plain endpoint: the config token, no baseUrl, no owner', async () => {
    const { app, built, opts, lines } = await bootWith(MINIMAL());

    expect(built).toHaveLength(1);              // one connection ⇒ one startBridge call, never one per declared account
    expect(opts.beeperToken).toBe(TOKEN);

    // baseUrl/wsUrl must be ABSENT, not undefined-valued: boot spreads them in only when set
    // precisely so startBeeperBridge's own http://127.0.0.1:23373 default stands. An explicit
    // `baseUrl: undefined` would override that default with nothing.
    expect('baseUrl' in opts).toBe(false);
    expect('wsUrl' in opts).toBe(false);

    // ownerNode null ⇒ this node owns the connection, so boot never wrapped it outbound-only.
    // That decision is made once, in boot, and announced on this line; its absence is the
    // observation. (What ownership MEANS for inbound is the next case.)
    expect(lines.filter((l) => /owned by node/.test(l))).toEqual([]);

    app.stop();
  });

  // WAKES. With no `owner_node` the bridge is the real port, not the outbound-only Proxy whose
  // onMessage/onEdit/onMedia are no-ops — so an inbound registration actually reaches it. Proven
  // end to end rather than by inspecting a flag: a message arrives on the one connection and a
  // reply goes back out of it. Under an outbound-only wrap the spine's onMessage registration is
  // swallowed, onIncoming finds no handler, and nothing at all comes back.
  it('WAKES on its one connection — an inbound reaches the spine and the reply goes back out', async () => {
    const { app, built } = await bootWith(MINIMAL(), { state: seedOn() });
    const spy = built[0];
    expect(spy.onIncoming).toBeTypeOf('function');

    await spy.onIncoming('hola E', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });

    expect(spy.streams).toHaveLength(1);
    expect(spy.streams[0].finals[0]).toContain('hola E');
    expect(spy.streams[0].chatId).toBe('!room:beeper.com');

    app.stop();
  });

  // NO FANOUT WRAPPER. bridge-fanout.mjs promises a single connection gets "not merely equivalent
  // but IDENTICAL" — the bridge itself, not a Proxy around it. Observed by IDENTITY: the facade's
  // trap mints a FRESH closure for the fanned-out keys on every property read, while a real
  // bridge hands back its own stable method (boot's lasso wrap forwards these via Reflect.get, so
  // it is transparent here). The control at the end proves the discriminator has teeth rather
  // than passing on any object at all.
  it('builds NO fanout wrapper — the spine holds the single bridge itself', async () => {
    const { app } = await bootWith(MINIMAL());

    expect(app.bridge.onMessage).toBe(app.bridge.onMessage);
    expect(app.bridge.onEdit).toBe(app.bridge.onEdit);
    expect(app.bridge.onMedia).toBe(app.bridge.onMedia);
    expect(app.bridge.stop).toBe(app.bridge.stop);

    // …and fanoutInbound over that same bridge, given a SECOND connection, is distinguishable by
    // exactly that test — so the assertions above are about the wrapper's absence, not a tautology.
    const wrapped = fanoutInbound(app.bridge, [app.bridge, app.bridge]);
    expect(wrapped.onMessage).not.toBe(wrapped.onMessage);
    expect(fanoutInbound(app.bridge, [app.bridge])).toBe(app.bridge);

    app.stop();
  });

  // NOTHING DECLARED, NOTHING EMITTED. `fallback_handle` (operator 2026-08-31) is how a node
  // conditionally answers on a handle that belongs to another account; a node that declares none
  // must resolve none — the shape the router then never consults. Locked against the config boot
  // ACTUALLY RESOLVED (app.cfg), not a hand-built literal: the risk this guards is a future
  // change deriving a fallback implicitly (say, from `handles:` or from the persona flag), which
  // a literal `{}` fixture could never catch. The malformed/absent cases and the "vocabulary
  // unchanged" property are spine-router.test.mjs's, and are not repeated here.
  it('declares no fallback handle, so the node emits none — the fallback machinery stays inert', async () => {
    const { app } = await bootWith(MINIMAL());
    for (const [name, agent] of Object.entries(app.cfg.agents ?? {})) {
      expect(agent.fallback_handle, `${name} grew a fallback_handle it never declared`).toBeUndefined();
      expect(fallbackWake(agent), `${name} resolved a fallback from a config that declares none`).toBeNull();
    }
    app.stop();
  });

  // NO WATCHER. boot builds one createPeerLiveness per DISTINCT port an agent's
  // `fallback_handle.unless_peer_alive` names; declaring none must build none — otherwise a
  // single-account node would sit probing a TCP port forever for a peer spine it does not have.
  // boot injects no timer seam into the watcher (it takes the real setInterval), so the
  // observation is the line boot logs unconditionally the moment it starts one. The control at
  // the end fires that line from a config that DOES declare a peer, proving its absence above
  // means "no watcher" rather than "no logging".
  it('starts NO peer-liveness watcher when no peer is configured', async () => {
    const { app, lines } = await bootWith(MINIMAL());
    expect(lines.filter((l) => l.startsWith('[peer]'))).toEqual([]);
    app.stop();

    const withPeer = await bootWith({
      ...MINIMAL(),
      agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, fallback_handle: { handle: ['rodz'], unless_peer_alive: 23376 } } },
    });
    expect(withPeer.lines.filter((l) => /^\[peer\] watching the peer spine on :23376/.test(l))).toHaveLength(1);
    withPeer.app.stop();   // stops the probe before its first 5s interval ever fires
  });
});

// ── THE SHIPPED SKELETON IS A WORKING CONFIG ────────────────────────────────────────────────
// config/skeletons/config.yaml is the file the README tells a new user to copy, and boot()'s own
// error messages point at it by name ("See config/skeletons/config.yaml"). tests/skeletons.test.mjs
// already checks that it parses and that its keys are in CONFIG_SCHEMA — neither of which proves
// it BOOTS. This does: parse the file with the same YAML.parse readConfigSync performs, fill in
// the one blank it asks for, and run the real boot() over the result.
describe('config/skeletons/config.yaml — the file a new user copies actually boots', () => {
  const SKELETON = fileURLToPath(new URL('../config/skeletons/config.yaml', import.meta.url));
  const PLACEHOLDER = 'PASTE_YOUR_TOKEN_HERE';
  const filled = () => {
    const text = readFileSync(SKELETON, 'utf8');
    // The placeholder is the ONE blank the file asks for. If it is ever renamed, this test must
    // fail rather than silently boot a config with a literal placeholder token in it.
    expect(text, 'the skeleton no longer carries the token placeholder').toContain(PLACEHOLDER);
    return YAML.parse(text.split(PLACEHOLDER).join(TOKEN));
  };

  it('carries everything boot() structurally requires — and boots, on one bridge, with no probing', async () => {
    const cfg = filled();

    // The three structural requirements boot throws on, checked as claims about the FILE first so
    // a failure names which one rotted rather than surfacing as an opaque boot error.
    expect(String(cfg.node_name ?? '').trim(), 'skeleton must set node_name — boot refuses to start without one').toBeTruthy();
    const use = cfg.beeper?.use;
    expect(use, 'skeleton must name which connection this node uses').toBeTruthy();
    expect(cfg.beeper?.[use], `beeper.use names "${use}" but no such block exists`).toBeTypeOf('object');
    expect(cfg.beeper[use].token, `beeper.${use} must carry a token`).toBe(TOKEN);
    const personas = Object.entries(cfg.agents ?? {}).filter(([, a]) => a?.default === true);
    expect(personas, 'skeleton must declare exactly one `default: true` persona agent').toHaveLength(1);

    // …and the proof that the list above is COMPLETE: the real boot() runs on it.
    const { app, built, opts, probeCalls } = await bootWith(cfg);
    expect(built).toHaveLength(1);
    expect(opts.beeperToken).toBe(TOKEN);
    expect(probeCalls).toEqual([]);
    expect(Object.entries(app.cfg.agents).filter(([, a]) => a?.default === true)).toHaveLength(1);
    app.stop();
  });

  // FINDING (2026-09-03) — reported, NOT fixed here: this brief is tests-only and the fix is an
  // edit to the shipped file, which is the operator's call.
  //
  // The skeleton ships `name:` COMMENTED OUT and documents it as "defaults to the key". That
  // stopped being true on 2026-09-01 (operator: "please don't use the yaml array key as
  // name... that is why agents have name"): boot's labelOf no longer falls back to the key, so
  // an agent with no `name:` stamps BLANK and boot says so at every startup. A new user copying
  // this file therefore gets a persona whose replies read "🐶 : <reply>" until they find the
  // commented line — the file is a working config, but not a finished one.
  //
  // What SHOULD be true here is `toEqual([])`: the shipped file booting with nothing to complain
  // about. Until it is fixed (uncomment `name: "egpt"`, drop the stale "defaults to the key"
  // note), this pins the ONE known complaint — so a SECOND wart cannot slip in unnoticed, and so
  // fixing this one fails HERE and gets the assertion tightened to the empty list on purpose.
  // THE SHIPPED FILE BOOTS CLEAN — no warnings at all. This started as a test pinning ONE
  // complaint: the skeleton shipped `name:` commented out, described as defaulting to the map
  // key, which stopped being true on 2026-09-01 when labelOf's key fallback was removed. So a
  // new user copying this file got replies stamped `🐶 : <reply>` plus a warning at every
  // startup until they found the commented line — a first-run defect on the exact path the
  // operator asked to keep simple. `name:` is set in the skeleton now, and this asserts the
  // empty list rather than a known wart, so the NEXT one cannot arrive unnoticed either.
  it('boots the shipped skeleton with ZERO complaints', async () => {
    const { app, lines } = await bootWith(filled());
    expect(lines.filter((l) => l.startsWith('[boot]'))).toEqual([]);
    app.stop();
  });

  it('ships NONE of the multi-account expansion keys — a fresh install starts on the simple path', async () => {
    const cfg = filled();
    const conn = cfg.beeper[cfg.beeper.use];
    // Uncommenting one of these is a deliberate step a node takes when it grows into a second
    // Beeper Desktop or a second node on one account. Shipping any of them SET would hand every
    // new user the expanded path (and, for `endpoints:`, a boot-time HTTP probe) by default.
    expect(Object.keys(conn).sort()).toEqual(['account', 'token']);
    expect(cfg.account_peers).toBeUndefined();
    for (const [name, agent] of Object.entries(cfg.agents ?? {})) {
      expect(agent.fallback_handle, `${name} ships a fallback_handle`).toBeUndefined();
      expect(agent.scope, `${name} ships a scope pin`).toBeUndefined();
      expect(agent.beeper_connection, `${name} ships a beeper_connection`).toBeUndefined();
    }
  });
});
