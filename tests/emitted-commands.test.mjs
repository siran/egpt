import { describe, it, expect } from 'vitest';
import { splitEmittedReply, commandName } from '../src/emitted-commands.mjs';

describe('splitEmittedReply', () => {
  it('flags own-line slash commands, leaves prose alone', () => {
    const segs = splitEmittedReply('Nice point.\n/react heart\ntalk soon');
    expect(segs.map(s => s.isCommand)).toEqual([false, true, false]);
    expect(segs[1].text).toBe('/react heart');
  });
  it('does NOT treat an inline slash as a command', () => {
    const segs = splitEmittedReply('see /usr/local or use /react inline');
    expect(segs.every(s => !s.isCommand)).toBe(true);
  });
  it('tolerates leading whitespace and bare commands', () => {
    const segs = splitEmittedReply('   /react');
    expect(segs[0].isCommand).toBe(true);
  });
  it('a plain prose line is never a command', () => {
    expect(splitEmittedReply('hello there')[0].isCommand).toBe(false);
  });
});

describe('commandName', () => {
  it('extracts the bare command name', () => {
    expect(commandName('/react heart')).toBe('react');
    expect(commandName('  /Restart ')).toBe('restart');
    expect(commandName('not a command')).toBe('');
  });
});
