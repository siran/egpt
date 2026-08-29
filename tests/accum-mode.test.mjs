// MODE: ACCUM (operator 2026-07-26) — the live failure this locks:
//
//   In a real WhatsApp group the operator wrote a long message about skin cells and
//   sweat (no @e), then asked `@e da una opinión bien fundamentada`. E answered with an
//   essay about rum arbitrage — the topic from twenty minutes earlier — because
//   send_to_egpt:'mode' means E only runs a turn on messages it will ANSWER. The skin
//   message was in transcript.md but was never handed to E, and E did not go read it.
//
// `accum` is the mode that closes that gap: it GATES REPLIES EXACTLY LIKE `mention`
// (this file asserts that for every mention state), and on the turn that was going to
// happen anyway the prompt carries everything said SINCE THIS BEING'S LAST TURN, read
// back out of transcript.md and labelled as context beside the trigger. That boundary is
// exactly the set the being never saw — its warm session already holds everything up to
// its own last reply — so there is no overlap and no clock to parse.
//
// ⚠ THE NAME IS REUSED, THE MECHANISM IS NOT. The ORIGINAL accum (retired 2026-07-01)
// BUFFERED a chat's bursts and FLUSHED the batch to E once per heartbeat. This one does
// not batch, does not touch the heartbeat, and does not change WHEN a turn runs — only
// WHAT it is prompted with. Do not "restore" the old design.
//
// In every OTHER mode the prompt is byte-identical to what it was before accum existed.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { formatDispatchLine } from '../src/dispatch-line.mjs';
import { contextSinceLastTurn, promptWithRecentContext, replyLine } from '../src/transcript-log.mjs';
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

