import { describe, it, expect } from 'vitest';
import { reapPort } from '../src/tools/reap-port.mjs';

// reapPort kills real processes, so the only safe deterministic assertions are
// the no-op paths: a free port (nothing to kill) and invalid input (no scan).
// It must NEVER throw — a supervisor calls it on the spawn hot-path.
describe('reapPort', () => {
  it('returns 0 and does not throw when nothing listens on the port', () => {
    expect(reapPort(59997)).toBe(0);   // arbitrary high port nothing binds in CI
  });

  it('returns 0 for falsy / invalid ports without scanning', () => {
    expect(reapPort(0)).toBe(0);
    expect(reapPort(undefined)).toBe(0);
    expect(reapPort(null)).toBe(0);
    expect(reapPort('not-a-port')).toBe(0);
  });
});
