import { describe, it, expect } from 'vitest';
import { buildIdentityAnnouncement } from '../src/conversations-state.mjs';

describe('announcement builders', () => {
  it('buildIdentityAnnouncement is the feed ONLY — no reboot/persona preamble', () => {
    const out = buildIdentityAnnouncement('default', 'MANIFEST\n\nPERSONALITY\n\nRULES');
    expect(out).not.toMatch(/Installing persona|Reboot complete/);   // preamble removed (2026-06-29)
    expect(out).toBe('MANIFEST\n\nPERSONALITY\n\nRULES');
  });
});
