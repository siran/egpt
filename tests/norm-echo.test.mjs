// normEchoText — self-echo normalization. The bridge drops its OWN sends by
// comparing normalized text; WhatsApp/Beeper rewrites the echo (HTML wrap + list
// markers), so the sent form and the echoed form MUST normalize equal or the
// echo re-enters dispatch as fresh input (the add-agent wizard flood, 2026-06-25).
import { describe, it, expect } from 'vitest';
import { normEchoText, wordBag, bagContains } from '../src/bridges/beeper.mjs';

describe('normEchoText', () => {
  it('strips HTML tags and <br>, decoding entities', () => {
    expect(normEchoText('🦙 l<br>hi &amp; bye')).toBe('🦙 l hi & bye');
  });

  it('flattens an ordered "N)" prompt and its "- " bulleted echo to the same string', () => {
    const sent = '1) claude\n2) codex\n3) llama';
    const echo = '<p>- claude<br>- codex<br>- llama</p>';   // WhatsApp re-marks N) → bullets, wraps in HTML
    expect(normEchoText(sent)).toBe(normEchoText(echo));
  });

  it('flattens "N." and "*"/"•" markers too', () => {
    expect(normEchoText('1. one\n2. two')).toBe(normEchoText('* one\n• two'));
  });

  it('only strips a LEADING marker — inline "2)" in prose is preserved', () => {
    expect(normEchoText('see point 2) here')).toBe('see point 2) here');
  });

  it('a real short operator answer does NOT collide with a long prompt', () => {
    const prompt = normEchoText('1) claude\n2) codex');
    expect(normEchoText('1')).not.toBe(prompt);
    expect(normEchoText('wren')).not.toBe(prompt);
  });
});

describe('wordBag / bagContains — reformat-proof self-echo', () => {
  // the /e browser menu (multi-line) and its WhatsApp echo (one line, " - " bullets)
  const sent = 'egpt · conversations (newest first)\n  0) ✦ @egpt — global default brain\n  1) Joyce Vicente · e:haiku/mention\n  2) SPOILER ALERT · e:sonnet/mention\n(reply a number · q quit)';
  const echo = 'egpt · conversations (newest first) 0) ✦ @egpt — global default brain - 1) Joyce Vicente · e:haiku/mention - 2) SPOILER ALERT · e:sonnet/mention - reply a number · q quit';

  it('the reformatted echo is ≥85% contained in the original send', () => {
    expect(bagContains(wordBag(sent), wordBag(echo))).toBe(true);
  });

  it('an unrelated multi-word message (mostly non-menu words) is NOT contained', () => {
    expect(bagContains(wordBag(sent), wordBag('hey can you send me the report from yesterday afternoon please thanks'))).toBe(false);
  });

  it('short replies are protected by isEcho\'s size>=5 guard, not bagContains', () => {
    // bagContains alone WOULD match a single menu word (1/1=1.0), so isEcho only consults
    // it for inputs with >=5 words — a number / a name never reaches it.
    expect(wordBag('2').size).toBeLessThan(5);
    expect(wordBag('joyce').size).toBeLessThan(5);
    expect(wordBag('Hi, THERE! 42')).toEqual(new Set(['hi', 'there', '42']));
  });
});
