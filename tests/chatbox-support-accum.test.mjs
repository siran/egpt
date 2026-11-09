// A chatbox's SUPPORT line is gated as mode accum (owner 2026-11-09) while the visitor's lines keep the conversation's
// mode (on): the support line is recorded and accumulated and wakes the being only when it addresses it, with
// the same gate and prompt accum has everywhere. No mechanism of its own: the limb marks the event (lineMode),
// identity.build carries it, gating.decide resolves the line's mode, the spine does what it does for accum.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { replyLine } from '../src/transcript-log.mjs';
import { emptyState, ensureContact, patchBeing } from '../src/conversations-state.mjs';

const CHAT = 'http:acme-0123456789abcdef';
const stateWith = (mode) => {
  let st = ensureContact(emptyState(), 'http', CHAT, { pushedName: 'acme-0123456789abcdef' }).state;
  return mode ? patchBeing(st, 'http', CHAT, 'ed', { mode }) : st;
};
const gatingOf = (mode = 'on', extra = {}) => createGating({ getConfig: () => ({ agents: { ed: {} }, ...extra }), loadState: async () => stateWith(mode) });
const base = { surface: 'http', chatId: CHAT, kind: 'message' };
const none = { atEStart: false, atEAnywhere: false, replyToBot: false };
const visitor = { ...none, replyToBot: true };   // the widget is a reply thread with the being: every visitor line addresses it

describe('gating.decide: a line\'s own mode (lineMode)', () => {
  it('a conversation on: the visitor\'s line wakes the being, an unaddressed support line (accum) does not, an addressed one does', async () => {
    const g = gatingOf('on');
    expect(await g.decide('ed', base, visitor)).toMatchObject({ mode: 'on', mayReply: true });
    expect(await g.decide('ed', { ...base, lineMode: 'accum' }, none)).toMatchObject({ mode: 'accum', mayReply: false, receives: true });
    expect(await g.decide('ed', { ...base, lineMode: 'accum' }, { atEStart: true, atEAnywhere: true, replyToBot: false })).toMatchObject({ mode: 'accum', mayReply: true });
    expect(await g.decide('ed', { ...base, lineMode: 'accum' }, { atEStart: false, atEAnywhere: true, replyToBot: false })).toMatchObject({ mode: 'accum', mayReply: true });
  });

  it('the same gate as the conversation\'s own accum, in every mention state', async () => {
    const own = gatingOf('accum'), line = gatingOf('on');
    for (const atEStart of [false, true]) for (const atEAnywhere of [false, true]) for (const replyToBot of [false, true]) {
      const m = { atEStart, atEAnywhere, replyToBot };
      expect((await line.decide('ed', { ...base, lineMode: 'accum' }, m)).mayReply).toBe((await own.decide('ed', base, m)).mayReply);
    }
  });

  it('it never opens what the conversation closes: off, mute, a closed chat and the pause stay as they are', async () => {
    const addressed = { atEStart: true, atEAnywhere: true, replyToBot: false };
    for (const mode of ['off', 'mute']) {
      expect(await gatingOf(mode).decide('ed', { ...base, lineMode: 'accum' }, addressed), mode).toMatchObject({ mode, mayReply: false });
    }
    expect((await gatingOf('on', { dispatch: { auto_paused: true } }).decide('ed', { ...base, lineMode: 'accum' }, addressed)).mayReply).toBe(false);
  });

  it('a conversation that is mention keeps mention-direct\'s and mention\'s reading: accum gates like mention', async () => {
    expect((await gatingOf('mention').decide('ed', { ...base, lineMode: 'accum' }, { atEStart: false, atEAnywhere: true, replyToBot: false })).mayReply).toBe(true);
    expect((await gatingOf('mention-direct').decide('ed', { ...base, lineMode: 'accum' }, none)).mayReply).toBe(false);
  });

  it('a line with no lineMode, or an unknown one, is gated by the conversation\'s mode alone', async () => {
    const g = gatingOf('on');
    expect(await g.decide('ed', base, none)).toMatchObject({ mode: 'on', mayReply: true });
    expect(await g.decide('ed', { ...base, lineMode: 'nope' }, none)).toMatchObject({ mode: 'on', mayReply: true });
  });
});

