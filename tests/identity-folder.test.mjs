import { describe, it, expect } from 'vitest';
import { resolveIdentityDir, readIdentityFeed } from '../conversations-state.mjs';

describe('identity folders', () => {
  it('resolves the shipped default identity folder', () => {
    expect(resolveIdentityDir('default')).toBeTruthy();
  });
  it('returns null for an unknown identity', () => {
    expect(resolveIdentityDir('zzz-no-such-identity')).toBeNull();
  });
  it('readIdentityFeed concatenates default in NN order (non-empty)', async () => {
    const feed = await readIdentityFeed('default');
    expect(feed.length).toBeGreaterThan(0);
    // 00-identity.md leads → "I am eGPT" appears before rules/pointers content.
    expect(feed).toMatch(/eGPT/);
  });
  it('readIdentityFeed is empty for an unknown identity', async () => {
    expect(await readIdentityFeed('zzz-nope')).toBe('');
  });
});
