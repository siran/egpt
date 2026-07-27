// RECENT CONTEXT (operator 2026-07-26) — the live failure this locks:
//
//   In a real WhatsApp group the operator wrote a long message about skin cells and
//   sweat (no @e), then asked `@e da una opinión bien fundamentada`. E answered with an
//   essay about rum arbitrage — the topic from twenty minutes earlier — because
//   send_to_egpt:'mode' means E only runs a turn on messages it will ANSWER. The skin
//   message was in transcript.md but was never handed to E, and E did not go read it.
//
// `recent_context` is the per-conversation opt-in that closes that gap: on a turn that
// was going to happen anyway, everything said SINCE THIS BEING'S LAST TURN is read back
// out of transcript.md and injected as LABELLED context beside the triggering prompt.
// That boundary is exactly the set E never saw — its warm session already holds
// everything up to its own last reply — so there is no overlap and no clock to parse.
// It is NOT a mode (AUTO_MODES must never regain 'accum'), it adds no buffer, and with
// the option OFF the prompt is byte-identical to today.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { formatDispatchLine } from '../src/dispatch-line.mjs';
import { contextSinceLastTurn, promptWithRecentContext, replyLine, RECENT_CONTEXT_MAX_CHARS } from '../src/transcript-log.mjs';
import { AUTO_MODES, isAutoMode, replyAllowed } from '../src/auto-mode.mjs';
import { createGating } from '../src/spine/gating.mjs';

// --- the live chat, as fakes -------------------------------------------------
// The transcript fake is the POINT: a real append-only buffer written through the REAL
// line formatters, so what the spine reads back is shaped exactly like the live file.
function fakeTranscript() {
  return {
    text: '',
    entries: [],
    async log(ev, reply) {
      this.entries.push({ ev, reply });
      this.text += (reply == null
        ? (ev.line ?? ev.body)
        : replyLine({ being: `${reply.being ?? 'e'}.kg`, body: reply.text, surfaced: reply.surfaced !== false })) + '\n\n';
    },
  };
}

function fakeBridge() {
  let cb = null;
  return { sent: [], onMessage(fn) { cb = fn; }, send(chat, text) { this.sent.push({ chat, text }); }, emit(msg) { return cb(msg); }, stop() {} };
}
function fakeBrain() {
  return { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: 'ok', sessionId: 's1', being }; } };
}
function fakeSender(bridge) {
  return { open(chatId) { return { update() {}, fail() {}, async finish(reply, { surface = true } = {}) { const t = typeof reply === 'string' ? reply : reply?.text; if (surface && t) bridge.send(chatId, t); } }; } };
}
const fakeHeartbeats = () => ({ runDue() {} });

// identity.build through the REAL dispatch-line formatter, so the transcript the spine
// reads back carries the real `Sender@[chat].node (HH:MM) #id: body` shape.
const fakeIdentity = {
  build: (msg) => ({ ...msg, line: formatDispatchLine({ senderName: msg.senderName, chatName: msg.chatName, node: 'wa', body: msg.body, ts: msg.ts, msgId: msg.msgId }) }),
};
const fakeRouter = { resolve: () => 'e' };

// mention-mode gating, exactly like the live chat: @e anywhere → reply; otherwise the
// message is recorded only (send_to_egpt: 'mode' — E never runs a turn on it).
function mentionGating(recentContextChars = 0) {
  return {
    async decide(_being, ev) {
      const mayReply = /@e\b/.test(ev.body);
      return { mode: 'mention', receives: true, mayReply, sendToEgpt: 'mode', recentContextChars };
    },
    surfaces: (d) => d.mayReply,
  };
}

const T = Date.parse('2026-07-26T22:00:00Z');
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: 'chat-1', chatName: 'grupo', senderId: 'u-1', senderName: 'An', kind: 'text', raw: {} };
const RUM = 'el arbitraje del ron en venezuela sigue siendo lo mas rentable';
const SKIN = 'las celulas de la piel se renuevan y el sudor arrastra sales, pensaba en eso hoy';
const ASK = '@e da una opinion bien fundamentada';
const OLD = 'esto se dijo antes del ultimo turno de e';

