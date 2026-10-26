// Guards the class of bug behind the 2026-07-08 incident: a `vitest` run POLLUTED the
// LIVE profile log at ~/.egpt/config/logs/beeper.log with test-fixture lines (chat-1,
// Bea, "fake transcript", pic.png) and corrupted a live diagnosis. ROOT CAUSE:
// startBeeperBridge's internal onLog ALWAYS appendFileSync's to _BEEPER_LOG =
// join(EGPT_HOME, 'config', 'logs', 'beeper.log') (src/bridges/beeper.mjs), and EGPT_HOME
// resolves to the REAL ~/.egpt when the env var is UNSET — which it was for the whole
// suite. This file is the reproduce-first proof + the structural tripwire.
//
// Path-only, never a WRITE: importing egpt-home / the bridge computes the sink PATH but
// does not touch disk, so the REPRODUCE case asserts the leak TARGET without polluting
// the real profile. Same mechanism as beeper-log-path / tool-profile-paths: EGPT_HOME is
// frozen at module load, so we flip process.env then vi.resetModules() + dynamic import.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

// The suite's ambient EGPT_HOME, captured BEFORE any case below mutates it — this is what
// tests/setup-egpt-home.mjs forced it to for the run.
const SUITE_HOME = process.env.EGPT_HOME;
const REAL_PROFILE = join(homedir(), '.egpt');

describe('no test derives a logging path into the LIVE ~/.egpt profile', () => {
  const orig = process.env.EGPT_HOME;
  afterAll(() => {
    if (orig === undefined) delete process.env.EGPT_HOME;
    else process.env.EGPT_HOME = orig;
    vi.resetModules();
  });

  // REPRODUCE: with EGPT_HOME unset (the exact condition the suite ran under on
  // 2026-07-08), egpt-home + the bridge derive the default sink INTO the real profile —
  // the live log the run polluted. Asserts the PATH only; no write happens.
  it('REPRODUCE: with EGPT_HOME unset, _BEEPER_LOG resolves inside the real ~/.egpt', async () => {
    delete process.env.EGPT_HOME;
    vi.resetModules();
    const { EGPT_HOME } = await import('../src/egpt-home.mjs');
    const { _BEEPER_LOG } = await import('../src/bridges/beeper.mjs');
    expect(EGPT_HOME).toBe(REAL_PROFILE);
    expect(_BEEPER_LOG).toBe(join(REAL_PROFILE, 'config', 'logs', 'beeper.log'));   // the live sink the suite polluted
  });

  // NEUTRALIZED: an isolated EGPT_HOME redirects the SAME default sink out of the live
  // profile — the fix's altitude (isolate the profile, not patch every call site).
  it('NEUTRALIZED: an isolated EGPT_HOME redirects the default sink out of the live profile', async () => {
    const temp = join('/tmp', 'egpt-leak-neutralized');
    process.env.EGPT_HOME = temp;
    vi.resetModules();
    const { _BEEPER_LOG } = await import('../src/bridges/beeper.mjs');
    expect(_BEEPER_LOG).toBe(join(temp, 'config', 'logs', 'beeper.log'));
    expect(_BEEPER_LOG.startsWith(REAL_PROFILE)).toBe(false);
  });

  // TRIPWIRE: the running suite must have EGPT_HOME forced to a throwaway temp
  // (tests/setup-egpt-home.mjs). If that setup is ever dropped, EGPT_HOME goes unset,
  // the default sink points back at the live profile, and this goes RED before any
  // bridge test can pollute ~/.egpt again.
  it('TRIPWIRE: the running suite forces EGPT_HOME to a NON-live temp profile', () => {
    expect(SUITE_HOME, 'tests/setup-egpt-home.mjs must set EGPT_HOME for the whole suite').toBeTruthy();
    expect(SUITE_HOME).not.toBe(REAL_PROFILE);
  });
});

// 2026-10-24: a being's shell INHERITS the spine's EGPT_HOME (the live profile), and the
// ||= in tests/setup-egpt-home.mjs kept it. The setup file must now REFUSE an inherited
// EGPT_HOME that is a real profile (has config/config.yaml). Run directly by node in a
// child whose env is a scrubbed copy of ours (no EGPT_* leaks in from this process).
describe('tests/setup-egpt-home.mjs refuses an inherited LIVE profile', () => {
  const SETUP = join(import.meta.dirname, 'setup-egpt-home.mjs');
  const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EGPT_')));
  const run = (env) => spawnSync(process.execPath, [SETUP], { env, encoding: 'utf8' });
  const tmp = mkdtempSync(join(tmpdir(), 'egpt-setup-home-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('EGPT_HOME is a real profile (config/config.yaml): non-zero exit, refusal names the path', () => {
    const live = join(tmp, 'live');
    mkdirSync(join(live, 'config'), { recursive: true });
    writeFileSync(join(live, 'config', 'config.yaml'), '');
    const r = run({ ...scrubbed, EGPT_HOME: live });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('refusing to run the test suite against a LIVE eGPT profile');
    expect(r.stderr).toContain(`EGPT_HOME=${live}`);
    expect(r.stderr).toContain('env -u EGPT_HOME');
  });

  it('EGPT_HOME set but no config/config.yaml: exit 0', () => {
    const r = run({ ...scrubbed, EGPT_HOME: join(tmp, 'empty') });
    expect(r.status, r.stderr).toBe(0);
  });

  it('EGPT_HOME unset: exit 0', () => {
    const r = run(scrubbed);
    expect(r.status, r.stderr).toBe(0);
  });
});
