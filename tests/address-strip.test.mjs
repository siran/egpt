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
// The FAR HALF of a mesh hop, for the end-to-end assertions at the bottom: the real responder
// service and the real envelope codec, so 'what the far being was handed' is measured, not modelled.
import { createMeshService } from '../src/spine/mesh.mjs';
import { encodeMesh } from '../src/mesh/relay.mjs';

// --- the live chat, as fakes -------------------------------------------------
const T = Date.UTC(2026, 8, 11, 8, 7);                       // → "(08:07)", the operator's own line
const CHAT_NAME = 'HFM - high frequency masturbation';
const headOf = (id) => `An@[${CHAT_NAME}].wa (08:07) #${id}: `;   // what identity.build puts before the body
const HEAD = headOf('4709');                                 // the operator's own message id
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
// `sendToEgpt`, `mesh`, `timers` and `rng` are the seams the three doors at the bottom of this
// file need: a paused chat that still READS (send_to_egpt: 'always'), a mesh target's forward,
// and the auto dwell's randomized pre-turn timer. Every caller above passes none of them and
// builds exactly the spine it always did.
function build({ mode = 'mention', agents = AGENTS, mayReply = () => true, brain = fakeBrain(), sendToEgpt = 'mode', mesh = null, timers = null, rng = null } = {}) {
  const bridge = fakeBridge();
  const transcript = fakeTranscript();
  const spine = createSpine({
    bridge, brain,
    identity: createIdentity({ now: () => T }),
    router: createRouter({ getAgents: () => agents, defaultBeing: 'e' }),
    gating: { async decide(_being, ev) { return { mode, receives: true, mayReply: mayReply(ev), sendToEgpt }; }, surfaces: () => true },
    sender: fakeSender(bridge), transcript, heartbeats: { runDue() {} },
    readTranscript: async () => transcript.text,
    clock: { now: () => T },
    ...(mesh ? { mesh } : {}),
    ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {}),
    ...(rng ? { rng } : {}),
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

// ── THE SAME DEFECT, THE SECOND DOOR (operator 2026-09-11) ───────────────────────────────────
//
// 6634a76 fixed the turn OPENER and named what it had left, in its own commit message:
//
//     NOT FIXED, same defect second path: turns.steerLiveTurn writes `ev.line` raw into a live
//     session, so a steer still carries its wake word.
//
// A message that arrives while the being's turn is ALREADY streaming is not queued behind it —
// `allow_new_input` WEAVES it into the running turn (turns.steerLiveTurn → brain.steer →
// brainpool's `pool.steer(k, ev.line ?? ev.body)` → warm-cli-session.inject → the live stdin).
// That write took the RAW dispatch line, so `e también revisa X` reached the model mid-thought
// with `e` on the front: exactly the input the operator objected to, through a different door.
//
// `steer` below records `ev?.line ?? ev?.body ?? ''` — brainpool's own expression, verbatim — so
// the fake stands precisely where the pool stands and what it records is the text that would have
// been written into the live CLI session.
const flush = () => new Promise((r) => setTimeout(r, 0));

function steeringBrain() {
  const calls = [], steered = [];
  let release = null;
  return {
    calls, steered,
    release: () => release?.(),
    async turn(being, ev) {
      const first = calls.length === 0;
      calls.push({ being, ev });
      if (first) await new Promise((r) => { release = r; });   // turn #1 HANGS — so #2 genuinely arrives mid-turn
      return { text: 'ok', being };
    },
    async allowNewInput() { return 'any'; },
    // `{ ack }`, not a bare true: the pool hands back the session's later word on whether the
    // MODEL took the line, and only that places the 👀 (turns.mjs).
    steer(_being, ev) { steered.push(ev?.line ?? ev?.body ?? ''); return { ack: Promise.resolve({ ok: true }) }; },
  };
}

// Open a live turn on the conversation, then deliver `second` INTO it. Returns what the pool
// would have written to the live session.
async function steerInto(second, from = {}) {
  const brain = steeringBrain();
  const { bridge } = build({ brain });
  const first = bridge.emit(msg('e dame una opinion', { msgKey: 'm1' }));   // hangs inside brain.turn
  await flush();
  expect(brain.calls).toHaveLength(1);                                     // …so a turn really is live
  await bridge.emit(msg(second, { msgKey: 'm2', ...from }));
  brain.release();
  await first;
  return brain;
}

describe('REPRODUCE — the STEER path feeds the being its own wake word', () => {
  it('a message woven into a live turn arrives WITHOUT the leading handle', async () => {
    const brain = await steerInto('e también revisa X');
    // ← was `${headOf('m2')}e también revisa X`: the wake word rode into the live session
    expect(brain.steered).toEqual([`${headOf('m2')}también revisa X`]);
    expect(brain.calls).toHaveLength(1);                 // no second turn: it was woven, not queued
  });

  it('`@egpt` and the bare forms all lose the handle on the way into the live turn', async () => {
    for (const body of ['@egpt sigue', 'egpt sigue', '@e sigue', 'e sigue']) {
      const brain = await steerInto(body);
      expect([body, brain.steered]).toEqual([body, [`${headOf('m2')}sigue`]]);
    }
  });
});

describe('LOCKS — the steer path keeps everything else', () => {
  it('a steer that was never addressed is unchanged — the RAW dispatch line, head and all', async () => {
    const brain = await steerInto('también revisa X', { atEStart: false, atEAnywhere: false });
    expect(brain.steered).toEqual([`${headOf('m2')}también revisa X`]);
  });

  it('a handle MID-SENTENCE is content here too, and stays', async () => {
    const brain = await steerInto('pregúntale a @e sobre esto', { atEStart: false });
    expect(brain.steered).toEqual([`${headOf('m2')}pregúntale a @e sobre esto`]);
  });

  // The failure mode the null case has to avoid: `{ ...ev, line: null }` would make brainpool's
  // `ev.line ?? ev.body` fall through to the BARE BODY — dropping the head that tells the model
  // who hailed it, where and when, AND leaving the handle on. Nothing addressed ⇒ `ev` itself
  // goes down, so the head survives.
  it('the un-addressed steer still carries its dispatch HEAD (never the bare body)', async () => {
    const brain = await steerInto('también revisa X', { atEStart: false, atEAnywhere: false });
    expect(brain.steered[0]).toContain('An@[');
    expect(brain.steered[0]).toContain('#m2');
    expect(brain.steered[0]).not.toBe('también revisa X');
  });

  it('the RECORD keeps the raw steered line — the log was never wrong', async () => {
    const brain = steeringBrain();
    const { bridge, transcript } = build({ brain });
    const first = bridge.emit(msg('e dame una opinion', { msgKey: 'm1' }));
    await flush();
    await bridge.emit(msg('e también revisa X', { msgKey: 'm2' }));
    brain.release();
    await first;
    expect(transcript.text).toContain(`${headOf('m2')}e también revisa X`);
  });
});

// ── THE THREE DOORS 6634a76/298750d LEFT OPEN (operator 2026-09-11) ──────────────────────────
//
// The turn OPENER and the STEER above were the two paths that ran `triggerFor`. Three others
// reached a model with the handle still on:
//
//   1. THE MESH FORWARD, and it is the significant one. `mesh.forward` puts `ev.body` on the wire
//      RAW; the responder's `relayDispatch` builds its synthetic event straight out of that
//      prompt (`{ body: prompt, line: prompt }`) and calls `brain.turn` — and `turns.steerLiveTurn`
//      — with it. NO router runs on a relayed body at EITHER end: the far node resolves which
//      being answers from the envelope's own `to:` tail, never from the text. So `@don hola`
//      reached `don` as `@don hola`, and router.mjs's own comment claimed the opposite.
//   2. THE AUTO DWELL. An auto chat does not answer instantly — it accumulates the arriving line
//      into this conversation's CYCLE and fires ONE burst turn when the dwell expires, prompted
//      with the drained cycle verbatim. The line went into the cycle raw.
//   3. THE CONTEXT TURN — `send_to_egpt: always` in a chat the being may not reply in. It runs to
//      stay current, prompted with the event itself.
//
// The strip is the SAME one, reached the same way: the router's `address` on the target, and
// `withoutAddress` through the spine's `triggerFor`/`addressedBody`. Nothing re-scans a body.

// A relay agent (`relay_channel:`) is how this node reaches another one. The router resolves
// `@don …` to a MESH target — `{ being: null, mesh: {…}, address: 'don' }` — and the spine
// forwards it instead of running a local turn.
const RELAY_AGENTS = {
  e: { default: true, handles: ['e', 'egpt'] },
  don: { relay_channel: 'egpt-mesh-kg-mo', to: 'don.mo' },
};
function fakeMesh() {
  return { forwards: [], async forward(ev, target, opts = {}) { this.forwards.push({ ev, target, opts }); return true; } };
}
// WHAT CROSSES THE WIRE. relay.relayOut is called with `body: ev.body` — the envelope carries a
// BODY, never a dispatch line — so this is the exact string the far node's brain.turn is handed.
const wireBody = (mesh) => mesh.forwards[0].ev.body;

describe('REPRODUCE — the MESH FORWARD hands the far being its own handle', () => {
  it('`@don hola` crosses as `hola` — the envelope carries what was SAID, not how it was addressed', async () => {
    const mesh = fakeMesh();
    const { bridge } = build({ agents: RELAY_AGENTS, mesh });
    await bridge.emit(msg('@don hola'));
    expect(mesh.forwards).toHaveLength(1);
    expect(wireBody(mesh)).toBe('hola');                 // ← was '@don hola'
  });

  it('the bare form crosses the same way', async () => {
    const mesh = fakeMesh();
    const { bridge } = build({ agents: RELAY_AGENTS, mesh });
    await bridge.emit(msg('don hola'));
    expect(wireBody(mesh)).toBe('hola');                 // ← was 'don hola'
  });

  it('a message that is ONLY the handle crosses empty — a hail with nothing said after it', async () => {
    const mesh = fakeMesh();
    const { bridge } = build({ agents: RELAY_AGENTS, mesh });
    await bridge.emit(msg('@don'));
    expect(wireBody(mesh)).toBe('');
  });
});

describe('LOCKS — the mesh forward keeps everything else', () => {
  it('the ORIGIN transcript keeps the raw line — the record is what he typed', async () => {
    const mesh = fakeMesh();
    const { bridge, transcript } = build({ agents: RELAY_AGENTS, mesh });
    await bridge.emit(msg('@don hola'));
    expect(transcript.text.split('\n\n')[0]).toBe(`${HEAD}@don hola`);
  });

  it('a handle MID-SENTENCE still routes to the relay agent and crosses UNTOUCHED', async () => {
    const mesh = fakeMesh();
    const { bridge } = build({ agents: RELAY_AGENTS, mesh });
    await bridge.emit(msg('pregúntale a @don si viene'));
    expect(wireBody(mesh)).toBe('pregúntale a @don si viene');
  });

  it('the return address the envelope rides on is untouched — same chat, same sender, same target', async () => {
    const mesh = fakeMesh();
    const { bridge } = build({ agents: RELAY_AGENTS, mesh });
    await bridge.emit(msg('@don hola'));
    const { ev, target } = mesh.forwards[0];
    expect(ev.chatId).toBe('!hfm:beeper.com');
    expect(ev.chatName).toBe(CHAT_NAME);
    expect(ev.senderName).toBe('An');
    expect(target).toMatchObject({ being: 'don', to: 'don.mo', route: { room_id: 'egpt-mesh-kg-mo' } });
  });

  // KNOWN RESIDUE, MEASURED, NOT INTRODUCED HERE. `@don.mo` is still a typeable form (router.mjs's
  // header: "the @token match below stops at the dot and finds the agent"), and the matcher
  // resolves the token `don` — the `.mo` is not part of it. So withoutAddress, which is anchored
  // and handed exactly that token, takes `@don` off and leaves `.mo`. The LOCAL path has done the
  // identical thing since 6634a76; this is locked so a future change to it is deliberate, not so
  // that it is blessed.
  it('the dotted form leaves the node suffix behind — the matcher never claimed it', async () => {
    const mesh = fakeMesh();
    const { bridge } = build({ agents: RELAY_AGENTS, mesh });
    await bridge.emit(msg('@don.mo hola'));
    expect(wireBody(mesh)).toBe('.mo hola');
  });
});

// A controllable fake timer — the spine's own injected seam (the same shape
// tests/spine-auto-dwell.test.mjs uses), so the dwell and the typing delay are deterministic.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, delay = 0) => { const id = ++seq; pending.set(id, { fn, delay }); return { __id: id, unref() {} }; },
    clearTimeout: (t) => { if (t && t.__id != null) pending.delete(t.__id); },
    size: () => pending.size,
    flush() { const es = [...pending.values()]; pending.clear(); for (const { fn } of es) fn(); },
  };
}
async function settle(timers, rounds = 20) {
  for (let i = 0; i < rounds; i++) { await flush(); if (timers.size() === 0) break; timers.flush(); }
  await flush();
}

