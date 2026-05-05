// tests/interpreter.test.mjs — first-stop routing tests.
//
// parseInput() is the function both surfaces call to decide whether the user
// typed a slash command, an @-mention, or a plain message. If this is wrong,
// every higher-level routing test is meaningless.

import { describe, it, expect } from 'vitest';
import {
  parseInput,
  COMMANDS,
  COMMAND_SET,
  commandSetFor,
  helpText,
  helpHtml,
} from '../interpreter.mjs';

describe('parseInput', () => {
  it('routes "/save name" as a command with cmd and rest', () => {
    expect(parseInput('/save name')).toEqual({
      type: 'command', cmd: '/save', rest: 'name',
    });
  });

  it('routes a bare "/save" as a command with empty rest', () => {
    expect(parseInput('/save')).toEqual({
      type: 'command', cmd: '/save', rest: '',
    });
  });

  it('preserves internal spaces in rest but trims leading/trailing whitespace', () => {
    expect(parseInput('/save   multi  word  arg   ')).toEqual({
      type: 'command', cmd: '/save', rest: 'multi  word  arg',
    });
  });

  it('handles "/" alone (caller will reject as unknown)', () => {
    expect(parseInput('/')).toEqual({
      type: 'command', cmd: '/', rest: '',
    });
  });

  it('routes "@cgpt1 hello" as a mention with target and body', () => {
    expect(parseInput('@cgpt1 hello')).toEqual({
      type: 'mention', target: 'cgpt1', body: 'hello',
    });
  });

  it('routes a bare "@cgpt1" as a mention with empty body', () => {
    expect(parseInput('@cgpt1')).toEqual({
      type: 'mention', target: 'cgpt1', body: '',
    });
  });

  it('routes "@cgpt1 " (trailing space, no body) as a mention with empty body', () => {
    expect(parseInput('@cgpt1 ')).toEqual({
      type: 'mention', target: 'cgpt1', body: '',
    });
  });

  it('treats a multiline @-mention body as one body, preserving inner newlines', () => {
    expect(parseInput('@cgpt1\nfirst line\nsecond line')).toEqual({
      type: 'mention', target: 'cgpt1', body: 'first line\nsecond line',
    });
  });

  it('routes plain text as message', () => {
    expect(parseInput('hello world')).toEqual({
      type: 'message', body: 'hello world',
    });
  });

  it('does not treat "@" alone as a mention', () => {
    expect(parseInput('@')).toEqual({ type: 'message', body: '@' });
  });

  it('does not treat an email as a mention (mid-line @)', () => {
    expect(parseInput('contact me at me@example.com please')).toEqual({
      type: 'message', body: 'contact me at me@example.com please',
    });
  });

  it('preserves unicode and emoji in message body', () => {
    expect(parseInput('hola, ¿qué tal? 🤖')).toEqual({
      type: 'message', body: 'hola, ¿qué tal? 🤖',
    });
  });
});

describe('command registry', () => {
  it('every entry is either a section header or has cmd+usage+desc', () => {
    for (const e of COMMANDS) {
      if (e.section) continue;
      expect(e).toHaveProperty('cmd');
      expect(e).toHaveProperty('usage');
      expect(e).toHaveProperty('desc');
      expect(['shell', 'extension', 'both']).toContain(e.surface);
    }
  });

  it('COMMAND_SET equals the union of all declared command tokens', () => {
    const declared = COMMANDS.filter(e => e.cmd).map(e => e.cmd);
    expect(COMMAND_SET).toEqual(new Set(declared));
  });

  it('declared command tokens are unique', () => {
    const declared = COMMANDS.filter(e => e.cmd).map(e => e.cmd);
    expect(declared.length).toBe(new Set(declared).size);
  });

  it('commandSetFor("shell") includes shell-only and both', () => {
    const set = commandSetFor('shell');
    expect(set.has('/save')).toBe(true);   // shell-only
    expect(set.has('/help')).toBe(true);   // both
    expect(set.has('/clear')).toBe(false); // extension-only
  });

  it('commandSetFor("extension") includes extension-only and both', () => {
    const set = commandSetFor('extension');
    expect(set.has('/clear')).toBe(true);  // extension-only
    expect(set.has('/help')).toBe(true);   // both
    expect(set.has('/save')).toBe(false);  // shell-only
  });

  it('shell ∪ extension equals COMMAND_SET (no surface left "neither")', () => {
    const shell = commandSetFor('shell');
    const ext = commandSetFor('extension');
    const union = new Set([...shell, ...ext]);
    expect(union).toEqual(COMMAND_SET);
  });
});

describe('help renderers', () => {
  it('helpText() returns a string containing every declared command', () => {
    const out = helpText([]);
    for (const e of COMMANDS) {
      if (!e.cmd) continue;
      expect(out).toContain(e.usage);
    }
  });

  it('helpText() marks shell-only and ext-only commands; leaves "both" unmarked', () => {
    const out = helpText([]);
    expect(out).toMatch(/\/save\s+.*\(shell\)/);
    expect(out).toMatch(/\/clear\s+.*\(ext\)/);
    // /help is "both" — should not have a (shell)/(ext) marker on its line.
    const helpLine = out.split('\n').find(l => l.startsWith('/help'));
    expect(helpLine).toBeDefined();
    expect(helpLine).not.toMatch(/\((shell|ext)\)/);
  });

  it('helpText() appends brain types when provided', () => {
    expect(helpText(['chatgpt-cdp', 'claude-cdp'])).toMatch(/Brain types: chatgpt-cdp/);
  });

  it('helpHtml() wraps usages in <code> and sections in <b>', () => {
    const out = helpHtml([]);
    expect(out).toMatch(/<code>\/save/);
    expect(out).toMatch(/<b>ROOM<\/b>/);
  });
});
