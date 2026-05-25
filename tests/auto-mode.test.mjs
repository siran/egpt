// Per-chat auto-mode semantics: standalone @e detection (no email false
// positives) and the reply gate for each mode.
import { describe, it, expect } from 'vitest';
import { mentionStatus, replyAllowed, receives, accumulates, isAutoMode, DEFAULT_AUTO_MODE } from '../src/auto-mode.mjs';

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
