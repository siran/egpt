import { describe, it, expect } from 'vitest';
import { MODE_NOTES, modeNote, bodyMentionsBrain, bodyMentionsAny } from '../src/dispatch-helpers.mjs';

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
});
