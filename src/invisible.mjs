// invisible.mjs — remove characters that render nothing (a leaf: imports nothing).
// Telegram reads hidden text as spam obfuscation (operator 2026-10-24), so the Telegram limb sends
// none: no tag characters, zero-width characters, BOM, bidi controls or other format characters.
//
// Kept, because visible emoji need them:
//   - ZWJ (U+200D) between two pictographs (👩🏽‍💻, ❤️‍🔥), after an optional skin tone or VS16;
//   - VS15/VS16 (U+FE0E/U+FE0F) right after an emoji-capable character (❤️, 1️⃣);
//   - a flag tag sequence: 🏴 + tag letters/digits + cancel tag (the England/Scotland/Wales flags).
const DROP = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E'
  + '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB'
  + '\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]';
const KEEP = [
  '\\u{1F3F4}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]+\\u{E007F}',
  '(?<=\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}\\uFE0F]?)\\u200D(?=\\p{Extended_Pictographic})',
  '(?<=\\p{Emoji})[\\uFE0E\\uFE0F]',
];
const RE = new RegExp(`(${KEEP.join('|')})|${DROP}`, 'gu');

export function stripInvisible(text) {
  return String(text ?? '').replace(RE, (m, keep) => keep ?? '');
}