describe('REPRODUCE — the AUTO DWELL burst hands the being its own handle', () => {
  it('the burst the dwell fires is prompted WITHOUT the handle', async () => {
    const timers = fakeTimers();
    const brain = fakeBrain();
    const { bridge } = build({ mode: 'auto', brain, timers, rng: () => 0.5 });
    await bridge.emit(msg('e dame una opinion'));
    expect(brain.calls).toHaveLength(0);                       // dwelling — a person does not pounce
    await settle(timers);
    expect(brain.calls).toHaveLength(1);
    expect(promptOf(brain)).toBe(`${HEAD}dame una opinion`);   // ← was `${HEAD}e dame una opinion`
  });

  it('a burst of several lines: only the addressed one loses its handle', async () => {
    const timers = fakeTimers();
    const brain = fakeBrain();
    const { bridge } = build({ mode: 'auto', brain, timers, rng: () => 0.5 });
    await bridge.emit(msg('las celulas de la piel se renuevan', { msgKey: 'm1', atEStart: false, atEAnywhere: false }));
    await bridge.emit(msg('e y las neuronas?', { msgKey: 'm2' }));
    await settle(timers);
    expect(brain.calls).toHaveLength(1);
    expect(promptOf(brain)).toBe(`${headOf('m1')}las celulas de la piel se renuevan\n\n${headOf('m2')}y las neuronas?`);
  });

  it('the RECORD keeps the raw line', async () => {
    const timers = fakeTimers();
    const { bridge, transcript } = build({ mode: 'auto', timers, rng: () => 0.5 });
    await bridge.emit(msg('e dame una opinion'));
    await settle(timers);
    expect(transcript.text.split('\n\n')[0]).toBe(`${HEAD}e dame una opinion`);
  });
});

