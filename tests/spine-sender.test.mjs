// The single-message reply train (operator 2026-06-30): ONE message, opened eagerly
// as the "⏳ Thinking…" reply placeholder (instant ack + streaming target; id resolves
// during spin-up), edited in place into the answer. No separate knee-jerk (it piled up
// / cross-deleted in busy chats). body_emoji stamping is the port's job (locked in
// beeper-port.test); the FAKE bridge records raw text, so these assert the SENDER's
// markers (⏳ / ❌) + the reply-to placeholder. The reply carries NO inline end-marker:
// the historical signature / ∎ was removed (operator 2026-07-12) — the sole agent close
// is the agent_signature_close layer, applied downstream in the port (default empty).
import { describe, it, expect } from 'vitest';
import { createSender } from '../src/spine/sender.mjs';

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

  it("not surfaced (on-mode '...'): deletes the message, posts nothing", async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('...');
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(true);
    expect(bridge.sent).toHaveLength(0);
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
    expect(bridge.sent).toEqual([{ chat: '!c', text: 'reply', opts: { bodyEmoji: '🐶', label: null, replyTo: 'm1', agentSigOpen: '', agentSigClose: '' } }]);
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
