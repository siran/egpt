// Locks the OFF-boot-graph tool modules' profile paths to EGPT_HOME (the
// profile root), NOT a hardcoded ~/.egpt. These modules run in brain
// subprocesses / standalone CLIs that INHERIT the spine's env, so a test node
// (~/.egpt2) must derive its paths from EGPT_HOME — a regression to
// join(homedir(), '.egpt', ...) would silently read/write the production
// profile.
//
// Same shape as beeper-log-path.test.mjs: each path constant is computed at
// MODULE LOAD from EGPT_HOME (read once from process.env at ITS load), so the
// test sets a custom EGPT_HOME, resets the module registry, then DYNAMICALLY
// imports egpt-home + each module (static imports would hoist + init egpt-home
// with the ambient env before this runs).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'node:path';

const CUSTOM_HOME = join('/tmp', 'egpt-tool-paths-under-test');
const origEnv = process.env.EGPT_HOME;

describe('OFF-boot-graph tool paths are profile-aware', () => {
  beforeAll(() => {
    process.env.EGPT_HOME = CUSTOM_HOME;
    vi.resetModules();
  });
  afterAll(() => {
    if (origEnv === undefined) delete process.env.EGPT_HOME;
    else process.env.EGPT_HOME = origEnv;
    vi.resetModules();
  });

  it('outbox-send OUTBOX_DIR derives from EGPT_HOME', async () => {
    const { EGPT_HOME } = await import('../src/egpt-home.mjs');
    const { OUTBOX_DIR } = await import('../src/tools/outbox-send.mjs');
    expect(EGPT_HOME).toBe(CUSTOM_HOME);
    expect(OUTBOX_DIR).toBe(join(CUSTOM_HOME, 'state', 'outbox'));
  });

  it('bus DEFAULT_KEY_PATH derives from EGPT_HOME', async () => {
    const { DEFAULT_KEY_PATH } = await import('../src/tools/bus.mjs');
    expect(DEFAULT_KEY_PATH).toBe(join(CUSTOM_HOME, 'config', 'bus.key'));
  });

  it('theme USER_THEMES_DIR derives from EGPT_HOME', async () => {
    const { USER_THEMES_DIR } = await import('../src/tools/theme.mjs');
    expect(USER_THEMES_DIR).toBe(join(CUSTOM_HOME, 'themes'));
  });

  it('browser-tools re-exports the same EGPT_HOME', async () => {
    const { EGPT_HOME } = await import('../src/tools/browser-tools.mjs');
    expect(EGPT_HOME).toBe(CUSTOM_HOME);
  });
});
