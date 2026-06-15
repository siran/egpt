import { describe, it, expect } from 'vitest';
import { findUnreachableSiblingCwds, configWarnings } from '../src/config-validate.mjs';

// The DOLLY bug (operator 2026-06-14): a being's cwd mangled in YAML to a
// non-existent path → cryptic per-turn `spawn <claude> ENOENT`. These lock in a
// boot-time check that names the problem.
describe('config-validate — sibling cwd wiring', () => {
  // Pretend only these real-looking paths exist.
  const exists = (p) => ['C:/Users/an/src/egpt', 'C:\\Users\\an\\src\\egpt', 'C:/ok'].includes(p);

  it('flags the mangled (backslashes eaten) cwd that caused the ENOENT', () => {
    const cfg = { siblings: { don: { cwd: 'C:Usersansrcegpt' } } };   // the actual mangled value
    const bad = findUnreachableSiblingCwds(cfg, exists);
    expect(bad).toEqual([{ name: 'don', cwd: 'C:Usersansrcegpt' }]);
  });

  it('accepts a forward-slash cwd and a literal-backslash cwd', () => {
    const cfg = { siblings: {
      don: { cwd: 'C:/Users/an/src/egpt' },
      wren: { cwd: 'C:\\Users\\an\\src\\egpt' },
    } };
    expect(findUnreachableSiblingCwds(cfg, exists)).toEqual([]);
  });

  it('normalizes an msys-form cwd before checking (no false flag)', () => {
    const cfg = { siblings: { don: { cwd: '/c/Users/an/src/egpt' } } };   // → C:/Users/an/src/egpt
    expect(findUnreachableSiblingCwds(cfg, exists)).toEqual([]);
  });

  it('ignores siblings with no cwd, and tolerates a missing siblings block', () => {
    expect(findUnreachableSiblingCwds({ siblings: { l: { type: 'llama' } } }, exists)).toEqual([]);
    expect(findUnreachableSiblingCwds({}, exists)).toEqual([]);
    expect(findUnreachableSiblingCwds(null, exists)).toEqual([]);
  });

  it('configWarnings names the cause + the fix', () => {
    const w = configWarnings({ siblings: { don: { cwd: 'C:Usersansrcegpt' } } }, exists);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('siblings.don.cwd');
    expect(w[0]).toContain('forward slashes');
    expect(w[0]).toContain('C:Usersansrcegpt');
  });
});