function build({ recentContextChars = 0, readTranscript = null } = {}) {
  const bridge = fakeBridge();
  const brain = fakeBrain();
  const transcript = fakeTranscript();
  const spine = createSpine({
    bridge, brain,
    identity: fakeIdentity, router: fakeRouter,
    gating: mentionGating(recentContextChars),
    sender: fakeSender(bridge), transcript, heartbeats: fakeHeartbeats(),
    readTranscript: readTranscript ?? (async () => transcript.text),
    clock: { now: () => T + 20 * 60_000 },
  });
  return { spine, bridge, brain, transcript };
}

// The whole incident, in arrival order: rum, then the un-mentioned skin message, then
// the mention that leans on it.
async function playIncident(bridge) {
  await bridge.emit({ ...CHAT, msgId: 'm1', ts: T, body: RUM });
  await bridge.emit({ ...CHAT, msgId: 'm2', ts: T + 10 * 60_000, body: SKIN });
  await bridge.emit({ ...CHAT, msgId: 'm3', ts: T + 20 * 60_000, body: ASK });
}

describe('recent_context — the un-mentioned antecedent reaches the prompt', () => {
  it('OFF (today): the un-mentioned message NEVER reaches the prompt — the live failure', async () => {
    const { spine, bridge, brain } = build({ recentContextChars: 0 });
    spine.start();
    await playIncident(bridge);

    expect(brain.calls).toHaveLength(1);                 // only the mention ran a turn
    const prompt = brain.calls[0].ev.line;
    expect(prompt).not.toContain(SKIN);                  // ← this is why E answered about rum
    expect(prompt).toContain(ASK);
  });

  it('OFF: the prompt is BYTE-IDENTICAL to the plain dispatch line', async () => {
    const { spine, bridge, brain, transcript } = build({ recentContextChars: 0 });
    spine.start();
    await playIncident(bridge);
    const inbound = transcript.entries.filter((e) => e.reply == null);
    expect(brain.calls[0].ev.line).toBe(inbound[2].ev.line);
  });

  it('ON: the un-mentioned message arrives as LABELLED context and the mention is THE prompt', async () => {
    const { spine, bridge, brain } = build({ recentContextChars: RECENT_CONTEXT_MAX_CHARS });
    spine.start();
    await playIncident(bridge);

    expect(brain.calls).toHaveLength(1);                 // no extra turn — same WHEN, more WHAT
    const prompt = brain.calls[0].ev.line;

    // the antecedent is there…
    expect(prompt).toContain(SKIN);
    expect(prompt).toContain(RUM);
    // …and it is unmistakably labelled as context, not as the question
    expect(prompt.startsWith('THIS LINE IS THE PROMPT')).toBe(true);
    expect(prompt).toContain('ACCUMULATED CONTEXT');
    // the triggering line is what must be answered: it sits under the prompt label,
    // ABOVE the context header — nothing else does.
    const cut = prompt.indexOf('ACCUMULATED CONTEXT');
    const head = prompt.slice(0, cut);
    expect(head).toContain(ASK);
    expect(head).not.toContain(SKIN);
    // and the trigger is not ALSO repeated inside the context block
    expect(prompt.slice(cut)).not.toContain(ASK);
  });

  it("ON: the window stops at E's OWN last reply — E is never re-fed what it already holds", async () => {
    const { spine, bridge, brain } = build({ recentContextChars: RECENT_CONTEXT_MAX_CHARS });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: 'm0', ts: T - 120_000, body: OLD });
    // an EARLIER mention → E replies (that reply is the boundary line in transcript.md)
    await bridge.emit({ ...CHAT, msgId: 'm1', ts: T - 60_000, body: `@e y tu que opinas` });
    await bridge.emit({ ...CHAT, msgId: 'm2', ts: T + 10 * 60_000, body: SKIN });
    await bridge.emit({ ...CHAT, msgId: 'm3', ts: T + 20 * 60_000, body: ASK });

    expect(brain.calls).toHaveLength(2);
    const prompt = brain.calls[1].ev.line;
    expect(prompt).toContain(SKIN);                      // said AFTER E's reply → context
    expect(prompt).not.toContain(OLD);                   // said BEFORE it → E's session has it
  });

  it('ON: a WITHHELD reply still counts as E\'s turn (it ran, so it saw those messages)', async () => {
    const { spine, bridge, brain, transcript } = build({ recentContextChars: RECENT_CONTEXT_MAX_CHARS });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: 'm0', ts: T - 120_000, body: OLD });
    await bridge.emit({ ...CHAT, msgId: 'm1', ts: T - 60_000, body: `@e y tu que opinas` });
    // force the recorded reply to the not-surfaced shape, as a muted/withheld turn writes it
    transcript.text = transcript.text.replace(/^(\[@e\.kg \(\d{2}:\d{2}\)\]: )/m, '$1(not surfaced) ');
    await bridge.emit({ ...CHAT, msgId: 'm2', ts: T + 10 * 60_000, body: SKIN });
    await bridge.emit({ ...CHAT, msgId: 'm3', ts: T + 20 * 60_000, body: ASK });

    const prompt = brain.calls[1].ev.line;
    expect(prompt).toContain(SKIN);
    expect(prompt).not.toContain(OLD);
  });

  it('ON: nothing accumulated since the last turn → NO context block at all', async () => {
    const { spine, bridge, brain } = build({ recentContextChars: RECENT_CONTEXT_MAX_CHARS });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: 'm0', ts: T, body: `@e ${RUM}` });
    await bridge.emit({ ...CHAT, msgId: 'm3', ts: T + 60_000, body: ASK });

    const prompt = brain.calls[1].ev.line;
    expect(prompt).not.toContain('ACCUMULATED CONTEXT');
    expect(prompt).toContain(ASK);
  });

  it('ON but the transcript cannot be read: falls back to today\'s prompt, never throws', async () => {
    const { spine, bridge, brain, transcript } = build({ recentContextChars: RECENT_CONTEXT_MAX_CHARS, readTranscript: async () => { throw new Error('ENOENT'); } });
    spine.start();
    await playIncident(bridge);
    const inbound = transcript.entries.filter((e) => e.reply == null);
    expect(brain.calls[0].ev.line).toBe(inbound[2].ev.line);
  });
});

