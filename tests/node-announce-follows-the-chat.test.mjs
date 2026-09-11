// node-announce-follows-the-chat.test.mjs — THE NODE'S OWN LINES OBEY THE SAME RULE.
//
// THE OPERATOR'S RULE (2026-09-11, verbatim): *"self doesn't have mouth. if mouth is available
// always use mouth."* One uniform rule for every outbound this node places:
//
//     IF THE MOUTH CAN REACH THE CHAT, THE MOUTH SPEAKS. IF IT CANNOT, THE EAR DOES.
//
// 32aa5c1 built that for REPLIES (src/spine/boot.mjs outboundConnectionFor, locked in
// tests/reply-follows-the-arrival.test.mjs). THREE node-level sends bypassed it, because they
// carry no being and rode `defaultBridge` directly:
//
//   · goDown's  "↻ /restart… (pid N)"          (src/spine/boot.mjs goDown)
//   · the boot  "✅ egpt back up!" / "✅ egpt started"   (the back-up announce block)
//   · the STOP switch's "🛑 STOP received — egpt is stopping"   (stopSwitch.pull)
//
// WHY THAT IS NOT A COSMETIC MISROUTE. One real chat is a DIFFERENT Matrix room per Beeper
// account (src/bridges/beeper.mjs crossAccountChatKey's header, measured live 2026-09-05), so the
// Self-DM id `primary` minted names a room `secondary`'s install is not in. "egpt back up!"
// posted there is not the wrong voice — it is a room that does not exist, and the operator watches
// a silent chat through a restart they asked for.
//
// AND THE BOOT ANNOUNCE FIRES BEFORE ANYTHING HAS ARRIVED, so nothing is remembered about that
// chat and no arrival-shaped fallback could ever fire for it. It does not need one: reachability
// is answered from the ACCOUNT each connection declares, and the Self-DM chat id is declared in
// this node's own config (`networks.whatsapp.chat_ids`) as its command channel — a chat this node
// hears in, therefore a room on its EAR, whether or not a message has landed yet.
//
// THE SHAPE MODELLED HERE IS THE LIVE kg NODE WITH ITS CRUTCH REMOVED — `~/.egpt/config.yaml`
// carries `beeper: { use: primary }` marked TEMPORARY, and this file is what has to hold before
// that line can go: `primary` (anrodz42) is the ear, `secondary` (dolly.egpt) is what the names
// resolve OUTPUT to, and the Self-DM exists only on anrodz42.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid, the restart-announce sidecar and
// heartbeats.readonly.yaml, and files running in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-node-announce-follows-the-chat-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

const SIDECAR = join(_PRIVATE_HOME, 'state', 'restart-announce.json');
const STOP_PATH = join(_PRIVATE_HOME, 'STOP');

