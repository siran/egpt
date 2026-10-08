// The single-message reply train (operator 2026-06-30): ONE message, opened eagerly
// as the "⏳ Thinking…" reply placeholder (instant ack + streaming target; id resolves
// during spin-up), edited in place into the answer. No separate knee-jerk (it piled up
// / cross-deleted in busy chats). body_emoji stamping is the port's job (locked in
// beeper-port.test); the FAKE bridge records raw text, so these assert the SENDER's
// markers (⏳ / ❌) + the reply-to placeholder. The reply carries NO inline end-marker:
// the historical signature / ∎ was removed (operator 2026-07-12) — the sole agent close
// is the agent_signature_close layer, applied downstream in the port (default empty).
import { describe, it, expect } from 'vitest';
import { createSender, RETAINED_SEAM } from '../src/spine/sender.mjs';
import { LIVE_FRAME_MARK } from '../src/dispatch-line.mjs';

function fakeBridge() {
  const streams = [], sent = [];
  return {
    streams, sent,
    send(chat, text, opts) { sent.push({ chat, text, opts }); },
    startStream(chat, init, opts) {
      const h = {
        chat, init, opts, frames: [], finals: [], deleted: false, delivered: false,
        update(t) { h.frames.push(t); },
        async finish(t) { h.finals.push(t); h.delivered = true; },
        async delete() { h.deleted = true; },
      };
      streams.push(h); return h;
    },
  };
}