// The gate is the SAME in both modes — @e anywhere replies, otherwise the message is
// recorded only (send_to_egpt: 'mode' — E never runs a turn on it). The mode changes only
// what the turn is prompted with.
function gatingIn(mode) {
  return {
    async decide(_being, ev) {
      const mayReply = /@e\b/.test(ev.body);
      return { mode, receives: true, mayReply, sendToEgpt: 'mode' };
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

function build({ mode = 'mention', readTranscript = null } = {}) {
  const bridge = fakeBridge();
  const brain = fakeBrain();
  const transcript = fakeTranscript();
  const spine = createSpine({
    bridge, brain,
    identity: fakeIdentity, router: fakeRouter,
    gating: gatingIn(mode),
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

describe('mode: accum — the un-mentioned antecedent reaches the prompt', () => {
  it('mention (today): the un-mentioned message NEVER reaches the prompt — the live failure', async () => {
    const { spine, bridge, brain } = build({ mode: 'mention' });
    spine.start();
    await playIncident(bridge);

    expect(brain.calls).toHaveLength(1);                 // only the mention ran a turn
    const prompt = brain.calls[0].ev.line;
    expect(prompt).not.toContain(SKIN);                  // ← this is why E answered about rum
    expect(prompt).toContain(ASK);
  });

  it('every non-accum mode: the prompt is BYTE-IDENTICAL to the plain dispatch line', async () => {
    for (const mode of ['mention', 'mention-direct', 'on']) {
      const { spine, bridge, brain, transcript } = build({ mode });
      spine.start();
      await playIncident(bridge);
      const inbound = transcript.entries.filter((e) => e.reply == null);
      const call = brain.calls[brain.calls.length - 1];
      expect(call.ev.line, mode).toBe(inbound[inbound.length - 1].ev.line);
    }
  });

  it('accum: the un-mentioned message arrives as LABELLED context and the mention is THE prompt', async () => {
    const { spine, bridge, brain } = build({ mode: 'accum' });
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

  it("accum: the window stops at E's OWN last reply — E is never re-fed what it already holds", async () => {
    const { spine, bridge, brain } = build({ mode: 'accum' });
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

  it('accum: a WITHHELD reply still counts as E\'s turn (it ran, so it saw those messages)', async () => {
    const { spine, bridge, brain, transcript } = build({ mode: 'accum' });
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

  it('accum: nothing accumulated since the last turn → NO context block at all', async () => {
    const { spine, bridge, brain } = build({ mode: 'accum' });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: 'm0', ts: T, body: `@e ${RUM}` });
    await bridge.emit({ ...CHAT, msgId: 'm3', ts: T + 60_000, body: ASK });

    const prompt = brain.calls[1].ev.line;
    expect(prompt).not.toContain('ACCUMULATED CONTEXT');
    expect(prompt).toContain(ASK);
  });

  it('accum but the transcript cannot be read: falls back to today\'s prompt, never throws', async () => {
    const { spine, bridge, brain, transcript } = build({ mode: 'accum', readTranscript: async () => { throw new Error('ENOENT'); } });
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

  // ── A MULTI-BLOCK ENTRY (operator 2026-08-29, the "restart didn't clear the accum" incident) ──
  // A transcript entry is one blank-line-separated block ONLY when its body has no blank line
  // in it. A multi-paragraph reply is written as SEVERAL blocks and just the FIRST carries the
  // `<label>@[chat].<surface> (HH:MM):` header — so walking backward collected the headerless
  // paragraphs BEFORE the boundary was reached and the being was re-fed the tail of its OWN
  // last reply, labelled "what was said since your last turn", on EVERY accum turn.
  // A headerless block belongs to the entry above it: it is included or dropped with it.
  const HEAD = ['---', 'name: fam', 'chat_id: c1', '---', ''];
  const REC = (...lines) => [...HEAD, ...lines, ''].join('\n');

  it("this being's MULTI-PARAGRAPH reply is the boundary WHOLE — its headerless continuations never come back", () => {
    const doc = REC(
      'An@[fam].wa (19:55) #a: antes del turno', '',
      'egpt@[fam].wa (20:01): Ahí sí metiste un mecanismo real', '',
      'Pero fijate el precio que pagás', '',
      'Eso no es una especie forjando su futuro', '',
      'Bea@[fam].wa (20:30) #b: lo que sigue',
    );
    expect(contextSinceLastTurn(doc, { being: 'egpt' }).blocks)
      .toEqual(['Bea@[fam].wa (20:30) #b: lo que sigue']);
  });

  // THE OVER-CORRECTION GUARD: a human's continuation paragraphs are headerless too, and they
  // are real context. Only the run belonging to the BOUNDARY reply is dropped.
  it("a HUMAN's multi-paragraph message is included in FULL — every paragraph, header first", () => {
    const doc = REC(
      'egpt@[fam].wa (20:01): mi último turno', '',
      'An@[fam].wa (20:30) #b: primer párrafo', '',
      'segundo párrafo', '',
      'tercer párrafo',
    );
    expect(contextSinceLastTurn(doc, { being: 'egpt' }).blocks)
      .toEqual(['An@[fam].wa (20:30) #b: primer párrafo', 'segundo párrafo', 'tercer párrafo']);
  });

  it("ANOTHER agent's multi-paragraph reply is context in full — only THIS being's own line is the boundary", () => {
    const doc = REC(
      'egpt@[fam].wa (20:01): mi último turno', '',
      'don@[fam].wa (20:10): don, primer párrafo', '',
      'don, segundo párrafo', '',
      'An@[fam].wa (20:30) #b: lo que sigue',
    );
    expect(contextSinceLastTurn(doc, { being: 'egpt' }).blocks).toEqual([
      'don@[fam].wa (20:10): don, primer párrafo',
      'don, segundo párrafo',
      'An@[fam].wa (20:30) #b: lo que sigue',
    ]);
  });

  it('renders no labelled block when the gap is empty; announces truncation when it is not whole', () => {
    expect(promptWithRecentContext('the line', { blocks: [], truncated: false })).toBe('the line');
    const whole = promptWithRecentContext('the line', { blocks: ['a'], truncated: false });
    expect(whole).toContain('THIS LINE IS THE PROMPT');
    expect(whole).not.toContain('omitted');
    expect(promptWithRecentContext('the line', { blocks: ['a'], truncated: true })).toContain('omitted');
  });
});

describe('accum is a MODE again, and it gates exactly like mention', () => {
  it("AUTO_MODES carries 'accum' and it is a known mode", () => {
    expect(AUTO_MODES).toContain('accum');
    expect(AUTO_MODES).toContain('mention');
    expect(isAutoMode('accum')).toBe(true);
  });

  it('replyAllowed(accum) === replyAllowed(mention) for EVERY mention state', () => {
    for (const atEStart of [true, false]) {
      for (const atEAnywhere of [true, false]) {
        for (const replyToBot of [true, false]) {
          const status = { atEStart, atEAnywhere, replyToBot };
          expect(replyAllowed('accum', status), JSON.stringify(status))
            .toBe(replyAllowed('mention', status));
        }
      }
    }
  });

  it('resolves per-conversation over the node default, and the node default is settable to accum', async () => {
    const ev = { surface: 'whatsapp', chatId: 'c1', mention: { atEAnywhere: true } };
    const state = (mode) => ({ contacts: { whatsapp: { c1: { slug: 'g', agents: { e: { threadId: null, ...(mode === undefined ? {} : { mode }) } } } } } });

    const bare = createGating({ getConfig: () => ({}), loadState: async () => state(undefined) });
    expect((await bare.decide('e', ev)).mode).toBe('mention');                       // built-in default

    const nodeWide = createGating({ getConfig: () => ({ dispatch: { auto_default_mode: 'accum' } }), loadState: async () => state(undefined) });
    expect((await nodeWide.decide('e', ev)).mode).toBe('accum');                     // node-wide

    const perConv = createGating({ getConfig: () => ({ dispatch: { auto_default_mode: 'accum' } }), loadState: async () => state('mention') });
    expect((await perConv.decide('e', ev)).mode).toBe('mention');                    // the conversation wins
  });

  // PHASE 2 (operator 2026-08-14, "remove the concept of siblings"): the default-gate
  // asymmetry in gating.mjs's defaultMode is gone — every being's un-configured default now
  // resolves via the SAME dispatch.auto_default_mode/whatsapp.auto_e_default chain. Was: a
  // sibling with no mode of its own always fell back to 'mention', never the node default.
  it('PHASE 2: the node-wide accum default now reaches EVERY being — a sibling with no mode of its own gets it too', async () => {
    const ev = { surface: 'whatsapp', chatId: 'c1', mention: { atEAnywhere: true } };
    const g = createGating({
      getConfig: () => ({ dispatch: { auto_default_mode: 'accum' } }),
      loadState: async () => ({ contacts: { whatsapp: { c1: { slug: 'g', e: { threadId: null }, don: { threadId: null } } } } }),
      defaultKey: 'e',
    });
    expect((await g.decide('e', ev)).mode).toBe('accum');
    expect((await g.decide('don', ev)).mode).toBe('accum');   // phase 2: no longer forced to 'mention'
  });
});
