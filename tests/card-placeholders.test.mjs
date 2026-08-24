import { describe, it, expect } from 'vitest';
import { fillCardPlaceholders } from '../src/conversations-state.mjs';

// Cards quote CONFIG rather than hardcoding paths: operator 2026-08-24 —
// "both the path to the chrome browser and the profile path need to be told in
// pointers, and configured in config.yaml".
describe('card placeholders', () => {
  const cfg = { chrome: { bin: 'C:/chrome.exe', profile_dir: 'C:/prof/brain' } };

  it('fills a dotted config key', () => {
    expect(fillCardPlaceholders('chrome {{chrome.bin}}', cfg)).toBe('chrome C:/chrome.exe');
  });

  it('fills several on one line', () => {
    expect(fillCardPlaceholders('{{chrome.bin}} + {{chrome.profile_dir}}', cfg))
      .toBe('C:/chrome.exe + C:/prof/brain');
  });

  it('DROPS the whole line when the key is unset — never advertises a path this node lacks', () => {
    const out = fillCardPlaceholders('keep me\n  chrome {{chrome.bin}}\nkeep me too', {});
    expect(out).toBe('keep me\nkeep me too');
  });

  it('drops the line when the value is present but blank', () => {
    expect(fillCardPlaceholders('x {{chrome.bin}}', { chrome: { bin: '   ' } })).toBe('');
  });

  it('leaves ordinary text alone', () => {
    expect(fillCardPlaceholders('./transcript.md   this thread', cfg))
      .toBe('./transcript.md   this thread');
  });
});
