// THE QUOTED MESSAGE (operator 2026-07-26) — the live failure this locks:
//
//   In a real group someone REPLIED to a message and wrote `@e ubica esto en yotube o en
//   otra plataforma`. E answered "No veo el contenido de #177210 — ¿qué es lo que necesitas
//   que ubique?". Beeper carries a reply's quoted message ID ONLY (no inline quoted
//   text/sender — src/bridges/beeper.mjs:1335), so `re #<id>` rode the dispatch line and the
//   CONTENT of #177210 was never resolved anywhere. E was handed a pointer and nothing else.
//
// But the content IS on the record: the quoted message is an entry in transcript.md, and the
// walk that finds an entry by id already existed (the voice-note reuse path). So a reply
// resolves its quoted body out of the SAME transcript the being's context comes from and it
// is injected — LABELLED, prompt-only — beside the triggering line.
//
// It must work in plain `mention` mode (the live state), and must NOT duplicate in
// `accum` mode when the quoted message already falls inside the gap.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { formatDispatchLine } from '../src/dispatch-line.mjs';
import { replyLine, bodyForMessageId } from '../src/transcript-log.mjs';

// --- the live chat, as fakes (same shape as tests/accum-mode.test.mjs) --------
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

// identity.build through the REAL dispatch-line formatter, replyToId included — so the
// recorded line carries ` re #<id>` exactly as the live file does.
const fakeIdentity = {
  build: (msg) => ({
    ...msg,
    line: formatDispatchLine({
      senderName: msg.senderName, chatName: msg.chatName, node: 'wa',
      body: msg.body, ts: msg.ts, msgId: msg.msgId, replyToId: msg.replyToId ?? null,
    }),
  }),
};
const fakeRouter = { resolve: () => 'e' };

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
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: 'chat-1', chatName: 'grupo', senderId: 'u-1', senderName: 'Ana', kind: 'text', raw: {} };

// tonight's messages
const QUOTED = 'miren esta cancion que encontre, la version de 1974 con la orquesta completa';
const ASK = '@e ubica esto en yotube o en otra plataforma';

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

const count = (hay, needle) => hay.split(needle).length - 1;

describe('a reply resolves its QUOTED message into the prompt', () => {
  it('THE LIVE FAILURE: `@e ubica esto` replying to #177210 reaches the brain with #177210\'s BODY', async () => {
    const { spine, bridge, brain } = build({ mode: 'mention' });   // plain mention — the live state
    spine.start();
    await bridge.emit({ ...CHAT, msgId: '177210', ts: T, body: QUOTED });
    await bridge.emit({ ...CHAT, msgId: '177211', ts: T + 20 * 60_000, body: ASK, replyToId: '177210' });

    expect(brain.calls).toHaveLength(1);                 // only the mention ran a turn
    const prompt = brain.calls[0].ev.line;
    expect(prompt).toContain(ASK);                       // the trigger is still THE prompt
    expect(prompt).toContain(QUOTED);                    // ← pre-fix: E only had the id
    // …and it is unmistakably labelled as the thing being REFERRED to
    expect(prompt).toContain('THE MESSAGE THIS REPLIES TO');
    expect(prompt).toContain('#177210');
  });

  it('the quoted content is PROMPT-ONLY — never re-entered into the transcript or the outbound', async () => {
    const { spine, bridge, transcript } = build({ mode: 'mention' });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: '177210', ts: T, body: QUOTED });
    await bridge.emit({ ...CHAT, msgId: '177211', ts: T + 20 * 60_000, body: ASK, replyToId: '177210' });

    const inbound = transcript.entries.filter((e) => e.reply == null);
    expect(inbound[1].ev.line).toBe(`Ana@[grupo].wa (22:20) #177211: [re #177210] ${ASK}`);   // the recorded bytes are the 2026-09-01 shape, and only that
    expect(count(transcript.text, QUOTED)).toBe(1);      // exactly the one original entry
  });

  it('the quoted id is NOT in the transcript → the prompt is BYTE-IDENTICAL to today (nothing fabricated, no empty block)', async () => {
    const { spine, bridge, brain, transcript } = build({ mode: 'mention' });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: '177211', ts: T + 20 * 60_000, body: ASK, replyToId: 'from-last-year' });

    const inbound = transcript.entries.filter((e) => e.reply == null);
    expect(brain.calls[0].ev.line).toBe(inbound[0].ev.line);
    expect(brain.calls[0].ev.line).not.toContain('THE MESSAGE THIS REPLIES TO');
  });

  it('NOT a reply → the prompt is BYTE-IDENTICAL to today', async () => {
    const { spine, bridge, brain, transcript } = build({ mode: 'mention' });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: '177210', ts: T, body: QUOTED });
    await bridge.emit({ ...CHAT, msgId: '177212', ts: T + 20 * 60_000, body: '@e que opinas', replyToId: null });

    const inbound = transcript.entries.filter((e) => e.reply == null);
    expect(brain.calls[0].ev.line).toBe(inbound[1].ev.line);
  });

  it('the quoted entry is a VOICE NOTE → its transcription is the content (the marked body, as recorded)', async () => {
    const doc = [
      '---', 'name: grupo', 'chat_id: chat-1', '---', '',
      'Bea@[grupo].wa (21:00) #vn-7: (voice transcription, 8s) el sabado nos vemos en la casa de mi mama',
      '',
    ].join('\n');
    const { spine, bridge, brain } = build({ mode: 'mention', readTranscript: async () => doc });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: 'm9', ts: T, body: '@e a que hora dijo', replyToId: 'vn-7' });

    const prompt = brain.calls[0].ev.line;
    expect(prompt).toContain('el sabado nos vemos en la casa de mi mama');
  });

  it('a MULTI-LINE quoted body is resolved whole', async () => {
    const doc = [
      '---', 'name: grupo', '---', '',
      'Bea@[grupo].wa (21:00) #ml-1: primera linea',
      'segunda linea',
      'tercera linea',
      '',
    ].join('\n');
    const { spine, bridge, brain } = build({ mode: 'mention', readTranscript: async () => doc });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: 'm10', ts: T, body: '@e y esto', replyToId: 'ml-1' });

    const prompt = brain.calls[0].ev.line;
    expect(prompt).toContain('primera linea\nsegunda linea\ntercera linea');
  });

  it('the transcript cannot be read → today\'s prompt, never throws', async () => {
    const { spine, bridge, brain, transcript } = build({ mode: 'mention', readTranscript: async () => { throw new Error('ENOENT'); } });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: '177211', ts: T, body: ASK, replyToId: '177210' });
    const inbound = transcript.entries.filter((e) => e.reply == null);
    expect(brain.calls[0].ev.line).toBe(inbound[0].ev.line);
  });
});

