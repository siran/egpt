import { describe, it, expect } from 'vitest';
import { MODE_NOTES, modeNote, bodyMentionsBrain, bodyMentionsAny, resolveChatAutoMode, isLlamaBeing } from '../src/dispatch-helpers.mjs';

describe('dispatch-helpers (pure, lifted out of the App — Phase C strangler)', () => {
  it('modeNote returns the per-mode note, defaulting to mention', () => {
    expect(modeNote('on')).toBe(MODE_NOTES.on);
    expect(modeNote('off')).toBe(MODE_NOTES.off);
    expect(modeNote('bogus')).toBe(MODE_NOTES.mention);
  });

  it('bodyMentionsBrain matches @e/@egpt for "e", @<id> otherwise', () => {
    expect(bodyMentionsBrain('hey @e ping', 'e')).toBe(true);
    expect(bodyMentionsBrain('hey @egpt ping', 'e')).toBe(true);
    expect(bodyMentionsBrain('@wren build it', 'wren')).toBe(true);
    expect(bodyMentionsBrain('mail me@example.com', 'e')).toBe(false);   // not a leading @mention
    expect(bodyMentionsBrain('no mention here', 'e')).toBe(false);
  });

  it('bodyMentionsAny matches any of the names and escapes regex', () => {
    expect(bodyMentionsAny('hi @l there', ['l', 'llama'])).toBe(true);
    expect(bodyMentionsAny('hi @llama there', ['l', 'llama'])).toBe(true);
    expect(bodyMentionsAny('hi there', ['l'])).toBe(false);
    expect(bodyMentionsAny('x', [])).toBe(false);
  });

  it('resolveChatAutoMode follows explicit > auto_e_chats > default > DEFAULT', () => {
    expect(resolveChatAutoMode({ auto_e_modes: { c1: 'mention' }, auto_e_chats: ['c1'] }, 'c1')).toBe('mention'); // explicit wins
    expect(resolveChatAutoMode({ auto_e_chats: ['c1'] }, 'c1')).toBe('on');                                      // membership → on
    expect(resolveChatAutoMode({ auto_e_default_mode: 'mute' }, 'c9')).toBe('mute');                             // default mode
    expect(resolveChatAutoMode({}, 'c9')).toBe('mention');                                                       // DEFAULT_AUTO_MODE
    expect(resolveChatAutoMode(undefined, 'c9')).toBe('mention');                                                // null-safe
  });

  it('per-conversation mode (convMode) wins over every flat whatsapp key', () => {
    // reader-convergence: the conversation's OWN config mode is authoritative
    expect(resolveChatAutoMode({ auto_e_modes: { c1: 'on' }, auto_e_chats: ['c1'], auto_e_default_mode: 'on' }, 'c1', 'mute')).toBe('mute');
    // undefined/invalid convMode → falls through to the flat keys (byte-identical)
    expect(resolveChatAutoMode({ auto_e_chats: ['c1'] }, 'c1', undefined)).toBe('on');
    expect(resolveChatAutoMode({ auto_e_chats: ['c1'] }, 'c1', 'bogus')).toBe('on');
  });

  it('isLlamaBeing recognizes a llama sibling by type', () => {
    expect(isLlamaBeing({ l: { type: 'llama' } }, 'l')).toBe(true);
    expect(isLlamaBeing({ l: { type: 'local' } }, 'L')).toBe(true);    // case-insensitive being
    expect(isLlamaBeing({ wren: { type: 'ccode' } }, 'wren')).toBe(false);
    expect(isLlamaBeing({}, 'nobody')).toBe(false);
  });
});
