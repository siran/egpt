// tests/author-emoji.test.mjs — author → emoji mapping for cross-surface
// rendering. Pins every author shape we mirror across TG/WA/shell/extension
// so regressions can't silently land messages as ❓.
//
// Real-world author shapes that have shown up across transcripts:
//   'system'                — egpt status / hint voice
//   'You'                   — local-shell echo of what the user just typed
//   'An@kg'                 — shell user, user is "An", local node is "kg"
//   'An@wa'                 — same user typing from WhatsApp, mirrored to shell
//   'An@moto'               — same user, custom client_name override
//   'egpt@kg'               — egpt persona reply
//   'human@chrome-abc'      — extension's default user tag (regression target)
//   'cx@kg'                 — a /attach-style local session named cx
//   'codex1@shell-3232'     — peer brain reply (different node)

import { describe, it, expect } from 'vitest';
import { emojiForAuthor } from '../author-emoji.mjs';

const OPTS = {
  user_name:     'An',
  user_emoji:    '🦅',
  egpt_emoji:    '🧠',
  persona_emoji: '🐶',
  human_emoji:   '🌐',
};

describe('emojiForAuthor — system + local shell', () => {
  it("'system' → egpt voice", () => {
    expect(emojiForAuthor('system', {}, OPTS)).toBe('🧠');
  });

  it("'You' (the local shell echo) → user_emoji", () => {
    expect(emojiForAuthor('You', {}, OPTS)).toBe('🦅');
  });
});

describe('emojiForAuthor — user across surfaces', () => {
  it('shell user bare → user_emoji', () => {
    expect(emojiForAuthor('An', {}, OPTS)).toBe('🦅');
  });

  it('shell user with @<surface> suffix → user_emoji (no fallback to ❓)', () => {
    expect(emojiForAuthor('An@kg',   {}, OPTS)).toBe('🦅');
    expect(emojiForAuthor('An@wa',   {}, OPTS)).toBe('🦅');
    expect(emojiForAuthor('An@moto', {}, OPTS)).toBe('🦅');
  });

  it('configurable user_name (custom shell user) → user_emoji', () => {
    const custom = { ...OPTS, user_name: 'Alice' };
    expect(emojiForAuthor('Alice@kg', {}, custom)).toBe('🦅');
    // The default 'An' should NOT match when user_name is overridden.
    expect(emojiForAuthor('An@kg',    {}, custom)).toBe('❓');
  });
});

describe('emojiForAuthor — egpt persona', () => {
  it('bare egpt → persona emoji', () => {
    expect(emojiForAuthor('egpt', {}, OPTS)).toBe('🐶');
  });

  it("egpt@<surface> (persona reply tagged with originating node) → persona emoji", () => {
    expect(emojiForAuthor('egpt@kg',         {}, OPTS)).toBe('🐶');
    expect(emojiForAuthor('egpt@chrome-abc', {}, OPTS)).toBe('🐶');
  });
});

describe('emojiForAuthor — extension human tag (regression: was landing as ❓ in WA)', () => {
  it('bare human → human_emoji', () => {
    expect(emojiForAuthor('human', {}, OPTS)).toBe('🌐');
  });

  it("'human@chrome-<id>' → human_emoji  (shell mirror of extension-typed messages to TG/WA)", () => {
    expect(emojiForAuthor('human@chrome-abc',  {}, OPTS)).toBe('🌐');
    expect(emojiForAuthor('human@chrome-mxpc', {}, OPTS)).toBe('🌐');
  });

  it("custom human_emoji is honored (e.g. /config emojis {\"human\":\"🌍\"})", () => {
    const custom = { ...OPTS, human_emoji: '🌍' };
    expect(emojiForAuthor('human@chrome-xyz', {}, custom)).toBe('🌍');
  });
});

describe('emojiForAuthor — /attach session lookup (strip @suffix)', () => {
  const sessions = {
    cx:    { emoji: '🦊', brain: 'codex' },
    cc:    { emoji: '🐻', brain: 'ccode' },
  };

  it('session with @suffix → looks up bare name in sessions map (NOT keyed on full author)', () => {
    expect(emojiForAuthor('cx@kg', sessions, OPTS)).toBe('🦊');
    expect(emojiForAuthor('cc@kg', sessions, OPTS)).toBe('🐻');
  });

  it('bare session name without suffix also resolves', () => {
    expect(emojiForAuthor('cx', sessions, OPTS)).toBe('🦊');
  });

  it('session without an emoji set → falls back to ❓ (not crash)', () => {
    const noEmoji = { foo: { brain: 'codex' } };
    expect(emojiForAuthor('foo@kg', noEmoji, OPTS)).toBe('❓');
  });
});

describe('emojiForAuthor — unknown / peer authors', () => {
  it('unknown author returns ❓', () => {
    expect(emojiForAuthor('codex1@shell-3232', {}, OPTS)).toBe('❓');
  });

  it('null / undefined author does not crash', () => {
    expect(() => emojiForAuthor(null,      {}, OPTS)).not.toThrow();
    expect(() => emojiForAuthor(undefined, {}, OPTS)).not.toThrow();
  });

  it('missing sessions map does not crash', () => {
    expect(emojiForAuthor('cx@kg', undefined, OPTS)).toBe('❓');
    expect(emojiForAuthor('cx@kg', null,      OPTS)).toBe('❓');
  });
});

describe('emojiForAuthor — defaults (no opts)', () => {
  it('uses sensible defaults when called with empty opts', () => {
    expect(emojiForAuthor('system',           {}, {})).toBe('🧠');
    expect(emojiForAuthor('You',              {}, {})).toBe('🦅');
    expect(emojiForAuthor('egpt@kg',          {}, {})).toBe('🐶');
    expect(emojiForAuthor('human@chrome-abc', {}, {})).toBe('🌐');
    // user_name defaults to 'An' (the project's canonical default).
    expect(emojiForAuthor('An@kg',            {}, {})).toBe('🦅');
  });
});
