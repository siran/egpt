// THE ADDRESSING HANDLE IS NOT CONTENT (operator 2026-09-11, caught live).
//
// He sent `e e` in a WhatsApp group. The prompt the model actually received was, verbatim:
//
//   THIS LINE IS THE PROMPT — answer THIS:
//   An@[HFM - high frequency masturbation].wa (08:07) #4709: e e
//
// E replied `…` — the polite silence config/skeletons/room/40-rules.md defines — because it was
// handed what reads as a bare repetition of its own name and reasonably found nothing to answer.
// The operator: *"The model is receiving its own wake word, should happen on a `@egpt hi` or
// `e hi`, model should only receive a Hi! please confirm. the log is correct, i wrote `e e`"*.
//
// So exactly ONE thing changes: the trigger line handed to the model loses the handle that
// OPENED the message. The transcript keeps the raw text (it was never wrong — it is the record
// of what was typed), a handle mid-sentence is content and stays, and the accumulated-context
// blocks are untouched.
//
// The strip runs on the path that already knows the answer: THE mention matcher resolves the
// token (auto-mode.mentionHits), router.addressed carries it out on the hit, targetFor puts it on
// the target as `address`, and the spine takes it off the trigger with auto-mode.withoutAddress.
// Nothing re-scans the body — this file wires the REAL identity + REAL router precisely so that
// whole chain is what is under test.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter, addressed } from '../src/spine/router.mjs';
import { replyLine } from '../src/transcript-log.mjs';
import { withoutAddress } from '../src/auto-mode.mjs';

// --- the live chat, as fakes -------------------------------------------------
const T = Date.UTC(2026, 8, 11, 8, 7);                       // → "(08:07)", the operator's own line
const CHAT_NAME = 'HFM - high frequency masturbation';
const HEAD = `An@[${CHAT_NAME}].wa (08:07) #4709: `;         // what identity.build puts before the body
// The persona as the live node declares it: the KEY is the being-id, the HANDLES are the address
// set, and `perro` is a SPOKEN-only alias (voice_handles — no '@', start of the transcript).
const AGENTS = { e: { default: true, handles: ['e', 'egpt'], voice_handles: ['perro'] } };

function fakeBridge() {
  let cb = null;
  return { sent: [], onMessage(fn) { cb = fn; }, send(chat, text) { this.sent.push({ chat, text }); }, emit(m) { return cb(m); }, stop() {} };
}
function fakeBrain() {
  return { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: 'ok', being }; } };
}
function fakeSender(bridge) {
  return { open(chatId) { return { update() {}, fail() {}, async finish(reply, { surface = true } = {}) { const t = typeof reply === 'string' ? reply : reply?.text; if (surface && t) bridge.send(chatId, t); } }; } };
}
// A real append-only buffer written through the REAL line formatters, so what the spine reads
// back (accum) is shaped exactly like the live file — and so "the record keeps the raw text" is
// asserted against the bytes that would actually land in transcript.md.
function fakeTranscript() {
  return {
    text: '',
    async log(ev, reply) {
      this.text += (reply == null ? (ev.line ?? ev.body) : replyLine({ being: reply.being ?? 'e', body: reply.text, chatName: CHAT_NAME, node: 'wa', now: new Date(T) })) + '\n\n';
    },
  };
}

// `addressedReplies` mirrors the live gate: send_to_egpt:'mode', so a turn runs only on a message
// this being would answer. The default (every test but the accum one) answers everything, which
// is the simplest shape for asserting the prompt.
function build({ mode = 'mention', agents = AGENTS, mayReply = () => true } = {}) {
  const bridge = fakeBridge();
  const brain = fakeBrain();
  const transcript = fakeTranscript();
  const spine = createSpine({
    bridge, brain,
    identity: createIdentity({ now: () => T }),
    router: createRouter({ getAgents: () => agents, defaultBeing: 'e' }),
    gating: { async decide(_being, ev) { return { mode, receives: true, mayReply: mayReply(ev), sendToEgpt: 'mode' }; }, surfaces: () => true },
    sender: fakeSender(bridge), transcript, heartbeats: { runDue() {} },
    readTranscript: async () => transcript.text,
    clock: { now: () => T },
  });
  spine.start();
  return { bridge, brain, transcript };
}
const msg = (body, from = {}) => ({
  body,
  from: {
    chatId: '!hfm:beeper.com', chatName: CHAT_NAME, network: 'whatsapp',
    userId: 'u-1', senderName: 'An', msgKey: '4709', authorized: true,
    atEStart: true, atEAnywhere: true, replyToBot: false, ...from,
  },
});
// The line the brain was prompted with (the spine hands it `promptEv`, whose `.line` IS the trigger).
const promptOf = (brain) => brain.calls[0].ev.line;