describe('contextSinceLastTurn — the gap read back out of transcript.md', () => {
  const doc = [
    '---',
    'name: grupo',
    'chat_id: chat-1',
    '---',
    '',
    'An@[grupo].wa (20:00) #a: antes de que hablara e',
    '',
    '[@e.kg (20:01)]: la ultima vez que hable',
    '',
    'An@[grupo].wa (22:05) #b: despues',
    '',
    '[@don.do (22:06)]: otro agente, no soy yo',
    '',
    'An@[grupo].wa (22:29) #c: lo ultimo',
    '',
  ].join('\n');

  it("keeps only what came after THIS being's last reply, oldest first, front matter stripped", () => {
    const { blocks, truncated } = contextSinceLastTurn(doc, { being: 'e' });
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain('despues');
    expect(blocks[1]).toContain('@don.do');            // another being's reply is part of the gap
    expect(blocks[2]).toContain('lo ultimo');
    expect(blocks.join('\n')).not.toContain('name: grupo');
    expect(blocks.join('\n')).not.toContain('antes de que hablara');
    expect(truncated).toBe(false);
  });

  it('another being\'s reply is NOT the boundary — only this being\'s own line is', () => {
    const { blocks } = contextSinceLastTurn(doc, { being: 'don' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('lo ultimo');
  });

  it('the being has NEVER replied here → the whole tail, up to the cap', () => {
    const { blocks } = contextSinceLastTurn(doc, { being: 'wren' });
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toContain('antes de que hablara');
  });

  it('excludes the triggering line so it is never both prompt AND context', () => {
    const { blocks } = contextSinceLastTurn(doc, { being: 'e', exclude: 'An@[grupo].wa (22:29) #c: lo ultimo' });
    expect(blocks.join('\n')).not.toContain('lo ultimo');
  });

  it('is SIZE-bounded: keeps the MOST RECENT and reports the truncation', () => {
    const big = Array.from({ length: 200 }, (_, i) => `An@[g].wa (22:00) #${i}: ${'x'.repeat(300)}`).join('\n\n');
    const { blocks, truncated } = contextSinceLastTurn(big, { being: 'e', maxChars: 2000 });
    expect(blocks.join('\n\n').length).toBeLessThanOrEqual(2000);
    expect(blocks[blocks.length - 1]).toContain('#199');   // the most recent survives
    expect(truncated).toBe(true);
  });

  it('renders no labelled block when the gap is empty; announces truncation when it is not whole', () => {
    expect(promptWithRecentContext('the line', { blocks: [], truncated: false })).toBe('the line');
    const whole = promptWithRecentContext('the line', { blocks: ['a'], truncated: false });
    expect(whole).toContain('THIS LINE IS THE PROMPT');
    expect(whole).not.toContain('omitted');
    expect(promptWithRecentContext('the line', { blocks: ['a'], truncated: true })).toContain('omitted');
  });
});

describe('recent_context is an OPTION, not a mode', () => {
  it("AUTO_MODES still lacks 'accum' and a stored legacy accum still degrades to mention", () => {
    expect(AUTO_MODES).not.toContain('accum');
    expect(AUTO_MODES).toContain('mention');
    expect(isAutoMode('accum')).toBe(false);
    // the graceful degradation at auto-mode.mjs:25-29 — a legacy `mode: accum` gates
    // exactly like 'mention'
    expect(replyAllowed('accum', { atEAnywhere: true })).toBe(replyAllowed('mention', { atEAnywhere: true }));
    expect(replyAllowed('accum', { atEAnywhere: false })).toBe(replyAllowed('mention', { atEAnywhere: false }));
  });

  it('resolves per-conversation over the node default, and is OFF when nothing says otherwise', async () => {
    const ev = { surface: 'whatsapp', chatId: 'c1', mention: { atEAnywhere: true } };
    const state = (recent) => ({ contacts: { whatsapp: { c1: { slug: 'g', e: { threadId: null, ...(recent === undefined ? {} : { recent_context: recent }) } } } } });

    const off = createGating({ getConfig: () => ({}), loadState: async () => state(undefined) });
    expect((await off.decide('e', ev)).recentContextChars).toBe(0);

    const nodeWide = createGating({ getConfig: () => ({ dispatch: { recent_context: true } }), loadState: async () => state(undefined) });
    expect((await nodeWide.decide('e', ev)).recentContextChars).toBe(RECENT_CONTEXT_MAX_CHARS);

    const perConv = createGating({ getConfig: () => ({ dispatch: { recent_context: true } }), loadState: async () => state(2000) });
    expect((await perConv.decide('e', ev)).recentContextChars).toBe(2000);

    const vetoed = createGating({ getConfig: () => ({ dispatch: { recent_context: true } }), loadState: async () => state(false) });
    expect((await vetoed.decide('e', ev)).recentContextChars).toBe(0);
  });

  it("is the PERSONA's option — a sibling never carries it (it is addressed, not ambient)", async () => {
    const ev = { surface: 'whatsapp', chatId: 'c1', mention: { atEAnywhere: true } };
    const g = createGating({
      getConfig: () => ({ dispatch: { recent_context: true } }),
      loadState: async () => ({ contacts: { whatsapp: { c1: { slug: 'g', e: { threadId: null }, don: { threadId: null, recent_context: true } } } } }),
      defaultKey: 'e',
    });
    expect((await g.decide('e', ev)).recentContextChars).toBe(RECENT_CONTEXT_MAX_CHARS);
    expect((await g.decide('don', ev)).recentContextChars).toBe(0);
  });
});
