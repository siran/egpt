// invisible.test.mjs — stripInvisible: what the Telegram limb sends carries no invisible character,
// while emoji built from joiners and selectors stay intact.
import { describe, it, expect } from 'vitest';
import { stripInvisible } from '../src/invisible.mjs';
import { encodeNodeSignature, encodeChatCanary } from '../src/node-signature.mjs';

describe('stripInvisible', () => {
  it('removes tag frames, zero-width characters, word joiners, BOM and bidi controls', () => {
    expect(stripInvisible(`hola${encodeNodeSignature('EDW', 'ed')}${encodeChatCanary({ group: 'g', origin: 'o' })}`)).toBe('hola');
    const hidden = ['\u200B', '\u200C', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\uFEFF', '\u200E', '\u200F',
      '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u00AD', '\u3164', '\u{E0100}'];
    for (const c of hidden) expect(stripInvisible(`a${c}b`)).toBe('ab');
  });

  it('keeps emoji whole: ZWJ sequences, skin tones, VS16, keycaps, a subdivision flag', () => {
    for (const e of ['👩🏽‍💻', '❤️‍🔥', '🏳️‍🌈', '👁️‍🗨️', '👨‍👩‍👧', '🏋🏽‍♀️', '🏴‍☠️', '❤️', '1️⃣', '#️⃣', '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', '🇻🇪']) {
      expect(stripInvisible(`x ${e} y`)).toBe(`x ${e} y`);
    }
  });

  it('a joiner or selector outside an emoji goes: ZWJ between letters, VS16 after a letter, a repeated ZWJ or VS16', () => {
    expect(stripInvisible('a\u200Db')).toBe('ab');
    expect(stripInvisible('a\uFE0Fb')).toBe('ab');
    expect(stripInvisible('😀\u200D\u200D😀')).toBe('😀😀');
    expect(stripInvisible('❤\uFE0F\uFE0F')).toBe('❤\uFE0F');
  });

  it('a node frame right after 🏴 is not mistaken for a flag', () => {
    expect(stripInvisible(`🏴${encodeNodeSignature('gbsct')}`)).toBe('🏴');
  });

  it('leaves visible text, spaces and line breaks alone', () => {
    const s = 'Hola, ñandú — 中文 ✅ ⏳\n\ttab\r\n';
    expect(stripInvisible(s)).toBe(s);
    expect(stripInvisible(null)).toBe('');
  });
});
