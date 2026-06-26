// normEchoText — self-echo normalization. The bridge drops its OWN sends by
// comparing normalized text; WhatsApp/Beeper rewrites the echo (HTML wrap + list
// markers), so the sent form and the echoed form MUST normalize equal or the
// echo re-enters dispatch as fresh input (the add-agent wizard flood, 2026-06-25).
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
