// applyLayers — the pure concentric signature WRAP (operator 2026-07-12). The ONE
// mechanism behind all six signature slots; unit-tested here in isolation so the
// port/bridge call sites only have to pass the right layers.
import { describe, it, expect } from 'vitest';
import { applyLayers } from '../src/bridges/signature-layers.mjs';

describe('applyLayers — concentric signature wrap', () => {
  it('all-empty layers → core unchanged (byte-identical default)', () => {
    expect(applyLayers('🐶 egpt\nHola ∎', [{ open: '', close: '' }, { open: '', close: '' }]))
      .toBe('🐶 egpt\nHola ∎');
    expect(applyLayers('👂 transcript', [])).toBe('👂 transcript');
    expect(applyLayers('core')).toBe('core');
  });

  it('renders opens top-down (in order) then core then closes bottom-up (reversed)', () => {
    const out = applyLayers('CORE', [
      { open: 'B_open', close: 'B_close' },   // outer (bridge)
      { open: 'I_open', close: 'I_close' },   // inner (agent | transcription)
    ]);
    expect(out).toBe('B_open\nI_open\nCORE\nI_close\nB_close');
  });

  it('skips whitespace-only members but keeps the rest concentric', () => {
    // outer close set, inner open set, everything else empty/whitespace
    const out = applyLayers('CORE', [
      { open: '  ', close: 'B_close' },
      { open: 'I_open', close: '\n\t' },
    ]);
    expect(out).toBe('I_open\nCORE\nB_close');
  });

  it('a single layer with only a close appends below the core (no open line)', () => {
    expect(applyLayers('👂 hola', [{ open: '', close: '🌉' }])).toBe('👂 hola\n🌉');
  });

  it('preserves MULTILINE open/close and core members as blocks (newlines intact)', () => {
    const out = applyLayers('c1\nc2', [
      { open: 'o1\no2', close: 'z1\nz2' },
    ]);
    expect(out).toBe('o1\no2\nc1\nc2\nz1\nz2');
  });

  it('coerces non-string members and treats null/undefined as empty', () => {
    expect(applyLayers('CORE', [{ open: null, close: undefined }, { open: 0, close: false }]))
      .toBe('0\nCORE\nfalse');   // 0 / false stringify to non-blank → kept; null/undefined → skipped
  });
});