describe('quoted message + mode:accum compose without duplicating', () => {
  it('accum and the quoted message is INSIDE the gap → it appears ONCE (as context), not twice', async () => {
    const { spine, bridge, brain } = build({ mode: 'accum' });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: '177210', ts: T, body: QUOTED });          // in the gap: E never ran a turn on it
    await bridge.emit({ ...CHAT, msgId: '177211', ts: T + 20 * 60_000, body: ASK, replyToId: '177210' });

    const prompt = brain.calls[0].ev.line;
    expect(count(prompt, QUOTED)).toBe(1);
    expect(prompt).toContain('ACCUMULATED CONTEXT');
  });

  it('accum but the quoted message is OLDER than the gap → the quoted block supplies it (once)', async () => {
    const { spine, bridge, brain } = build({ mode: 'accum' });
    spine.start();
    await bridge.emit({ ...CHAT, msgId: '177210', ts: T - 600_000, body: QUOTED });
    await bridge.emit({ ...CHAT, msgId: 'm-mid', ts: T - 300_000, body: '@e hola' });   // E replies → the gap starts HERE
    await bridge.emit({ ...CHAT, msgId: 'm-after', ts: T, body: 'algo mas' });
    await bridge.emit({ ...CHAT, msgId: '177211', ts: T + 20 * 60_000, body: ASK, replyToId: '177210' });

    const prompt = brain.calls[1].ev.line;
    expect(count(prompt, QUOTED)).toBe(1);                 // ← accum's window CANNOT cover this one
    expect(prompt).toContain('THE MESSAGE THIS REPLIES TO');
    expect(prompt).toContain('algo mas');                  // the gap is still there
  });
});

describe('bodyForMessageId — one walk over transcript.md, by message id', () => {
  const doc = [
    '---', 'name: Bea', 'slug: bea', '---', '',
    'Bea@[Bea].wa (14:32) #42: hola que tal',
    '',
    'Bea@[Bea].wa (14:33) #vn-9: (voice transcription, 20s) line one',
    'line two continues',
    '',
    '[@e.kg (14:34)]: got it',
    '',
    'An@[Bea].wa (14:35) #100 re #42: la respuesta',
    '',
  ].join('\n');

  it('returns the entry body for an id, front matter ignored, id compared as a string', () => {
    expect(bodyForMessageId(doc, '42')).toBe('hola que tal');
    expect(bodyForMessageId(doc, 42)).toBe('hola que tal');
  });

  it('collects continuation lines up to the NEXT entry, and keeps a voice marker in the body', () => {
    expect(bodyForMessageId(doc, 'vn-9')).toBe('(voice transcription, 20s) line one\nline two continues');
  });

  it('matches the MESSAGE id (after the time), never a `re #<id>` reply tag', () => {
    expect(bodyForMessageId(doc, '100')).toBe('la respuesta');
    expect(bodyForMessageId(doc, '40')).toBe(null);
  });

  it('returns null for a missing id and for nullish input', () => {
    expect(bodyForMessageId(doc, 'nope')).toBe(null);
    expect(bodyForMessageId('', 'x')).toBe(null);
    expect(bodyForMessageId(null, 'x')).toBe(null);
    expect(bodyForMessageId(doc, null)).toBe(null);
  });

  // THE 2026-09-01 LINE SHAPE: the reply reference moved out from between the id and the colon
  // into the front of the BODY as `[re #<id>] `. It is a HEAD field, so this reader strips it
  // back off — what a caller gets as "the recorded body" is byte-identical across the move,
  // which is what keeps promptWithQuotedMessage's quote and beeper.transcriptionForNoteId's
  // voice-marker test working. The OLD shape stays readable: transcript.md is append-only.
  it('reads the NEW `#<id>: [re #<rid>] body` shape, and the reference is head, never body', () => {
    const d = 'An@[Bea].wa (14:35) #100: [re #42] la respuesta\n\n';
    expect(bodyForMessageId(d, '100')).toBe('la respuesta');      // identical to the old ` re #42:` shape
    expect(bodyForMessageId(d, '42')).toBe(null);                 // still never the reply TARGET
    // a body that merely starts with a bracket is untouched
    expect(bodyForMessageId('An@[Bea].wa (14:36) #101: [nota] ojo', '101')).toBe('[nota] ojo');
  });

  it('is not fooled by a coincidental "(HH:MM) #id" inside a LATER entry body', () => {
    const d = [
      'Bea@[Bea].wa (14:32) #real: the real one',
      '',
      'Ana@[Bea].wa (14:40) #other: talking about (14:32) #real over here',
      '',
    ].join('\n');
    expect(bodyForMessageId(d, 'real')).toBe('the real one');
  });
});