describe('sender — single-message reply train', () => {
  it('opens ONE "⏳ Thinking…" reply placeholder, streams with ⏳, ends with the BARE reply — NO end-marker (no separate knee-jerk)', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', replyTo: 'm1' });
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].init).toBe('⏳ Thinking…');             // the eager placeholder = instant ack + target
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶', persona: 'e' });
    out.update('Hola');
    expect(bridge.streams[0].frames).toEqual(['Hola ⏳']);
    await out.finish({ text: 'Hola mundo' });
    expect(bridge.streams[0].finals).toEqual(['Hola mundo']);       // bare reply — no trailing ∎ / end-marker (behavior CHANGE 2026-07-12)
    expect(bridge.sent).toHaveLength(0);                             // delivered in place — no fallback
  });

  // THE MODEL'S DELIBERATE '…' SILENCE (operator 2026-10-08, the live stray "🐶 E: ..." in eGPT
  // Rodz Lulu An + after a voice note). TWO binding rules: (1) a '…' SURFACES as a normal reply in
  // mention/mention-direct/accum and is HIDDEN only in on/auto; (2) a being NEVER removes a message
  // — a hidden '…' is EDITED to the quiet limb mark '✓', never deleted (2026-08-24 lock STANDS).
  // The sender sees the mode as `surface`: false ⇒ hidden (on/auto) ⇒ '✓'; true ⇒ surfaced ⇒ the
  // '…' is posted. REPRODUCE the prior wrong fix: it DELETED the placeholder (deleted=true) and on
  // a surfaced '…' erased the reply; this locks edit-to-'✓' hidden, '…' posted surfaced, no delete.
  it("a HIDDEN '...' silence (on/auto, surface:false) EDITS the placeholder to '✓' — never deleted, nothing posted", async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e' });
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(false);       // 2026-08-24 lock: nothing is ever deleted
    expect(bridge.streams[0].finals).toEqual(['✓']);     // edited away to the quiet limb mark, not left as '...'
    expect(bridge.sent).toHaveLength(0);                 // and no fresh send
  });

  it("a HIDDEN unicode '…' silence edits to '✓' too (both ellipsis shapes)", async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    await out.finish({ text: '…' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(false);
    expect(bridge.streams[0].finals).toEqual(['✓']);
  });

  it("a SURFACED '...' (mention/mention-direct/accum, surface:true) is POSTED as a normal reply — never deleted", async () => {
    // Rule 1: in mention/accum the model's '…' is its visible word. The gate surfaced it, the
    // sender delivers it verbatim like any other reply (gating.surfaces owns the per-mode drop).
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', replyTo: 'm1' });
    await out.finish({ text: '...' }, { surface: true });
    expect(bridge.streams[0].deleted).toBe(false);
    expect(bridge.streams[0].finals).toEqual(['...']);   // posted as the reply
    expect(bridge.sent).toHaveLength(0);                 // delivered in place
  });

  it("a QUEUED placeholder that settles on a HIDDEN '...' is EDITED to '✓' too (not only the primary 'Thinking…' one)", async () => {
    // A queued placeholder opens with QUEUED(ahead) text; when its turn settles on a hidden silence
    // it must edit to '✓' the same way the primary one does — never a stuck ⏳, never a delete.
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', queued: true, queuedAhead: 1 });
    expect(bridge.streams[0].init).toBe('⏳ Queued (1 ahead)…');   // opened in the queued state
    out.activate();                                                // its turn starts → flips to Thinking…
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(false);
    expect(bridge.streams[0].finals).toEqual(['✓']);
  });

  it("a HIDDEN '...' that lands AFTER real streamed prose keeps the prose — read text is never erased or '✓'-blanked", async () => {
    // The preserve-edge: the '✓' edit fires only when nothing but silence was shown. If prose was
    // already read, the placeholder settles on exactly that (append nothing), never a delete.
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('lo estoy mirando');
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(false);          // read prose protected → no delete
    expect(bridge.streams[0].finals).toEqual(['lo estoy mirando']);   // kept as-is, no '✓' appended
  });

  it("not surfaced with NOTHING from the model: the bridge says so in its own voice", async () => {
    // The bridge must never fabricate the model's '...' — a silence it invented
    // is indistinguishable from one the being chose.
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e' });
    await out.finish({ text: '' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(false);
    expect(bridge.streams[0].finals).toEqual(['<received silence (error?)>']);
  });

  it('surfaced but EMPTY (turn failed/empty): resolves VISIBLY with the no-reply marker, does NOT delete (DEFECT 1)', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', replyTo: 'm1' });
    await out.finish({ text: '' }, { surface: true });   // meant to surface, nothing came back
    expect(bridge.streams[0].deleted).toBe(false);       // NOT silently deleted / left stuck
    expect(bridge.streams[0].finals).toEqual(['⚠️ no reply (turn failed/empty)']);   // bare marker — no signature (2026-07-12)
    expect(bridge.sent).toHaveLength(0);                 // delivered in place, no fallback
  });

  it('falls back to a fresh send when the in-place edit did not deliver (§7)', async () => {
    const bridge = fakeBridge();
    bridge.startStream = (chat, init, opts) => { const h = { update() {}, async finish() {}, async delete() {}, delivered: false }; bridge.streams.push(h); return h; };
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', replyTo: 'm1' });
    await out.finish({ text: 'reply' });
    // The tag now also carries the per-agent signature-wrap slots (empty by default → the port adds nothing).
    // The core is the BARE reply — no inline ∎ / end-marker (2026-07-12); any agent close is a port-side layer.
    expect(bridge.sent).toEqual([{ chat: '!c', text: 'reply', opts: { bodyEmoji: '🐶', label: null, replyTo: 'm1', agentSigOpen: '', agentSigClose: '', persona: 'e' } }]);
  });

  it('send failure ends the message with ❌', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('partial');
    await out.fail(new Error('boom'));
    expect(bridge.streams[0].finals[0]).toMatch(/partial … ❌ Sending failed\./);
  });

  // NO inline end-marker by default (operator 2026-07-12): the historical signature / ∎ train
  // terminator was REMOVED — the sender emits the BARE reply, and the sole agent close is now the
  // agent_signature_close LAYER (applied by the port). With no agent_signature_close configured a
  // reply carries no end-marker at all — neither the reply nor the no-reply marker gets one.
  it('with NO agent_signature_close configured, the reply + the no-reply marker carry NO end-marker', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge, bodyEmojiOf: () => '🐦' });   // no agentSignatureCloseOf → defaults to ''
    const out = sender.open('!c', { being: 'wren', replyTo: 'm1' });
    await out.finish({ text: 'listo' });
    expect(bridge.streams[0].finals).toEqual(['listo']);          // bare reply — no trailing ∎ / signature

    const out2 = sender.open('!c', { being: 'wren' });
    await out2.finish({ text: '' }, { surface: true });           // empty → bare no-reply marker, no signature
    expect(bridge.streams[1].finals).toEqual(['⚠️ no reply (turn failed/empty)']);
  });

  // MULTILINE agent_signature_close (constraint #4, operator 2026-07-12): the agent close may be
  // multiline; the sender threads it VERBATIM into the tag (the PORT wraps it as a block below the
  // core), so the newline survives — verified here so a later refactor can't flatten it.
  it('a MULTILINE agent_signature_close threads verbatim into the tag (newline preserved, not flattened)', async () => {
    const bridge = fakeBridge();
    const agentSignatureCloseOf = () => 'line1\nline2';
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶', agentSignatureCloseOf }).open('!c', { being: 'e', replyTo: 'm1' });
    expect(bridge.streams[0].opts).toMatchObject({ agentSigClose: 'line1\nline2' });   // block survives — newline intact
  });

  // PER-AGENT signature-wrap slots (operator 2026-07-12): the sender resolves agent_signature_open/close
  // per-being (agent → node → '', via the injected agentSignature*Of resolvers) and threads them into the
  // tag; the PORT does the concentric wrap. Here the fake bridge just records the tag, so this locks the
  // resolution + hand-off.
  it('threads the being\'s resolved agent_signature open/close into the stream + fallback tag', async () => {
    const bridge = fakeBridge();
    bridge.startStream = (chat, init, opts) => { const h = { update() {}, async finish() {}, async delete() {}, delivered: false, opts }; bridge.streams.push(h); return h; };
    const agentSignatureOpenOf = (being) => (being === 'wren' ? '⟨wren⟩' : '');
    const agentSignatureCloseOf = (being) => (being === 'wren' ? '⟨/wren⟩' : '');
    const out = createSender({ bridge, bodyEmojiOf: () => '🐦', agentSignatureOpenOf, agentSignatureCloseOf })
      .open('!c', { being: 'wren', replyTo: 'm1' });
    expect(bridge.streams[0].opts).toMatchObject({ agentSigOpen: '⟨wren⟩', agentSigClose: '⟨/wren⟩' });
    await out.finish({ text: 'listo' });   // stream did not deliver → §7 fallback send carries the same tag
    expect(bridge.sent[0].opts).toMatchObject({ agentSigOpen: '⟨wren⟩', agentSigClose: '⟨/wren⟩' });
  });
});

