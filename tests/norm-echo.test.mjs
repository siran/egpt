// normEchoText — the normalization that lets the bridge RE-FIND a message it just
// posted in the chat's message list, so it can learn that message's confirmed id
// (resolveSentMessageId). Beeper stores our send back rewritten (HTML wrap + re-marked
// lists), so the sent form and the stored form MUST normalize equal or the id is never
// learned — and an unidentified send can echo back into dispatch as fresh input (the
// add-agent wizard flood, 2026-06-25). It no longer judges inbound messages: own-send
// suppression is id-exact (operator 2026-07-15).
import { describe, it, expect } from 'vitest';
import { normEchoText } from '../src/bridges/beeper.mjs';

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
