// Locks the beeper bridge's log path to EGPT_HOME (the profile root), NOT a
// hardcoded ~/.egpt. Two nodes on one box (prod ~/.egpt + a v2 test node
// ~/.egpt2) must never interleave writes into the SAME beeper.log.
//
// The path is computed at MODULE LOAD from EGPT_HOME (itself read once from
// process.env at ITS load), so the test sets a custom EGPT_HOME and then
// DYNAMICALLY imports both modules (static imports hoist + would init egpt-home
// with the ambient env before this runs). A regression to join(homedir(),
// '.egpt', ...) would ignore the custom EGPT_HOME and fail this assertion.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

describe('beeper log path is profile-aware', () => {
  it('_BEEPER_LOG derives from EGPT_HOME, not a hardcoded ~/.egpt', async () => {
    process.env.EGPT_HOME = join('/tmp', 'egpt-node-under-test');
    const { EGPT_HOME } = await import('../src/egpt-home.mjs');
    const { _BEEPER_LOG } = await import('../src/bridges/beeper.mjs');
    expect(EGPT_HOME).toBe(process.env.EGPT_HOME);
    expect(_BEEPER_LOG).toBe(join(EGPT_HOME, 'config', 'logs', 'beeper.log'));
  });
});