// THE MESSAGE IS APPEND-ONLY (operator 2026-08-28): "the message is replaced for a 'final'
// message, and the in-transit thinking is deleted … sometimes it is writing something and then
// boom, it changes … the messages should also be stable". Every edit used to SUPERSEDE the last,
// so a settled reply that was not an EXTENSION of the streamed text erased what a human had
// already read. The invariant these lock: each value the message takes has its predecessor as a
// literal PREFIX. `stable` below is the whole train — every streamed frame (marker stripped) plus
// the settle — which is exactly the sequence a human watches.
describe('sender — the message never shrinks (append-only living mirror)', () => {
  const stable = (h) => [...h.frames.map((f) => f.replace(new RegExp(` ${LIVE_FRAME_MARK}$`), '')), ...h.finals];
  const monotone = (texts) => {
    for (let i = 1; i < texts.length; i++) expect(texts[i].startsWith(texts[i - 1])).toBe(true);
  };

  it('a settled reply that DIVERGES from the narration keeps the narration and reads as the answer LAST', async () => {
    // warm-cli resolves with `ev.result` — the LAST assistant message, not the accumulated
    // train — so the settle is routinely NOT an extension of what streamed.
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', replyTo: 'm1' });
    out.update('Voy a mirar');
    out.update('Voy a mirar el archivo…');
    await out.finish({ text: 'El archivo tiene 42 líneas.' });

    const final = bridge.streams[0].finals[0];
    expect(final).toContain('Voy a mirar el archivo…');            // NOTHING shown is removed
    expect(final.startsWith('Voy a mirar el archivo…')).toBe(true);  // the narration stays where it was
    expect(final.endsWith('El archivo tiene 42 líneas.')).toBe(true);// the settled answer is the LAST block
    expect(final).toBe(`Voy a mirar el archivo…${RETAINED_SEAM}El archivo tiene 42 líneas.`);
    monotone(stable(bridge.streams[0]));
    expect(bridge.streams[0].deleted).toBe(false);
  });

  // THE LIVE DOUBLE (operator 2026-10-06): E posted its reply, then the seam, then the SAME
  // answer again, reworded. warm-cli streams the WHOLE train (acc = intro + ANSWER — ALL the
  // assistant messages) and settles ccode with `ev.result` — only the LAST message, which is a
  // byte-SUFFIX of the train, NOT a prefix. absorb() tests only a prefix, so it sealed the final
  // behind the seam and showed the answer TWICE. Distinguished from the case above by one fact
  // that is cleanly testable: here the settled answer is ALREADY in what was read (a restatement),
  // there it was genuinely new. When the settled body is already shown, the stream is the fuller
  // rendering → settle on it, no seam, no re-append. (RED before the fix: this sealed + doubled.)
  it('a RESTATEMENT settle (ev.result = the LAST message, already the tail of the streamed train) shows the answer ONCE', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', replyTo: 'm1' });
    const INTRO = 'Busco la respuesta de Jaime en tu Gmail.';
    const ANSWER = 'Sí, ya lo leí: usa MariaDB y Gotenberg. ¿Aplico ya?';
    // the streamed train = intro + ANSWER (the real ccode multi-message shape, acc joins with \n)
    out.update(INTRO);
    out.update(`${INTRO}\n${ANSWER}`);
    // ev.result = the LAST assistant message only — a SUFFIX of the train, not a prefix
    await out.finish({ text: ANSWER });

    const final = bridge.streams[0].finals[0];
    expect(final).toBe(`${INTRO}\n${ANSWER}`);          // the full train, settled as-is
    expect(final).not.toContain(RETAINED_SEAM);         // no seam fired
    expect(final.split(ANSWER)).toHaveLength(2);         // the answer appears exactly ONCE
    monotone(stable(bridge.streams[0]));
  });

  // The A/B pair, explicit: the SAME intro-then-final shape, but the final carries content that
  // was NEVER streamed (not contained in what was read) → the erase-protection seam still fires
  // and both are kept (the 2026-08-28 "never erase read text" ruling the seam exists for).
  it('a GENUINELY-NEW final (not in the streamed train) still keeps BOTH across the seam', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', replyTo: 'm1' });
    out.update('Reviso el calendario…');
    await out.finish({ text: 'Tienes 3 citas el martes.' });    // new content, never streamed
    expect(bridge.streams[0].finals[0]).toBe(`Reviso el calendario…${RETAINED_SEAM}Tienes 3 citas el martes.`);
  });

  it('a MID-STREAM divergence seals once — the tail keeps growing under the SAME seam, never duplicated', async () => {
    // codex assigns `currentTurn.text = item.text` wholesale on item/completed and then keeps
    // streaming the next item's deltas onto it, so a turn can diverge mid-flight and continue.
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('primer intento');
    out.update('respuesta');            // wholesale replacement mid-stream
    out.update('respuesta buena');      // …which then extends normally
    await out.finish({ text: 'respuesta buena' });

    const h = bridge.streams[0];
    expect(h.finals).toEqual([`primer intento${RETAINED_SEAM}respuesta buena`]);
    expect(h.finals[0].split('respuesta buena')).toHaveLength(2);   // ONE copy — the seam is not re-stamped
    monotone(stable(h));
  });

  it('a pure-APPEND stream settles with the answer alone — no seam, no retained duplicate', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('Hola');
    out.update('Hola mun');
    await out.finish({ text: 'Hola mundo' });
    expect(bridge.streams[0].finals).toEqual(['Hola mundo']);       // the ordinary case is untouched
    monotone(stable(bridge.streams[0]));
  });

  it('the seam carries NO live marker — a peer node must still record the settle as history', () => {
    // isLiveStreamFrame (372c17f) classifies by the marker's PRESENCE anywhere in the frame,
    // so a seam containing ⏳ would make every settled message look transient to an observing
    // node and drop it from that node's transcript.
    expect(RETAINED_SEAM).not.toContain(LIVE_FRAME_MARK);
  });

  it('an empty/withheld settle still keeps what was already read (marker below the seam, nothing erased)', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge });
    const out = sender.open('!c', { being: 'e' });
    out.update('lo estoy mirando');
    await out.finish({ text: '' }, { surface: true });              // meant to surface, nothing came back
    expect(bridge.streams[0].finals).toEqual([`lo estoy mirando${RETAINED_SEAM}⚠️ no reply (turn failed/empty)`]);

    // …BUT THE SILENCE MARK NEVER LANDS BESIDE PROSE (operator 2026-09-01, live in the SPOILER
    // chat: "…doesn't need a reply from me. — ↓ reply — <received silence (error?)>"; his
    // diagnosis: "the bridge acted on it but forgot that the reply was non empty"). The mark
    // means one thing only — the bridge got NOTHING from the model — so appending it under a
    // seam to text a human has already read asserts a silence that visibly did not happen.
    // With something shown there is nothing left to resolve: the placeholder settles on exactly
    // what was read, the ⏳ comes off, nothing is erased and nothing is invented.
    const out2 = sender.open('!c', { being: 'e' });
    out2.update('lo estoy mirando');
    await out2.finish({ text: '' }, { surface: false });            // withheld with nothing from the model
    expect(bridge.streams[1].finals).toEqual(['lo estoy mirando']);
  });

  // A LIMB-ONLY turn is not silence either — the model spoke, in commands (operator 2026-09-01:
  // "then bridge can say 'processing command' (/react is a command), something like that, so
  // that there is legible record of what happened"). But that legible record is the VERBOSE view:
  // with verbose_thinking ON it says it is PROCESSING the command (operator 2026-10-06).
  it('verbose ON: a LIMB-ONLY turn says it is PROCESSING the command — never the silence mark', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge });
    const out = sender.open('!c', { being: 'e' });
    await out.finish({ text: '' }, { surface: false, commands: ['react'], verbose: true });
    expect(bridge.streams[0].finals).toEqual(['⚙️ processing command (/react)']);

    const out2 = sender.open('!c', { being: 'e' });
    out2.update('lo estoy mirando');
    await out2.finish({ text: '' }, { surface: false, commands: ['react', 'reply'], verbose: true });
    // append-only: what was read stays, the marker lands under the seam
    expect(bridge.streams[1].finals).toEqual([`lo estoy mirando${RETAINED_SEAM}⚙️ processing commands (/react /reply)`]);
  });

  // VERBOSE OFF (operator 2026-10-06, live with E/opus: "verbose thinking is off, and yet [the]
  // reaction also appear as a thinking process"). commandMark is the debug/record view; with
  // verbose OFF the chat must show just the reaction and no "⚙️ processing command" line. The
  // reaction already landed on its target; the ⏳-only placeholder holds no model content and
  // cannot be cleanly blanked (the real handle's finish('') leaves the "Thinking…" text in place),
  // so it resolves to the minimal neutral quietLimbMark — NOT commandMark, NOT the silence mark.
  it('verbose OFF: a LIMB-ONLY turn with nothing shown resolves QUIETLY (just the reaction) — no "processing command" line', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge });
    const out = sender.open('!c', { being: 'e' });
    await out.finish({ text: '' }, { surface: false, commands: ['react'], verbose: false });
    expect(bridge.streams[0].finals).toEqual(['✓']);                         // quiet mark — the ⏳ comes off, no debug line
    expect(bridge.streams[0].finals[0]).not.toContain('processing command'); // the operator's exact complaint
    expect(bridge.streams[0].deleted).toBe(false);                           // placeholder resolved, never destructively deleted
  });

  // …and the DEFAULT when no `verbose` is passed is quiet (matching the system default of
  // verbose_thinking = off, and the operator's intent). Locks the absent-case so a caller that
  // forgets the flag fails quiet, never leaks the debug line.
  it('verbose ABSENT: a LIMB-ONLY turn defaults to the quiet resolution (off)', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge });
    const out = sender.open('!c', { being: 'e' });
    await out.finish({ text: '' }, { surface: false, commands: ['react'] });   // no `verbose` key
    expect(bridge.streams[0].finals).toEqual(['✓']);
  });

  // VERBOSE OFF with something ALREADY READ: the narration stays, the ⏳ comes off, and NOTHING is
  // appended — the quietest honest resolution (the mirror of "the silence mark never lands beside
  // prose"). No commandMark, no seam.
  it('verbose OFF: a LIMB-ONLY turn keeps what was already read and appends nothing', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge });
    const out = sender.open('!c', { being: 'e' });
    out.update('lo estoy mirando');
    await out.finish({ text: '' }, { surface: false, commands: ['react', 'reply'], verbose: false });
    expect(bridge.streams[0].finals).toEqual(['lo estoy mirando']);          // narration kept, no seam, no commandMark
    expect(bridge.streams[0].finals[0]).not.toContain('processing');
  });

  // A turn WITH prose (surfaced, not limb-only) never reaches the commandMark path, so the verbose
  // flag does not touch it either way — the prose is delivered regardless.
  it('verbose flag does NOT affect a surfaced prose turn — the reply is delivered either way', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge });
    const outOff = sender.open('!c', { being: 'e' });
    await outOff.finish({ text: 'Hola mundo' }, { surface: true, verbose: false });
    expect(bridge.streams[0].finals).toEqual(['Hola mundo']);
    const outOn = sender.open('!c', { being: 'e' });
    await outOn.finish({ text: 'Hola mundo' }, { surface: true, verbose: true });
    expect(bridge.streams[1].finals).toEqual(['Hola mundo']);
  });

  it('a send failure ends the message with ❌ WITHOUT eating a divergent narration', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('empiezo');
    out.update('otra cosa');                                        // divergence
    await out.fail(new Error('boom'));
    expect(bridge.streams[0].finals).toEqual([`empiezo${RETAINED_SEAM}otra cosa … ❌ Sending failed.`]);
  });
});

