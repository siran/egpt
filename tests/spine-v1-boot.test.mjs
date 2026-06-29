// boot() end-to-end: the REAL services + REAL warm pool assembled by boot(),
// with fakes ONLY at the transport (startBeeperBridge) + process (claude session)
// boundary. Drives an inbound through the fake bridge and asserts it round-trips
// to a streamed reply with the transcript written — the v1 pipe, exactly as
// production wires it, minus Beeper and minus claude. (SPINE-REWRITE-PLAN.md
// Phase 3 verify gate, offline half.)
import { describe, it, expect } from 'vitest';
import { boot } from '../src/spine/boot.mjs';
import { emptyState } from '../conversations-state.mjs';

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
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(message) { return { text: `↩ ${message}`, sessionId: this.sessionId }; }, close() {} };
}

// in-memory fs seam so the test NEVER writes into the real ~/.egpt profile.
const memIo = () => ({ appendFile: async () => {}, mkdir: async () => {}, existsSync: () => false });

describe('boot()', () => {
  it("assembles the v1 pipe and round-trips an 'on'-mode message bridge→brain→bridge", async () => {
    const { start, spy } = fakeStart();
    let state = emptyState();
    const config = { auto_modes: { '!room:beeper.com': { e: 'on' } }, whatsapp: {}, default_brain: { type: 'ccode' } };

    const app = await boot({
      readConfig: () => config,
      startBridge: start,
      makeSession: fakeSession,
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: memIo(),
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
    let state = emptyState();
    const config = { auto_modes: { '!room:beeper.com': { e: 'mute' } }, whatsapp: {} };
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), tickMs: 0, log: { line: () => {} },
    });
    await spy.onIncoming('hola', { chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', msgKey: 'm1' });
    expect(spy.streams).toHaveLength(0);
    expect(spy.sent).toHaveLength(0);
    app.stop();
  });
});
