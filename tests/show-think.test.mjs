// show-think Telegram formatting (operator 2026-06-13). Locks:
//   • a blank line between thinking statements;
//   • the live "(thinking... 🤔)" suffix vs the frozen "(done ✅)" finished
//     signal (so the operator can tell when the turn finished);
//   • the thinking body is HTML-escaped, never markdown-rendered (an unbalanced
//     mid-stream tail must not break Telegram's edit — the bug behind "I cant
//     see the 🤔 suffix").
import { describe, it, expect } from 'vitest';
import {
  spaceThinkStatements, renderThink, THINKING_SUFFIX, THOUGHT_SUFFIX, THINK_CLIP,
} from '../src/show-think.mjs';

// Mirror egpt's escapeHtml so the test exercises the real escaping shape.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('spaceThinkStatements', () => {
  it('puts a blank line between statements', () => {
    expect(spaceThinkStatements('a\nb\nc')).toBe('a\n\nb\n\nc');
  });
  it('collapses existing blank runs (no triple spacing)', () => {
    expect(spaceThinkStatements('a\n\n\nb')).toBe('a\n\nb');
  });
  it('drops whitespace-only lines and trailing whitespace', () => {
    expect(spaceThinkStatements('a  \n   \nb')).toBe('a\n\nb');
  });
  it('normalizes CRLF', () => {
    expect(spaceThinkStatements('a\r\nb')).toBe('a\n\nb');
  });
  it('preserves leading indentation', () => {
    expect(spaceThinkStatements('a\n  b')).toBe('a\n\n  b');
  });
  it('empty / nullish in → empty out', () => {
    expect(spaceThinkStatements('')).toBe('');
    expect(spaceThinkStatements(null)).toBe('');
    expect(spaceThinkStatements(undefined)).toBe('');
  });
});

describe('renderThink', () => {
  const header = '💭 <b>wren@kg</b>';

  it('empty body → placeholder with a blank line after the header', () => {
    expect(renderThink({ header, body: '', escape: esc }))
      .toBe('💭 <b>wren@kg</b>\n\n⌛ thinking…');
  });

  it('live thinking spaces statements and ends with (thinking... 🤔)', () => {
    expect(renderThink({ header, body: 'one\ntwo', escape: esc }))
      .toBe('💭 <b>wren@kg</b>\n\none\n\ntwo' + THINKING_SUFFIX);
  });

  it('done flips the suffix to the (done ✅) finished signal', () => {
    expect(renderThink({ header, body: 'one\ntwo', escape: esc, done: true }))
      .toBe('💭 <b>wren@kg</b>\n\none\n\ntwo' + THOUGHT_SUFFIX);
  });

  it('escapes the body so an unbalanced mid-stream tail never breaks Telegram', () => {
    expect(renderThink({ header: 'H', body: '**bold and <tag', escape: esc }))
      .toBe('H\n\n**bold and &lt;tag' + THINKING_SUFFIX);
  });

  it('live and finished suffixes are DIFFERENT (the whole point)', () => {
    expect(THINKING_SUFFIX).not.toBe(THOUGHT_SUFFIX);
  });

  it('suffixes are the operator-specified literals', () => {
    expect(THINKING_SUFFIX).toBe('\n\n(thinking... 🤔)');
    expect(THOUGHT_SUFFIX).toBe('\n\n(done ✅)');
  });

  it('trims trailing whitespace/newlines off the header', () => {
    expect(renderThink({ header: 'H\n', body: 'x', escape: esc }))
      .toBe('H\n\nx' + THINKING_SUFFIX);
  });

  it('clips a very long body to the tail (stays under Telegram cap, keeps suffix)', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const out = renderThink({ header: 'H', body: long, escape: esc });
    expect(out.length).toBeLessThan(4096);
    expect(out).toContain('…');
    expect(out.endsWith(THINKING_SUFFIX)).toBe(true);
    expect(THINK_CLIP).toBe(3500);
  });
});