describe('identity.build carries the line\'s mode', () => {
  const identity = createIdentity({ now: () => Date.UTC(2026, 10, 9, 14, 5) });
  it('lineMode from the limb, null for every other inbound', () => {
    const from = { chatId: CHAT, chatName: 'acme-0123456789abcdef', network: 'http', senderName: 'support:tina', msgKey: '1', backlog: false };
    expect(identity.build({ body: 'hola', from: { ...from, lineMode: 'accum' } }).lineMode).toBe('accum');
    expect(identity.build({ body: 'hola', from }).lineMode).toBeNull();
  });
});

// The whole path with the real gate and identity: a conversation on, the visitor and a support person talking.
describe('the spine: visitor on, support accum', () => {
  function build() {
    let cb = null;
    const sent = [], calls = [];
    const text = { v: '' };
    const identity = createIdentity({ now: () => Date.UTC(2026, 10, 9, 14, 5) });
    const spine = createSpine({
      bridge: { onMessage(fn) { cb = fn; }, send(chat, t) { sent.push(t); }, stop() {} },
      brain: { async turn(being, ev) { calls.push(ev.line); return { text: 'respuesta', sessionId: 's', being }; } },
      identity, router: { resolve: () => 'ed' }, gating: gatingOf('on'),
      sender: { open(chatId) { return { update() {}, fail() {}, async finish(reply) { const t = typeof reply === 'string' ? reply : reply?.text; if (t) sent.push(t); } }; } },
      transcript: { async log(ev, reply) { text.v += (reply == null ? (ev.line ?? ev.body) : replyLine({ being: 'ed', body: reply.text, surfaced: reply.surfaced !== false })) + '\n\n'; } },
      heartbeats: { runDue() {} }, readTranscript: async () => text.v, clock: { now: () => Date.UTC(2026, 10, 9, 14, 5) },
      labelOf: (b) => b,
    });
    spine.start();
    let n = 0;
    const from = (who, o) => ({ chatId: CHAT, chatName: 'acme-0123456789abcdef', network: 'http', senderName: who, userId: CHAT, msgKey: String(++n), msgTs: Date.UTC(2026, 10, 9, 14, 5) + n * 60_000, isReaction: false, ...o });
    return {
      calls, text,
      visitor: (body) => cb({ body, from: from('visitor', { replyToBot: true, replyToBeing: 'ed' }) }),
      support: (body, o = {}) => cb({ body, from: from('support:tina', { lineMode: 'accum', atEStart: false, atEAnywhere: false, replyToBot: false, ...o }) }),
    };
  }

  it('the visitor\'s line runs a turn; an unaddressed support line is recorded and runs none', async () => {
    const t = build();
    await t.visitor('no me sale la boleta');
    expect(t.calls).toHaveLength(1);
    await t.support('Estoy revisando su caso.');
    expect(t.calls).toHaveLength(1);
    expect(t.text.v).toContain('Estoy revisando su caso.');
  });

  it('a support line that addresses the being runs a turn, prompted with the support lines accumulated since its last turn', async () => {
    const t = build();
    await t.visitor('no me sale la boleta');
    await t.support('El usuario tiene el permiso en falso.');
    await t.support('Ya lo corregí en la base.');
    expect(t.calls).toHaveLength(1);
    await t.support('@ed avísale que ya puede entrar', { atEStart: true, atEAnywhere: true });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]).toContain('avísale que ya puede entrar');
    expect(t.calls[1]).toContain('El usuario tiene el permiso en falso.');
    expect(t.calls[1]).toContain('Ya lo corregí en la base.');
  });

  it('the visitor keeps the being on: a visitor line after the support lines runs a turn as before', async () => {
    const t = build();
    await t.support('hola, soy Tina');
    await t.visitor('gracias, ya entré');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toContain('gracias, ya entré');
  });
});
