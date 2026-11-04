// agents.<name>.public (2026-10-15, edw-marketer): a lead sees only the being's reply text — no
// "⏳ Thinking…" placeholder, no persona prefix, no visible signature, no error line. Errors go to
// the admin channel instead. Gated in the two owners: the sender (placeholder + error lines, via
// its existing plain branch) and persona-wrap (the stamp + visible layers). The invisible
// structural node frame stays. E (not public) is locked unchanged.
import { describe, it, expect } from 'vitest';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { makeWrapPersona } from '../src/bridges/persona-wrap.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

function fakeBridge() {
  const streams = [], sent = [];
  return {
    streams, sent,
    async send(chat, text, opts) { sent.push({ chat, text, opts }); return { confirmedId: `id-${sent.length}` }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; } };
      streams.push(h); return h;
    },
  };
}
function build({ isPublic = (b) => b === 'edw-marketer' } = {}) {
  const bridge = fakeBridge();
  const notices = [];
  const sender = createSender({ bridge, bodyEmojiOf: () => '🐶', labelOf: (b) => (b === 'edw-marketer' ? 'Contoso' : 'egpt'), publicOf: isPublic, noticeAdmin: async (n) => { notices.push(n); } });
  return { bridge, notices, open: (being, o = {}) => sender.open('!lead', { being, replyTo: 'm1', ...o }) };
}

describe('sender — a public being: no placeholder, no error line, errors to the admin channel', () => {
  it('no placeholder or streamed edits; the reply posts once, unstamped, naming the being for the frame', async () => {
    const { bridge, open } = build();
    const out = open('edw-marketer');
    out.update('Hola');
    expect(bridge.streams).toEqual([]);
    await out.finish({ text: 'Hola, ¿de qué colegio me escribes?' });
    expect(bridge.sent).toEqual([{ chat: '!lead', text: 'Hola, ¿de qué colegio me escribes?', opts: { replyTo: 'm1', persona: 'edw-marketer' } }]);
  });

  it('a failed turn posts nothing in the chat and tells the admin channel why', async () => {
    const { bridge, notices, open } = build();
    await open('edw-marketer').fail(new Error('claude: error_during_execution — API Error: 529 overloaded'));
    expect(bridge.sent).toEqual([]);
    expect(notices).toEqual([{ being: 'edw-marketer', chatId: '!lead', text: 'turn failed: claude: error_during_execution — API Error: 529 overloaded' }]);
  });

  it('an empty surfaced reply and an empty silence are admin notices, never "⚠️ no reply" / "<received silence (error?)>"', async () => {
    const { bridge, notices, open } = build();
    await open('edw-marketer').finish({ text: '' });
    await open('edw-marketer').finish({ text: '' }, { surface: false });
    expect(bridge.sent).toEqual([]);
    expect(notices.map((n) => n.text)).toEqual(['⚠️ the turn failed — empty reply; not answered', '<received silence (error?)>']);
  });

  it('a deliberate "…" and a limb-only turn are silent everywhere', async () => {
    const { bridge, notices, open } = build();
    await open('edw-marketer').finish({ text: '…' }, { surface: false });
    await open('edw-marketer').finish({ text: '' }, { surface: false, commands: ['book'] });
    expect(bridge.sent).toEqual([]);
    expect(bridge.streams).toEqual([]);
    expect(notices).toEqual([]);
  });

  // The spine blanks a failed turn and hands the CLI's text over as `error` (src/spine/spine.mjs).
  it('a failed turn (5xx, safeguards flag) sends its CLI error to the admin channel, not the lead', async () => {
    const { bridge, notices, open } = build();
    const errors = [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.',
    ];
    for (const error of errors) await open('edw-marketer').finish({ text: '', failed: true, error });
    expect(bridge.sent).toEqual([]);
    expect(notices.map((n) => n.text)).toEqual(errors.map((e) => `model error: ${e.slice(0, 300)}`));
  });

  it('a reply that mentions an API error, even one opening with it, is delivered — no flag, no notice', async () => {
    const { bridge, notices, open } = build();
    await open('edw-marketer').finish({ text: 'Si ves un "API Error" en Contoso, escríbele a soporte.' });
    await open('edw-marketer').finish({ text: 'API Error 403 en Contoso significa que tu sesión expiró: vuelve a entrar.' });
    expect(bridge.sent).toHaveLength(2);
    expect(notices).toEqual([]);
  });

  it('a queued turn shows no "⏳ Queued" placeholder either', () => {
    const { bridge, open } = build();
    open('edw-marketer', { queued: true, queuedAhead: 2 });
    expect(bridge.streams).toEqual([]);
  });
});

