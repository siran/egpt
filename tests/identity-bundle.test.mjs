import { describe, it, expect } from 'vitest';
import {
  readIdentityBundle,
  buildIdentityAnnouncement,
  buildPersonaAnnouncement,
} from '../conversations-state.mjs';

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
  it('buildIdentityAnnouncement embeds the whole feed', () => {
    const out = buildIdentityAnnouncement('default', 'MANIFEST\n\nPERSONALITY\n\nRULES');
    expect(out).toMatch(/Installing persona: default/);
    expect(out).toMatch(/MANIFEST/);
    expect(out).toMatch(/RULES/);
  });
  it('buildPersonaAnnouncement is personality-only (no manifest frame)', () => {
    const out = buildPersonaAnnouncement('banter', 'be playful');
    expect(out).toMatch(/Persona updated: banter/);
    expect(out).toMatch(/be playful/);
    expect(out).not.toMatch(/Installing persona/);
  });
});