describe('REPRODUCE — the being is fed its own wake word', () => {
  it('`e e`: the model is handed `e`, NOT `e e` (operator 2026-09-11)', async () => {
    const { bridge, brain, transcript } = build();
    await bridge.emit(msg('e e'));

    expect(brain.calls).toHaveLength(1);
    expect(promptOf(brain)).toBe(`${HEAD}e`);            // ← was `${HEAD}e e`: the wake word rode in as content
    expect(transcript.text).toContain(`${HEAD}e e`);     // the LOG IS CORRECT — the record keeps what he typed
  });

  it('`e hi` and `@egpt hi`: the model is handed `hi` — both forms of the same address', async () => {
    for (const body of ['e hi', '@egpt hi', 'egpt hi', '@e hi']) {
      const { bridge, brain } = build();
      await bridge.emit(msg(body));
      expect([body, promptOf(brain)]).toEqual([body, `${HEAD}hi`]);
    }
  });
});

describe('LOCKS — what must NOT move', () => {
  it('a handle MID-SENTENCE is content, and stays', async () => {
    const { bridge, brain } = build();
    await bridge.emit(msg('pregúntale a @e sobre esto', { atEStart: false }));
    expect(promptOf(brain)).toBe(`${HEAD}pregúntale a @e sobre esto`);
  });

  it('only the OPENING handle comes off — a second one further in is content', async () => {
    const { bridge, brain } = build();
    await bridge.emit(msg('@e dile a @egpt que vuelva'));
    expect(promptOf(brain)).toBe(`${HEAD}dile a @egpt que vuelva`);
  });

  it('a message addressing nobody is untouched', async () => {
    const { bridge, brain } = build();
    await bridge.emit(msg('las celulas de la piel se renuevan', { atEStart: false, atEAnywhere: false }));
    expect(promptOf(brain)).toBe(`${HEAD}las celulas de la piel se renuevan`);
  });

  it('the transcript keeps the RAW line for every form', async () => {
    for (const body of ['e e', '@egpt hi', 'e']) {
      const { bridge, transcript } = build();
      await bridge.emit(msg(body));
      // the FIRST block is the inbound line (the reply lands under it) — raw, handle and all
      expect([body, transcript.text.split('\n\n')[0]]).toEqual([body, `${HEAD}${body}`]);
    }
  });
});

// A SPOKEN handle woke the transcript (voice_handles), and since 2026-09-09 it wakes only at the
// START — the same position rule the '@'/bare forms follow. So it comes off under the same rule,
// and the `(voice transcription, Ns)` marker — which is HEAD, not content — stays put.
describe('a VOICE handle strips on the same rule', () => {
  it('the spoken alias comes off, the transcription marker stays', async () => {
    const { bridge, brain } = build();
    await bridge.emit(msg('(voice transcription, 8s) perro qué hora es', { isTranscriptFromVoice: true, atEStart: false, atEAnywhere: false }));
    expect(promptOf(brain)).toBe(`${HEAD}(voice transcription, 8s) qué hora es`);
  });

  it('a spoken alias MID-transcript woke nobody, so nothing is stripped either', async () => {
    const { bridge, brain } = build();
    await bridge.emit(msg('(voice transcription, 8s) tengo un perro grande', { isTranscriptFromVoice: true, atEStart: false, atEAnywhere: false }));
    expect(promptOf(brain)).toBe(`${HEAD}(voice transcription, 8s) tengo un perro grande`);
  });
});

// THE DECISION (operator asked for one): a message that is ONLY the handle leaves an EMPTY body.
// Position decides and nothing else — the handle was the address, so it comes off here too, and
// the dispatch line's HEAD still tells the model who hailed it, when, and in which chat. The
// alternative (leave the handle when nothing else remains) would re-feed exactly the input the
// operator objected to, in the one case where it is unambiguously pure addressing.
describe('a message that is ONLY the handle', () => {
  it('leaves the head with an empty body — a hail, with nothing said after it', async () => {
    const { bridge, brain } = build();
    await bridge.emit(msg('e'));
    expect(promptOf(brain)).toBe(HEAD);
  });
});