// mode:auto — E impersonates the operator (operator 2026-07-05): the reply is PLAIN
// operator text. NO thinking scaffold (no "⏳ Thinking…" placeholder, no streamed edits)
// and NO persona tag (no bodyEmoji/label → the port stamps nothing). It posts ONCE,
// complete, on finish; a withheld/empty reply posts nothing.
describe('sender — mode:auto post-once (no persona head, no thinking train)', () => {
  it('posts ONCE as plain text: no placeholder/stream ever opens, streamed tokens ignored, no bodyEmoji/label', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶', labelOf: () => 'egpt' }).open('!c', { being: 'e', replyTo: 'm1', auto: true });
    expect(bridge.streams).toHaveLength(0);                    // NO thinking train opened
    out.update('partial');                                     // streamed tokens are dropped in auto
    await out.finish({ text: 'Hey, all good' });
    expect(bridge.streams).toHaveLength(0);                    // still none — post-once only
    expect(bridge.sent).toEqual([{ chat: '!c', text: 'Hey, all good', opts: { replyTo: 'm1' } }]);   // plain: no bodyEmoji/label
  });

  it('a withheld (silence) or empty auto reply posts NOTHING — staying silent is a valid operator move', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', auto: true });
    await out.finish({ text: '' }, { surface: true });          // empty
    await out.finish({ text: 'x' }, { surface: false });         // withheld ('…' silence)
    expect(bridge.sent).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);
  });
});

