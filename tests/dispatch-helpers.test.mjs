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

  it('resolveChatAutoMode: convMode > auto_e_default_mode > DEFAULT (per-chat flat keys removed)', () => {
    expect(resolveChatAutoMode({ auto_e_default_mode: 'mute' }, 'c1', 'on')).toBe('on');   // conversation mode wins
    expect(resolveChatAutoMode({ auto_e_default_mode: 'mute' }, 'c9')).toBe('mute');       // global default
    expect(resolveChatAutoMode({}, 'c9')).toBe('mention');                                 // DEFAULT_AUTO_MODE
    expect(resolveChatAutoMode(undefined, 'c9')).toBe('mention');                          // null-safe
    expect(resolveChatAutoMode({ auto_e_default_mode: 'mute' }, 'c9', 'bogus')).toBe('mute'); // invalid convMode ignored
  });

  it('legacy flat per-chat keys are IGNORED (migrated to per-conversation entry.mode)', () => {
    // auto_e_modes / auto_e_chats no longer influence the result
    expect(resolveChatAutoMode({ auto_e_modes: { c1: 'on' }, auto_e_chats: ['c1'] }, 'c1')).toBe('mention'); // → DEFAULT, not 'on'
    expect(resolveChatAutoMode({ auto_e_modes: { c1: 'on' }, auto_e_default_mode: 'mute' }, 'c1')).toBe('mute'); // → default, not 'on'
  });

  it('isLlamaBeing recognizes a llama sibling by type', () => {
    expect(isLlamaBeing({ l: { type: 'llama' } }, 'l')).toBe(true);
    expect(isLlamaBeing({ l: { type: 'local' } }, 'L')).toBe(true);    // case-insensitive being
    expect(isLlamaBeing({ wren: { type: 'ccode' } }, 'wren')).toBe(false);
    expect(isLlamaBeing({}, 'nobody')).toBe(false);
  });
});
