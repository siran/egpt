import { describe, it, expect } from 'vitest';
import { cmdUsesProfile } from '../src/tools/chrome-launcher.mjs';

describe('cmdUsesProfile: exact --user-data-dir match', () => {
  it('the sibling prefix does not match', () => {
    expect(cmdUsesProfile('chrome --user-data-dir=/p/work2 --x', '/p/work', 'linux')).toBe(false);
    expect(cmdUsesProfile('chrome --user-data-dir=/p/work', '/p/work2', 'linux')).toBe(false);
    expect(cmdUsesProfile('chrome --user-data-dir=/p/work/sub', '/p/work', 'linux')).toBe(false);
  });
  it('bare value ends at whitespace or end of line; --type=renderer lines match too', () => {
    expect(cmdUsesProfile('chrome --user-data-dir=/p/work --pipe', '/p/work', 'linux')).toBe(true);
    expect(cmdUsesProfile('chrome --type=renderer --user-data-dir=/p/work', '/p/work', 'linux')).toBe(true);
  });
  it('quoted paths with spaces match, in both quote positions', () => {
    expect(cmdUsesProfile('chrome --user-data-dir="/p/my work" --x', '/p/my work', 'linux')).toBe(true);
    expect(cmdUsesProfile('chrome "--user-data-dir=/p/my work" --x', '/p/my work', 'linux')).toBe(true);
    expect(cmdUsesProfile('chrome --user-data-dir="/p/my work2" --x', '/p/my work', 'linux')).toBe(false);
    expect(cmdUsesProfile('chrome --user-data-dir=/p/my work', '/p/my work', 'linux')).toBe(false);
  });
  it('Linux is case-sensitive and slash-exact', () => {
    expect(cmdUsesProfile('chrome --user-data-dir=/p/Work', '/p/work', 'linux')).toBe(false);
    expect(cmdUsesProfile('chrome --user-data-dir=C:\\p\\work', 'C:/p/work', 'linux')).toBe(false);
  });
  it('Windows ignores case and treats backslash and slash alike', () => {
    expect(cmdUsesProfile('chrome.exe --user-data-dir=C:\\Users\\An\\Work', 'c:/users/an/work', 'win32')).toBe(true);
    expect(cmdUsesProfile('chrome.exe "--user-data-dir=C:/Users/An/My Work"', 'C:\\users\\an\\my work', 'win32')).toBe(true);
    expect(cmdUsesProfile('chrome.exe --user-data-dir=C:\\Users\\An\\Work2', 'C:\\Users\\An\\Work', 'win32')).toBe(false);
  });
  it('no command or no profile never matches', () => {
    expect(cmdUsesProfile('', '/p/work', 'linux')).toBe(false);
    expect(cmdUsesProfile('chrome --user-data-dir=/p/work', '', 'linux')).toBe(false);
  });
});
