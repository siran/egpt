// Per-chat auto-mode semantics: standalone @e detection (no email false
// positives) and the reply gate for each mode.
import { describe, it, expect } from 'vitest';
import { mentionStatus, replyAllowed, receives, accumulates, isAutoMode, DEFAULT_AUTO_MODE, mayEmit } from '../src/auto-mode.mjs';

describe('mentionStatus', () => {
  it('detects @e as a standalone token, anywhere and at start', () => {
    expect(mentionStatus('@e hello')).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('To @e my assistant')).toEqual({ atEAnywhere: true, atEStart: false });
    expect(mentionStatus('@egpt do this')).toEqual({ atEAnywhere: true, atEStart: true });
  });
  it('does NOT match @e glued inside a word/email', () => {
    expect(mentionStatus('me@e.com')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('write to me@e.com please')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('hey@egpt')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('email')).toEqual({ atEAnywhere: false, atEStart: false });
  });
  it('handles leading whitespace for atEStart', () => {
    expect(mentionStatus('   @e hi').atEStart).toBe(true);
  });
});

describe('replyAllowed', () => {
  const M = (o) => ({ atEStart: false, atEAnywhere: false, replyToBot: false, ...o });
  it('on always allows (personality decides downstream)', () => {
    expect(replyAllowed('on', M())).toBe(true);
  });
  it('accum uses mention semantics over the flushed batch', () => {
    expect(replyAllowed('accum', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('accum', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('accum', M())).toBe(false);           // batch had no mention → no reply
  });
  it('mute / off never allow', () => {
    expect(replyAllowed('mute', M({ atEStart: true, atEAnywhere: true, replyToBot: true }))).toBe(false);
    expect(replyAllowed('off', M({ atEAnywhere: true }))).toBe(false);
  });
  it('mention-direct: only @e-at-start or reply-to-bot', () => {
    expect(replyAllowed('mention-direct', M({ atEStart: true }))).toBe(true);
    expect(replyAllowed('mention-direct', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('mention-direct', M({ atEAnywhere: true }))).toBe(false);   // mid-message ≠ start
    expect(replyAllowed('mention-direct', M())).toBe(false);
  });
  it('mention: @e anywhere or reply-to-bot', () => {
    expect(replyAllowed('mention', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('mention', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('mention', M())).toBe(false);
  });
  it('unknown mode falls back to mention semantics', () => {
    expect(replyAllowed('bogus', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('bogus', M())).toBe(false);
  });
});

describe('receives / accumulates / isAutoMode', () => {
  it('receives is true for everything except off', () => {
    for (const m of ['on', 'accum', 'mute', 'mention-direct', 'mention']) expect(receives(m)).toBe(true);
    expect(receives('off')).toBe(false);
  });
  it('accumulates only for accum', () => {
    expect(accumulates('accum')).toBe(true);
    expect(accumulates('on')).toBe(false);
  });
  it('isAutoMode + default', () => {
    expect(isAutoMode('mention')).toBe(true);
    expect(isAutoMode('nope')).toBe(false);
    expect(DEFAULT_AUTO_MODE).toBe('mention');
  });
});

// Regression: the WA bridge rewrites a mid-body "@e" to a LEADING "@e " prefix
// (at_e_anywhere, default on) purely so start-anchored parseInput ROUTES the
// message to @e. The per-chat reply gate must NOT be computed on that rewritten
// body — doing so promotes a mid-message @e to atEStart and silently collapses
// 'mention-direct' into 'mention'. The gate must read the user's ORIGINAL body.
// (Mirrors src/bridges/whatsapp.mjs: `_gateMs = mentionStatus(processed)` is
// taken BEFORE the `processed = '@e ' + processed` routing rewrite.)
describe('mention-direct gate is immune to the @e-routing rewrite', () => {
  // Minimal model of the bridge's at_e_anywhere expansion.
  const routeRewrite = (body) =>
    (!/^@\S/.test(body) && mentionStatus(body).atEAnywhere) ? `@e ${body}` : body;

  it('mid-body @e routes to @e but does NOT open mention-direct', () => {
    const original = 'hello @e are you up?';
    const routed = routeRewrite(original);
    expect(routed).toBe('@e hello @e are you up?');     // routing prepends for parseInput

    // WRONG (the bug): gate computed on the rewritten body → false-positive start.
    expect(mentionStatus(routed).atEStart).toBe(true);

    // RIGHT: gate computed on the original body → mention-direct stays closed,
    // mention still fires (the @e is genuinely present, just not at the start).
    const gate = mentionStatus(original);
    expect(gate).toEqual({ atEAnywhere: true, atEStart: false });
    expect(replyAllowed('mention-direct', gate)).toBe(false);
    expect(replyAllowed('mention', gate)).toBe(true);
  });

  it('genuine @e-at-start opens both mention and mention-direct', () => {
    const gate = mentionStatus('@e ping');
    expect(replyAllowed('mention-direct', gate)).toBe(true);
    expect(replyAllowed('mention', gate)).toBe(true);
  });
});

describe('mayEmit — outbound backstop', () => {
  it('HARD-blocks mute/off even when replyAllowed is (wrongly) true', () => {
    expect(mayEmit('mute', { replyAllowed: true })).toBe(false);
    expect(mayEmit('off',  { replyAllowed: true })).toBe(false);
  });
  it('allows on unconditionally', () => {
    expect(mayEmit('on', {})).toBe(true);
    expect(mayEmit('on', { replyAllowed: false })).toBe(true);
  });
  it('mention modes defer to the per-turn replyAllowed flag', () => {
    expect(mayEmit('mention', { replyAllowed: true })).toBe(true);
    expect(mayEmit('mention', { replyAllowed: false })).toBe(false);
    expect(mayEmit('mention-direct', { replyAllowed: true })).toBe(true);
    expect(mayEmit('accum', { replyAllowed: true })).toBe(true);
  });
  it('fails CLOSED for mention modes when the flag is absent', () => {
    expect(mayEmit('mention', {})).toBe(false);
    expect(mayEmit('mention-direct', {})).toBe(false);
  });
});