// PER-BEING CONNECTION ROUTING (operator 2026-08-30, multi-connection Beeper): bridgeOf is an
// OPTIONAL (being) => Bridge selector, resolved per open() call (open() already receives
// `being`) — a node wired to more than one Beeper account routes each being's reply through its
// OWN bridge instance. The `bridge` param stays REQUIRED and is the fallback: absent bridgeOf,
// or bridgeOf(being) returning nullish, must behave exactly like every test above this block
// (which pass only `bridge`) — additive, never a change to that existing path.
describe('sender — bridgeOf: per-being connection routing (multi-connection Beeper)', () => {
  it('bridgeOf present: each being streams + falls back through its OWN bridge — no cross-talk', async () => {
    const mainBridge = fakeBridge();
    const rodzBridge = fakeBridge();
    const bridgeOf = (being) => (being === 'rodz' ? rodzBridge : null);   // null for e/egpt → falls back to the default `bridge`
    const sender = createSender({ bridge: mainBridge, bridgeOf, bodyEmojiOf: () => '🐶', labelOf: (b) => b });

    const outMain = sender.open('!c1', { being: 'egpt', replyTo: 'm1' });
    await outMain.finish({ text: 'from egpt' });
    const outRodz = sender.open('!c2', { being: 'rodz', replyTo: 'm2' });
    await outRodz.finish({ text: 'from rodz' });

    expect(mainBridge.streams).toHaveLength(1);
    expect(mainBridge.streams[0].finals).toEqual(['from egpt']);
    expect(rodzBridge.streams).toHaveLength(1);
    expect(rodzBridge.streams[0].finals).toEqual(['from rodz']);
    // no cross-talk: neither bridge saw the other being's frames
    expect(mainBridge.sent).toHaveLength(0);
    expect(rodzBridge.sent).toHaveLength(0);
  });

  it('bridgeOf absent (the default path, every other caller): unchanged — every send rides the single `bridge`', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge, bodyEmojiOf: () => '🐶' });   // no bridgeOf — mirrors memberSender + every caller above this block
    const out = sender.open('!c', { being: 'e', replyTo: 'm1' });
    await out.finish({ text: 'hi' });
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['hi']);
  });

  it('bridgeOf returns nullish for a being: falls back to the default `bridge`, never throws', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge, bridgeOf: () => null, bodyEmojiOf: () => '🐶' });
    const out = sender.open('!c', { being: 'e', replyTo: 'm1' });
    await out.finish({ text: 'hi' });
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['hi']);
  });
});