describe('REPRODUCE — the CONTEXT TURN hands the being its own handle', () => {
  // send_to_egpt: 'always' in a chat the being may NOT reply in: it runs to stay current, with no
  // UI and a recorded-but-unsent reply. It prompted with the raw event.
  it('a paused-but-read chat prompts WITHOUT the handle', async () => {
    const brain = fakeBrain();
    const { bridge } = build({ brain, mayReply: () => false, sendToEgpt: 'always' });
    await bridge.emit(msg('e dame una opinion'));
    expect(brain.calls).toHaveLength(1);
    expect(promptOf(brain)).toBe(`${HEAD}dame una opinion`);   // ← was `${HEAD}e dame una opinion`
  });

  it('an UNADDRESSED message in the same chat is unchanged, and the record stays raw either way', async () => {
    const brain = fakeBrain();
    const { bridge, transcript } = build({ brain, mayReply: () => false, sendToEgpt: 'always' });
    await bridge.emit(msg('las celulas de la piel se renuevan', { atEStart: false, atEAnywhere: false }));
    expect(promptOf(brain)).toBe(`${HEAD}las celulas de la piel se renuevan`);
    expect(transcript.text.split('\n\n')[0]).toBe(`${HEAD}las celulas de la piel se renuevan`);
  });
});

