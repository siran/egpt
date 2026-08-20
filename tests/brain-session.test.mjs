import { describe, it, expect } from 'vitest';
import { createBrainSession } from '../src/brain-session.mjs';

describe('brain session engine dispatch', () => {
  it('keeps ccode as default and accepts codex explicitly', () => {
    expect(createBrainSession({ spawn: () => {} })).toHaveProperty('turn');
    expect(createBrainSession({ engine: 'codex', spawn: () => {}, bin: 'codex-test' })).toHaveProperty('turn');
  });

  it('refuses an engine with no implementation', () => {
    expect(() => createBrainSession({ engine: 'llama' })).toThrow(/unsupported local brain engine/);
  });
});