describe('sender — LOCK: a being that is not public (E) is unchanged', () => {
  it('placeholder, stamp tag, streamed frames, ❌ and the no-reply mark exactly as without the flag', async () => {
    const run = async (opts) => {
      const bridge = fakeBridge();
      const sender = createSender({ bridge, bodyEmojiOf: () => '🐶', labelOf: () => 'egpt', ...opts });
      const a = sender.open('!c', { being: 'egpt', replyTo: 'm1' });
      a.update('Ho'); await a.finish({ text: 'Hola' });
      await sender.open('!c', { being: 'egpt' }).fail(new Error('x'));
      await sender.open('!c', { being: 'egpt' }).finish({ text: '' });
      await sender.open('!c', { being: 'egpt' }).finish({ text: '' }, { surface: false });
      await sender.open('!c', { being: 'egpt' }).finish({ text: 'API Error: 529 overloaded' });
      await sender.open('!c', { being: 'egpt', auto: true }).finish({ text: 'API Error: 529 overloaded' });
      return JSON.stringify({ streams: bridge.streams.map(({ init, opts: o, frames, finals }) => ({ init, o, frames, finals })), sent: bridge.sent });
    };
    const notices = [];
    const before = await run({});
    const after = await run({ publicOf: (b) => b === 'edw-marketer', noticeAdmin: async (n) => notices.push(n) });
    expect(after).toBe(before);
    expect(JSON.parse(after).streams[0].init).toBe(THINKING);
    // E's API error text still reaches its chat exactly as before (streamed; and plain under mode:auto)
    expect(JSON.parse(after).streams.at(-1).finals).toEqual(['API Error: 529 overloaded']);
    expect(JSON.parse(after).sent.at(-1).text).toBe('API Error: 529 overloaded');
    expect(notices).toEqual([]);
  });
});

describe('persona-wrap — a public being: no stamp, no visible layers; the invisible frame stays', () => {
  const opts = { bridgeSignatureOpen: '', bridgeSignatureClose: '🏰', nodeName: 'kg' };
  const wrap = makeWrapPersona({ ...opts, plainOf: (p) => p === 'edw-marketer' });
  it('the reply text, then only the structural frame', () => {
    const out = wrap({ bodyEmoji: '🐶', label: 'Contoso', persona: 'edw-marketer', agentSigClose: '∎' }, 'Hola');
    expect(out).toBe(`Hola${encodeNodeSignature('kg', 'edw-marketer')}`);
    expect(out).not.toMatch(/🐶|Contoso|🏰|∎/);
  });
  it('a limb caption or edit naming the being is plain too', () => {
    expect(wrap({ bodyEmoji: '🐶', label: 'Contoso', persona: 'edw-marketer' }, 'folleto.pdf')).toBe(`folleto.pdf${encodeNodeSignature('kg', 'edw-marketer')}`);
  });
  it('LOCK: E and system lines are wrapped exactly as without the flag', () => {
    const old = makeWrapPersona(opts);
    for (const [o, t] of [[{ bodyEmoji: '🐶', label: 'egpt', persona: 'egpt' }, 'hi'], [{}, 'system line'], [{ bodyEmoji: '🐶', label: 'egpt', persona: 'egpt', skipSignature: true }, 'relay']]) {
      expect(wrap(o, t)).toBe(old(o, t));
    }
    expect(wrap({ bodyEmoji: '🐶', label: 'egpt', persona: 'egpt' }, 'hi')).toContain('🏰');
  });
});
