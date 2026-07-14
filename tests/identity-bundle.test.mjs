import { describe, it, expect } from 'vitest';
import {
  readIdentityBundle,
  buildIdentityAnnouncement,
} from '../src/conversations-state.mjs';

describe('readIdentityBundle', () => {
  it('passes the manifest through and returns personality under both keys', async () => {
    // Non-existent personality + temp rules/pointers paths → empty bodies,
    // no real ~/.egpt reads.
    const b = await readIdentityBundle('zzz-no-such-persona', {
      manifest: 'MANIFEST-TEXT',
      rulesPath: '/nope/rules.md',
      pointersPath: '/nope/pointers.md',
    });
    expect(b.manifest).toBe('MANIFEST-TEXT');
    expect(b.personality).toBe('');
    expect(b.identity).toBe('');         // back-compat alias = personality
    expect(b.rules).toBe('');
    expect(b.pointers).toBe('');
  });
});

describe('announcement builders', () => {
  it('buildIdentityAnnouncement is the feed ONLY — no reboot/persona preamble', () => {
    const out = buildIdentityAnnouncement('default', 'MANIFEST\n\nPERSONALITY\n\nRULES');
    expect(out).not.toMatch(/Installing persona|Reboot complete/);   // preamble removed (2026-06-29)
    expect(out).toBe('MANIFEST\n\nPERSONALITY\n\nRULES');
  });
});
