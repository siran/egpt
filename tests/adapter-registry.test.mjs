// adapters/registry.mjs — the web-brain adapter registry (Command Surface Phase 2).
// loadAdapters() dynamically imports the shipped config/brains/*-cdp.mjs adapters and
// surfaces their match metadata; matchAdapter() is the pure URL→adapter resolver a tab
// must pass to become a `brain` member (no adapter → not a brain).
import { describe, it, expect } from 'vitest';
import { loadAdapters, matchAdapter } from '../src/adapters/registry.mjs';

describe('loadAdapters — the shipped config/brains adapters', () => {
  it('loads chatgpt-cdp and claude-cdp with a name + urlMatch', async () => {
    const adapters = await loadAdapters();
    const names = adapters.map((a) => a.name);
    expect(names).toContain('chatgpt-cdp');
    expect(names).toContain('claude-cdp');
    for (const a of adapters) expect(a.urlMatch).toBeInstanceOf(RegExp);
  });

  it('an empty/missing dir yields [] (never throws)', async () => {
    expect(await loadAdapters({ dir: '/no/such/dir/at/all' })).toEqual([]);
  });
});

describe('matchAdapter — URL → adapter (pure)', () => {
  const adapters = [
    { name: 'chatgpt-cdp', urlMatch: /chatgpt\.com|chat\.openai\.com/, homeUrl: 'https://chatgpt.com/' },
    { name: 'claude-cdp', urlMatch: /claude\.ai/, homeUrl: 'https://claude.ai/new' },
  ];

  it('matches a chatgpt tab', () => {
    expect(matchAdapter('https://chatgpt.com/c/abc', adapters)?.name).toBe('chatgpt-cdp');
  });
  it('matches a claude tab', () => {
    expect(matchAdapter('https://claude.ai/chat/def', adapters)?.name).toBe('claude-cdp');
  });
  it('returns null for a tab no adapter drives (gmail)', () => {
    expect(matchAdapter('https://mail.google.com/mail/u/0', adapters)).toBeNull();
  });
  it('returns null on an empty adapter list / missing url', () => {
    expect(matchAdapter('https://chatgpt.com/', [])).toBeNull();
    expect(matchAdapter(null, adapters)).toBeNull();
  });
});