let boot, emptyState;
beforeAll(async () => {
  await fs.mkdir(join(_PRIVATE_HOME, 'state'), { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

// Two cases here WRITE EGPT_HOME/STOP and one leaves a sidecar behind, and both are refusals the
// NEXT boot honours ("STOP exists — egpt refuses to start"). Cleared around every case so one
// failing assertion cannot cascade into seven, and every booted app is stopped even when an
// assertion throws before its own app.stop().
const live = [];
beforeEach(async () => { await fs.rm(STOP_PATH, { force: true }); await fs.rm(SIDECAR, { force: true }); });
afterEach(async () => {
  while (live.length) { try { live.pop().stop(); } catch { /* already stopped */ } }
  await fs.rm(STOP_PATH, { force: true });
});

// ── the two connections, named the way the live node names them ─────────────────────────────
const PRIMARY = 'TOK-primary';       // anrodz42 — the EAR (boot's ear rule: 'primary' by name)
const SECONDARY = 'TOK-secondary';   // dolly.egpt — the MOUTH the names resolve output to
const NAME_OF = { [PRIMARY]: 'primary', [SECONDARY]: 'secondary' };

// THE SELF-DM — `networks.whatsapp.chat_ids[0]`, the entry the live config annotates
// "Self-DM = the operator command channel". A room on anrodz42 and on nothing else.
// It is also the ONLY chat id the three node-level sends ever carry: the safe word is honoured in
// Self alone (src/spine/spine.mjs isSelfChat), and both announces target Self by construction.
// That is exactly why the arrival map cannot answer for them and the config must.
const SELF_DM = '!self-dm-as-primary-sees-it';
// A chat this node has neither heard nor declared — the boundary of the change, locked below.
const STRANGER = '!never-heard-anywhere';

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { connection: NAME_OF[opts.beeperToken] ?? opts.beeperToken, token: opts.beeperToken, onIncoming: opts.onIncoming, sent: [], streams: [] };
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

// Complete in-memory fs seam — same shape as tests/reply-follows-the-arrival.test.mjs. The
// SIDECAR is deliberately NOT behind it: boot reads/writes that one through node:fs/promises
// directly, at the real path under this file's isolated EGPT_HOME.
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
// A heartbeat command beat must never run a real shell (boot-profile-contract's recipe).
const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

// kg's live shape with the crutch removed: two connections, NO `beeper.use`, no `owner_node`, and
// the Self-DM declared. Output → 'secondary' (nameDerivedConnection), ingest → 'primary'.
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

// THE SAME TWO CONNECTIONS ON ONE ACCOUNT — two Desktop installs of anrodz42, exactly the
// primary/primary_gui pair the operator runs. The mouth CAN reach the Self-DM here, so the mouth
// speaks: that is the other half of the rule, and it is what keeps the rule a rule rather than
// "the ear always wins".
const KG_ONE_ACCOUNT = () => {
  const c = KG();
  c.beeper.secondary.account = 'anrodz42@example.com';
  return c;
};

// A ONE-CONNECTION NODE — the INTENT.md baseline, and the lock that this costs it nothing.
const SINGLE = () => {
  const c = KG();
  delete c.beeper.secondary;
  return c;
};

async function bootWith(config, { ingest = false } = {}) {
  const { start, built } = fakeTransport();
  const lines = [];
  const exits = [];
  let convState = emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: start,
    makeSession: fakeSession,
    probeEndpoint: fakeProbe,
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(),
    ingest,
    spawn: fakeSpawn,
    reapPort: () => 0,            // never taskkill a real process from a test
    exit: (code) => exits.push(code),
    now: () => Date.UTC(2026, 8, 11, 14, 5),
    tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  live.push(app);
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  // Every line that LEFT the node, whichever connection carried it.
  const posted = () => built.flatMap((s) => s.sent.map((m) => ({ connection: s.connection, chatId: m.chatId, text: m.text })));
  return { app, built, byConnection, posted, lines, exits };
}

// The announce block is a fire-and-forget async IIFE (real fs, real bridge.send) — poll briefly
// instead of guessing a number of microtask ticks.
async function waitFor(check, { timeoutMs = 2000, stepMs = 10 } = {}) {
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

describe('a node-level send rides the connection that can REACH the chat, not the default mouth', () => {
  // ── THE REPRODUCTION ──────────────────────────────────────────────────────────────────────
  // The earliest outbound of the process, with the arrival map necessarily EMPTY. Before this it
  // rode `defaultBridge` — 'secondary', dolly.egpt — carrying a chatId only anrodz42 has.
  it('the COLD-BOOT announce goes out on primary, with nothing ever having arrived', async () => {
    const { app, byConnection, posted } = await bootWith(KG(), { ingest: true });

    // The precondition: this really is the split shape — both connections held, only one ear.
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    await waitFor(() => posted().length > 0);
    expect(posted().map((p) => ({ connection: p.connection, chatId: p.chatId }))).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    expect(posted()[0].text).toContain('egpt started');
    expect(byConnection.secondary.sent).toEqual([]);
    app.stop();
  });

  // …and the RESTART half of the same pair, read back off the sidecar goDown (or the daemon's
  // crash/wedge fallback) left behind.
  it('the "back up!" announce read off the sidecar goes out on primary', async () => {
    await fs.writeFile(SIDECAR, JSON.stringify({ chatId: SELF_DM, kind: '/restart', preSha: 'abc123', pid: 999 }), 'utf8');
    const { app, byConnection, posted } = await bootWith(KG(), { ingest: true });

    await waitFor(() => posted().length > 0);
    expect(posted().map((p) => ({ connection: p.connection, chatId: p.chatId }))).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    expect(posted()[0].text).toContain('egpt back up!');
    expect(byConnection.secondary.sent).toEqual([]);
    app.stop();
  });

  // ── goDown's GOING-DOWN LINE ──────────────────────────────────────────────────────────────
  // `/restart` typed in Self leaves through the injected `exit` seam (boot: exit:
  // announceAndExit), which posts "↻ /restart…" before the process goes.
  it('the going-down "↻ /restart…" line goes out on primary', async () => {
    const { app, byConnection, posted, exits } = await bootWith(KG());
    await deliver(byConnection.primary, SELF_DM, '/restart');
    await waitFor(() => posted().some((p) => p.text.includes('↻')));

    const going = posted().filter((p) => p.text.includes('↻'));
    expect(going.map((p) => ({ connection: p.connection, chatId: p.chatId }))).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    expect(exits).toEqual([43]);
    expect(byConnection.secondary.sent).toEqual([]);
    app.stop();
  });

  // ── THE STOP CONFIRMATION ─────────────────────────────────────────────────────────────────
  // The safe word is honoured in Self alone, and the confirmation must land in the chat it came
  // from — which is a room the mouth's account is not in.
  it('the STOP confirmation goes out on primary', async () => {
    const { app, byConnection, posted, exits } = await bootWith(KG());
    await deliver(byConnection.primary, SELF_DM, 'stop');
    await waitFor(() => posted().some((p) => p.text.includes('STOP received')));

    const stop = posted().filter((p) => p.text.includes('STOP received'));
    expect(stop.map((p) => ({ connection: p.connection, chatId: p.chatId }))).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    expect(exits).toEqual([0]);
    expect(byConnection.secondary.sent).toEqual([]);
    app.stop();
  });

  // ── A COMMAND REPLY IS THE NODE SPEAKING TOO ──────────────────────────────────────────────
  // Not one of the three announces, and found while auditing what else rode `defaultBridge`:
  // every command reply (`/status`, `/agents`, `/config`, …) leaves through boot's
  // commandTranscript.send, which had the plain default bridge hard-wired. A command is typed
  // overwhelmingly in Self, so with the crutch removed `/status` would have answered into a room
  // dolly.egpt does not have — the operator's very next keystroke after the deploy.
  it('a COMMAND reply typed in Self is answered on primary', async () => {
    const { app, byConnection, posted } = await bootWith(KG());
    await deliver(byConnection.primary, SELF_DM, '/status');
    await waitFor(() => posted().length > 0);

    expect(posted().map((p) => p.connection)).toEqual(['primary']);
    expect(posted()[0].chatId).toBe(SELF_DM);
    expect(byConnection.secondary.sent).toEqual([]);
    app.stop();
  });

  // ── NEVER SILENT, AND NEVER VAGUE ─────────────────────────────────────────────────────────
  // A line that came out of an account the operator did not pin has to be findable, and the log
  // has to say WHICH of the two facts answered it — one is measured (the message arrived there),
  // the other is read off the config (this is the node's own Self chat). The resolver is the same
  // for replies; only the provenance clause differs, so it is the clause this locks.
  it('says out loud that the Self chat is on the ear and the mouth is another account', async () => {
    const { app, posted, lines } = await bootWith(KG(), { ingest: true });
    await waitFor(() => posted().length > 0);

    const said = lines.filter((l) => l.includes('is a chat on'));
    expect(said, lines.join('\n')).toHaveLength(1);
    expect(said[0]).toContain("is a chat on 'primary'");
    expect(said[0]).toContain("this node's Self chat, declared in config");
    expect(said[0]).toContain("'secondary' is a different Beeper account");
    app.stop();
  });
});

describe('…and the mouth still speaks wherever the mouth can reach', () => {
  // THE OTHER HALF OF THE RULE, and the reason it is not "the ear always wins": two connections
  // on ONE account (primary / primary_gui, two Desktop installs) see the same rooms under the
  // same ids, so the default mouth reaches the Self-DM and the default mouth is what speaks.
  it('two connections on the SAME account — the node-level announce rides the MOUTH', async () => {
    const { app, byConnection, posted } = await bootWith(KG_ONE_ACCOUNT(), { ingest: true });
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    await waitFor(() => posted().length > 0);
    expect(posted().map((p) => ({ connection: p.connection, chatId: p.chatId }))).toEqual([{ connection: 'secondary', chatId: SELF_DM }]);
    expect(byConnection.primary.sent).toEqual([]);
    app.stop();
  });

  // THE BASELINE LOCK: one connection, one bridge, nothing to choose between.
  it('a ONE-connection node is untouched', async () => {
    const { app, built, posted } = await bootWith(SINGLE(), { ingest: true });
    expect(built.map((s) => s.connection)).toEqual(['primary']);

    await waitFor(() => posted().length > 0);
    expect(posted().map((p) => ({ connection: p.connection, chatId: p.chatId }))).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    app.stop();
  });

  // THE BOUNDARY, stated so the next reader does not widen it by accident. A chat that is neither
  // remembered nor declared is UNKNOWN, and the mouth answers exactly as it did before any of
  // this existed — a mouth-only connection is deaf, so its own chats never reach the arrival map
  // and must not be dragged onto the ear.
  it('a sidecar naming a chat this node has neither heard nor declared still rides the mouth', async () => {
    await fs.writeFile(SIDECAR, JSON.stringify({ chatId: STRANGER, kind: '/restart', preSha: 'abc123', pid: 999 }), 'utf8');
    const { app, posted } = await bootWith(KG(), { ingest: true });

    await waitFor(() => posted().length > 0);
    expect(posted().map((p) => ({ connection: p.connection, chatId: p.chatId }))).toEqual([{ connection: 'secondary', chatId: STRANGER }]);
    app.stop();
  });
});

// EVERY sender boot builds must carry the per-chat resolver, not one frozen bridge.
//
// `memberSender` was constructed with `bridge:` alone and NO `bridgeOf:` -- so it held the
// node's default mouth for every chat, and a @member reply into a chat heard on the ear posted
// on the mouth, naming a room that account does not have. The persona sender got
// shellAwareBridgeOf in 32aa5c1; this one was missed, and the defect stayed live for members
// only. A source-shape lock rather than a behavioural one because the miss is STRUCTURAL: the
// argument was simply absent, and no amount of exercising that sender would have said so.
describe('every sender boot builds resolves its bridge per chat', () => {
  it('no createSender( in boot.mjs passes `bridge:` without `bridgeOf:`', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../src/spine/boot.mjs', import.meta.url)), 'utf8');
    const calls = [...src.matchAll(/createSender\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);            // the scan itself must not silently find nothing
    for (const call of calls) {
      expect(call, `a createSender without bridgeOf:
${call}`).toContain('bridgeOf');
    }
  });

  // …AND THE SAME MISS, IN THE SAME SHAPE, IN THE LAST SERVICE THAT HAD IT (operator 2026-09-11).
  // createMeshService was constructed with `bridge:` alone, so every line the mesh placed — the 🤔
  // placeholder in the ORIGIN chat, the living mirror that is a mesh hop's whole visible output,
  // the origin-wait notice, and the RESPONDER's reply into the room the envelope arrived in — rode
  // the node's default mouth carrying ids that only the ear's account has. Structural, like the
  // one above: the argument was simply absent.
  it('createMeshService in boot.mjs is built with bridgeOf too', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../src/spine/boot.mjs', import.meta.url)), 'utf8');
    const calls = [...src.matchAll(/createMeshService\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0], `createMeshService without bridgeOf:
${calls[0]}`).toContain('bridgeOf');
  });

  // …AND THE WHOLE HOP, THROUGH THE REAL BOOT. A relay agent, a human's `@don hola` arriving on
  // the EAR, and every byte the node then places measured per connection. Nothing here is a
  // service-level fake: this is boot's own resolver answering about a chat it learned from a real
  // arrival. (The relay_channel NAME cannot resolve in this harness — the chat list is an HTTP
  // walk the fake transport does not serve — so the hop takes the Self fallback, which is the
  // same ear path. That a NAME resolves and rides the MOUTH is locked at the service level, in
  // tests/spine-mesh.test.mjs "THE TRANSPORT DOES NOT MOVE", and by the sidecar case above:
  // an unplaceable chat rides the mouth, and a name is unplaceable.)
  it('a whole mesh hop: the origin chat is placed on the EAR, and the mouth carries nothing', async () => {
    const cfg = KG();
    cfg.agents.don = { relay_channel: 'rodz1', to: 'don.do', handles: ['don'] };
    const ORIGIN = '!group-on-primary';
    const { byConnection, posted, lines } = await bootWith(cfg, { ingest: true });
    await deliver(byConnection.primary, ORIGIN, '@don hola');
    await waitFor(() => posted().some((p) => p.text.startsWith('```')));

    // NOTHING on the mouth — before this, all of it went there, carrying primary's ids.
    expect(byConnection.secondary.sent).toEqual([]);
    expect(byConnection.secondary.streams).toEqual([]);

    // boot's resolver was ASKED about the origin chat, and answered with the connection it
    // arrived on. This line is the whole change in one sentence, and it never used to be said.
    expect(lines.filter((l) => l.includes(`${ORIGIN} is a chat on 'primary'`)).join('|')).toContain('(it arrived there)');

    // the envelope itself, on primary, carrying the body the ORIGIN stripped its own handle from
    // (8edffe9) and which the responder no longer rewrites: base64('hola'), not '@don hola'.
    const envelope = posted().find((p) => p.text.startsWith('```'));
    expect(envelope.connection).toBe('primary');
    expect(envelope.text).toContain(Buffer.from('hola').toString('base64'));
    expect(envelope.text).not.toContain(Buffer.from('@don hola').toString('base64'));
  });
});
