// Sandbox path-confinement for conversation-e. The claude-sdk brain installs
// a PreToolUse hook that denies file-tool calls whose path falls outside the
// conversation's own dirs — the guard that stops a WhatsApp contact reading
// ~/.egpt/config.yaml (verified live during 2026-05-23 dev: without it, @e
// read the config and returned `main_engineer: jay`).
import { describe, it, expect } from 'vitest';
import { canonPath, isPathInsideRoots } from '../config/brains/claude-sdk.mjs';

describe('canonPath', () => {
  it('translates msys /c/ to C:/ and lowercases + strips trailing slash', () => {
    expect(canonPath('/c/Users/An/.egpt/')).toBe('c:/users/an/.egpt');
    expect(canonPath('C:\\Users\\An\\.egpt')).toBe('c:/users/an/.egpt');
  });
});

describe('isPathInsideRoots — conversation-e file confinement', () => {
  const root = 'C:/Users/an/.egpt/conversations/whatsapp/daniel';
  const roots = [root];

  it('allows an absolute path inside the root', () => {
    expect(isPathInsideRoots(`${root}/transcript.md`, roots)).toBe(true);
  });

  it('allows the root directory itself', () => {
    expect(isPathInsideRoots(root, roots)).toBe(true);
  });

  it('DENIES the secrets file outside the sandbox (the original leak)', () => {
    expect(isPathInsideRoots('C:/Users/an/.egpt/config.yaml', roots)).toBe(false);
  });

  it("DENIES another contact's directory", () => {
    expect(isPathInsideRoots('C:/Users/an/.egpt/conversations/whatsapp/joyce/transcript.md', roots)).toBe(false);
  });

  it('blocks a sibling-prefix escape (.../daniel vs .../daniel-evil)', () => {
    expect(isPathInsideRoots('C:/Users/an/.egpt/conversations/whatsapp/daniel-evil/x', roots)).toBe(false);
  });

  it('resolves a relative path against baseCwd and allows if inside', () => {
    expect(isPathInsideRoots('notes/a.txt', roots, root)).toBe(true);
  });

  it('DENIES a relative path that climbs out via ..', () => {
    expect(isPathInsideRoots('../joyce/transcript.md', roots, root)).toBe(false);
    expect(isPathInsideRoots('../../config.yaml', roots, root)).toBe(false);
  });

  it('is case-insensitive (Windows FS) and msys-tolerant', () => {
    expect(isPathInsideRoots('/c/users/AN/.egpt/conversations/whatsapp/daniel/x.md', roots)).toBe(true);
  });

  it('treats a null/empty path as not-path-confined (true)', () => {
    // Tools with no path arg (e.g. WebFetch) are gated by the allowed-tool
    // check, not the path check.
    expect(isPathInsideRoots(null, roots, root)).toBe(true);
    expect(isPathInsideRoots('', roots, root)).toBe(true);
  });

  it('honors multiple roots (cwd + media dir)', () => {
    const multi = [root, 'C:/Users/an/.egpt/media/daniel_jid'];
    expect(isPathInsideRoots('C:/Users/an/.egpt/media/daniel_jid/img.jpg', multi)).toBe(true);
    expect(isPathInsideRoots('C:/Users/an/.egpt/media/joyce_jid/img.jpg', multi)).toBe(false);
  });

  it('denies everything when roots is empty', () => {
    expect(isPathInsideRoots('C:/anything', [])).toBe(false);
  });
});