// ── AND WHAT THE FAR MODEL IS ACTUALLY HANDED ────────────────────────────────────────────────
//
// The wire assertions above are only half the question. The RESPONDER used to do its own rewrite
// before it built the turn — src/mesh/relay.mjs, until 2026-09-11:
//
//     const prompt = prov.body.replace(MENTION_RE, '').trim() || prov.body.trim();
//     const MENTION_RE = /(?:^|\s)@([a-z0-9_-]+)\b/i;
//
// That was a FOURTH mention system (router.mjs's own header is emphatic that this repo has already
// accumulated three and evicted two), and it was neither anchored, nor boundary-correct, nor aware
// of the bare form. Measured, on the body as it left the origin BEFORE 8edffe9:
//
//     '@don hola'                  -> 'hola'                     ← it did strip this one
//     'don hola'                   -> 'don hola'                 ← the BARE form: the handle arrived
//     '@don'                       -> '@don'                     ← the `||` fallback puts it BACK
//     '@don.mo hola'               -> '.mo hola'
//     'pregúntale a @don si viene' -> 'pregúntale a si viene'    ← it EATS content, mid-sentence
//
// IT IS GONE (operator 2026-09-11: "double-check whether it is even needed or intended"). Its one
// correct case is the one 8edffe9 moved to the ORIGIN — the only node whose vocabulary the handle
// is in — so what was left was the four wrong ones. The responder now hands the body over as it
// arrived; MENTION_RE stays only inside `mentionedBeing`, which FINDS the being of a `to:`-less
// open-channel envelope and strips nothing.
//
// So these tests run the REAL responder (createMeshService on node `mo`) over the body the origin
// actually put on the wire, and assert what `brain.turn` is handed on the far side.
function responderBridge() {
  const b = {
    sent: [], streams: [],
    async resolveChatId(n) { return n; },
    send(chat, text) { b.sent.push({ chat, text }); return { ok: true }; },
    async postStatus() { return 'p1'; },
    startStream(chat, init, opts = {}) {
      const h = { chat, init, opts, updates: [], finals: [] };
      h.update = (t) => h.updates.push(t);
      h.finish = async (t) => { h.finals.push(t); };
      b.streams.push(h);
      return h;
    },
  };
  return b;
}
// Deliver an envelope carrying `body` to node `mo`, whose local being is `don`. Returns its brain.
async function deliverToFarNode(body) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: 'ok', being }; } };
  const mesh = createMeshService({
    bridge: responderBridge(), brain,
    getConfig: () => ({ node_name: 'mo', agents: { don: { configuration: 'sonnet-high' } } }),
  });
  await mesh.handle({
    surface: 'whatsapp', chatId: 'RELAY', msgId: 'w1',
    body: encodeMesh({ by: 'An', body, from: CHAT_NAME, from_node: 'kg', to: 'don.mo', post_id: 'p1' }),
  });
  await flush(); await flush();
  return brain;
}
// Origin → wire → far node, in one call. Returns the prompt the far being's brain.turn received.
async function acrossTheMesh(typed) {
  const mesh = fakeMesh();
  const { bridge } = build({ agents: RELAY_AGENTS, mesh });
  await bridge.emit(msg(typed));
  const brain = await deliverToFarNode(wireBody(mesh));
  expect(brain.calls).toHaveLength(1);
  expect(brain.calls[0].being).toBe('don');
  return brain.calls[0].ev.body;
}

describe('REPRODUCE — end to end, what the FAR being is handed', () => {
  it('the BARE form: `don hola` reaches don as `hola`', async () => {
    expect(await acrossTheMesh('don hola')).toBe('hola');       // ← was 'don hola': MENTION_RE needs an '@'
  });

  it('the `@` form reaches don as `hola` too — and now WITHOUT depending on the responder rewrite', async () => {
    expect(await acrossTheMesh('@don hola')).toBe('hola');
  });

  it('a hail with nothing after it does not put the handle back', async () => {
    expect(await acrossTheMesh('@don')).toBe('');               // ← was '@don': the `|| prov.body` fallback
  });

  // REPRODUCE-FIRST for the removal (2026-09-11). The origin keeps a mid-sentence handle on
  // purpose — it is content, not an address — and the responder's own scan then ate it, so the
  // model was handed a sentence with a word missing. This is the whole case in one line, from the
  // typed message to what the far model reads.
  it('a handle MID-SENTENCE reaches the far being intact — the responder eats nothing', async () => {
    expect(await acrossTheMesh('pregúntale a @don si viene')).toBe('pregúntale a @don si viene');
  });
});
