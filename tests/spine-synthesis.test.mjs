import { describe, it, expect } from 'vitest';
import { createVoiceSynthesis } from '../src/spine/synthesis.mjs';

describe('createVoiceSynthesis (profile resolution)', () => {
  it('use_config picks the right profile; voice resolves from it', () => {
    const cfg = {
      voice_service: {
        use_config: 'main',
        main: {
          voice: 'es_MX-claude-high',
          fallback_order: ['remote'],
          remote: { type: 'piper-server-remote', endpoint: 'http://x', token: 'k' },
        },
        other: { voice: 'wrong-voice', fallback_order: [] },
      },
    };
    const vx = createVoiceSynthesis({ getConfig: () => cfg });
    expect(vx.voice).toBe('es_MX-claude-high');
    expect(typeof vx.synthesize).toBe('function');
  });

  it('missing voice_service config → synthesize returns null-safe, voice is null', async () => {
    const vx = createVoiceSynthesis({ getConfig: () => ({}) });
    expect(vx.voice).toBe(null);
    await expect(vx.synthesize('hi', null)).resolves.toBe(null);
  });

  it('missing profile (use_config names nothing present) → voice null, synthesize declines', async () => {
    const cfg = { voice_service: { use_config: 'ghost' } };
    const vx = createVoiceSynthesis({ getConfig: () => cfg });
    expect(vx.voice).toBe(null);
    await expect(vx.synthesize('hi', null)).resolves.toBe(null);
  });
});
