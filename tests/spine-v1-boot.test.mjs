// boot() end-to-end: the REAL services + REAL warm pool assembled by boot(),
// with fakes ONLY at the transport (startBeeperBridge) + process (claude session)
// boundary. Drives an inbound through the fake bridge and asserts it round-trips
// to a streamed reply with the transcript written — the v1 pipe, exactly as
// production wires it, minus Beeper and minus claude. (SPINE-REWRITE-PLAN.md
// Phase 3 verify gate, offline half.)
//
// Runs against an isolated EGPT_HOME so the alive-beat heartbeat writes
// state/alive.txt into a throwaway profile, never the real ~/.egpt. egpt-home.mjs
// reads EGPT_HOME once at module load, so it's set BEFORE boot (which imports it)
// is dynamically imported below.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const tmpHome = join(os.tmpdir(), `egpt-v1-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

async function waitFor(pred, timeout = 1000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Pre-seed a conversation's E mode in the shared state (modes live in
// conversations.yaml now, not config.auto_modes). No threadId → still "fresh".
function seedMode(state, mode, chatId = '!room:beeper.com', name = 'fam') {
  const ens = ensureContact(state, 'whatsapp', chatId, { pushedName: name, slugHint: name });
  ens.state.contacts.whatsapp[chatId].mode = mode;
  return ens.state;
}

// fake Beeper transport: captures the host onIncoming so the test can drive inbound.
function fakeStart() {
  const spy = { onIncoming: null, sent: [], streams: [] };
  const start = async (opts) => {
    spy.onIncoming = opts.onIncoming;
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, spy };
}

// fake claude session: the warm pool calls makeSession(brainOptions) → { turn, close, sessionId }.
function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(message, onUpdate) { onUpdate?.(`↩ ${message}`); return { text: `↩ ${message}`, sessionId: this.sessionId }; }, close() {} };
}

// in-memory fs seam so the test NEVER writes into the real ~/.egpt profile.
const memIo = () => ({ appendFile: async () => {}, mkdir: async () => {}, existsSync: () => false });

describe('boot()', () => {
  it("assembles the v1 pipe and round-trips an 'on'-mode message bridge→brain→bridge", async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, default_brain: { type: 'ccode' } };

    const app = await boot({
      readConfig: () => config,
      startBridge: start,
      makeSession: fakeSession,
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => Date.UTC(2026, 5, 29, 14, 5),
      tickMs: 0,
      log: { line: () => {} },
    });

    expect(spy.onIncoming).toBeTypeOf('function');

    // a whatsapp message arrives in an on-mode chat
    await spy.onIncoming('hola E', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });

    // delivered as a stream-edit carrying the brain's reply. This is a FRESH
    // contact, so the brain's first turn is identity-wrapped (the beta-1 kickoff,
    // via the real readIdentityFeed / e_identity.md) — proven by the live-message
    // envelope + the dispatch line both reaching the (echoing fake) brain.
    expect(spy.streams).toHaveLength(1);
    const delivered = spy.streams[0].finals[0];
    expect(delivered).toContain('Live message from the chat (envelope');   // identity kickoff wrap
    expect(delivered).toContain('An@[fam].wa (14:05) #m1: hola E');        // the dispatch line
    expect(spy.streams[0].chatId).toBe('!room:beeper.com');
    expect(spy.sent).toHaveLength(0);   // stream delivered → no fallback send

    // the conversation's claude session was persisted onto the contact
    const c = state.contacts?.whatsapp ?? {};
    const entry = Object.values(c)[0];
    expect(entry.threadId).toBe('sess-1');

    app.stop();
  });

  it("respects gating: a 'mute' chat invokes no brain and sends nothing", async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'mute');
    const config = { whatsapp: {} };
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    await spy.onIncoming('hola', { chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', msgKey: 'm1' });
    expect(spy.streams).toHaveLength(0);
    expect(spy.sent).toHaveLength(0);
    app.stop();
  });

  it('beats alive.txt via the tick heartbeat: immediate first beat, cadence honored, tic/toc alternates', async () => {
    const { start } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, default_brain: { type: 'ccode' } };
    let clock = Date.UTC(2026, 5, 29, 14, 5);   // June 29 14:05 UTC

    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => clock,
      tickMs: 0,          // no auto-timer; we drive tick() by hand
      aliveMs: 60_000,    // register the alive writer as a 60s heartbeat
      log: { line: () => {} },
    });

    const alivePath = join(tmpHome, 'state', 'alive.txt');
    const read = async () => { try { return await fs.readFile(alivePath, 'utf8'); } catch { return ''; } };

    // boot fired one immediate beat (spine.tick() right after start)
    await waitFor(async () => (await read()).length > 0);
    const first = await read();
    expect(first).toMatch(/^tic 2026-06-29T14:05:00\.000Z \d+ q=0 oldest=0s\n$/);
    expect(Number(first.match(/ (\d+) q=/)[1])).toBe(process.pid);   // carries our pid

    // a second tick INSIDE the 60s window → still not due → no new beat
    app.spine.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(await read()).toBe(first);   // unchanged — cadence honored

    // advance past the cadence → next tick beats again, alternating to 'toc'
    clock += 60_000;
    app.spine.tick();
    await waitFor(async () => (await read()).startsWith('toc'));
    expect(await read()).toMatch(/^toc 2026-06-29T14:06:00\.000Z \d+ q=0 oldest=0s\n$/);

    app.stop();
  });
});
