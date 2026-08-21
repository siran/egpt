import { describe, it, expect } from 'vitest';
import { createBrainSession } from '../src/brain-session.mjs';

describe('brain session engine dispatch', () => {
  it('keeps ccode as default and accepts codex explicitly', () => {
    expect(createBrainSession({ spawn: () => {} })).toHaveProperty('turn');
    expect(createBrainSession({ engine: 'codex', spawn: () => {}, bin: 'codex-test' })).toHaveProperty('turn');
  });

  it('accepts llama — the local llama-server engine (HTTP, sessionless)', () => {
    const s = createBrainSession({ engine: 'llama', stream: async () => 'ok' });
    expect(s).toHaveProperty('turn');
    expect(s.sessionId).toBeNull();
  });

  it('accepts pi — a full harness driving the local model', () => {
    expect(createBrainSession({ engine: 'pi', spawn: () => {} })).toHaveProperty('turn');
  });

  it('refuses an engine with no implementation', () => {
    expect(() => createBrainSession({ engine: 'nope' })).toThrow(/unsupported local brain engine/);
  });
});