// mode:accum — the trigger is stripped, and NOTHING about the accumulated window moves. The
// `exclude` that keeps the trigger out of its own context still names the RAW recorded line.
describe('mode: accum — the stripped trigger, the untouched context', () => {
  it('the prompt strips the handle; the context keeps the raw earlier line and never repeats the trigger', async () => {
    const addressedOnly = (ev) => /^\s*@?e\b/i.test(ev.body);
    const { bridge, brain, transcript } = build({ mode: 'accum', mayReply: addressedOnly });

    await bridge.emit(msg('las celulas de la piel se renuevan', { msgKey: 'm1', atEStart: false, atEAnywhere: false }));
    expect(brain.calls).toHaveLength(0);                                    // recorded only — no turn
    await bridge.emit(msg('e dame una opinion bien fundamentada', { msgKey: 'm2' }));

    expect(brain.calls).toHaveLength(1);
    const prompt = promptOf(brain);
    expect(prompt).toContain('THIS LINE IS THE PROMPT — answer THIS:\n'
      + `An@[${CHAT_NAME}].wa (08:07) #m2: dame una opinion bien fundamentada\n`);
    expect(prompt).toContain(`An@[${CHAT_NAME}].wa (08:07) #m1: las celulas de la piel se renuevan`);
    // the trigger appears ONCE — the accum window still excludes the recorded line it came from
    expect(prompt.match(/dame una opinion/g)).toHaveLength(1);
    expect(prompt).not.toContain('#m2: e dame');                            // …and never with the handle on
    expect(transcript.text).toContain('#m2: e dame una opinion bien fundamentada');   // the record is raw
  });
});

// The matcher's own contract: the token that WON the hit rides out on it, so nothing downstream
// has to re-scan the body to learn what the handle was (an agent's handles are not its name).
describe('the router carries the matched handle out', () => {
  it('addressed() reports the token, and targetFor turns a START hit into the target `address`', async () => {
    expect(addressed('e e', AGENTS)).toEqual([{ name: 'e', agent: AGENTS.e, token: 'e', atStart: true, anywhere: true }]);
    const router = createRouter({ getAgents: () => AGENTS, defaultBeing: 'e' });
    expect(await router.resolve({ body: 'egpt hola', mention: {} })).toMatchObject({ being: 'e', address: 'egpt' });
    expect(await router.resolve({ body: 'dile a @e algo', mention: {} })).toMatchObject({ being: 'e', address: null });
    expect(await router.resolve({ body: 'hola gente', mention: {} })).toMatchObject({ being: 'e', address: null });
  });
});

// withoutAddress — the strip itself. It is handed the token; it never goes looking for one.
describe('withoutAddress', () => {
  it('takes the opening handle off, in either form, with the whitespace after it', () => {
    expect(withoutAddress('e e', 'e')).toBe('e');
    expect(withoutAddress('e hi', 'e')).toBe('hi');
    expect(withoutAddress('@egpt hi', 'egpt')).toBe('hi');
    expect(withoutAddress('  @E   hi', 'e')).toBe('hi');
    expect(withoutAddress('e\nhola', 'e')).toBe('hola');
    expect(withoutAddress('e', 'e')).toBe('');
  });
  it('is anchored: it can never touch a handle that is not at the start', () => {
    expect(withoutAddress('dile a e que venga', 'e')).toBe('dile a e que venga');
    expect(withoutAddress('email', 'e')).toBe('email');             // glued — the matcher's own boundary
    expect(withoutAddress("don't do that", 'don')).toBe("don't do that");
  });
  it('leaves the voice marker in place and strips inside the transcript', () => {
    expect(withoutAddress('(voice transcription, 8s) perro qué hora es', 'perro'))
      .toBe('(voice transcription, 8s) qué hora es');
    expect(withoutAddress('(voice transcription) perro hola', 'perro')).toBe('(voice transcription) hola');
  });
  it('removes the handle and the whitespace only — a vocative comma is content and stays', () => {
    expect(withoutAddress('e, hola', 'e')).toBe(', hola');
  });
  it('no token, or a text that does not open with it, changes nothing', () => {
    expect(withoutAddress('e hi', '')).toBe('e hi');
    expect(withoutAddress('e hi', null)).toBe('e hi');
    expect(withoutAddress('`x` e hi', 'e')).toBe('`x` e hi');       // the code-fence case: nothing is guessed
  });
});
