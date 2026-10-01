// vitest config — enables whole-project coverage so the report reflects
// what's tested vs. what's still untouched, not just files imported by tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 2026-07-08: a suite run polluted the LIVE ~/.egpt/config/logs/beeper.log with test
    // fixtures (the bridge's default onLog sink derives from EGPT_HOME, which is the real
    // profile when unset). This setup forces EGPT_HOME to a throwaway profile (a sibling of
    // ~/.egpt, never the live one) for the suite so no test can write into the live
    // profile. See tests/setup-egpt-home.mjs.
    setupFiles: ['./tests/setup-egpt-home.mjs'],
    // 2026-10-01 — under-load determinism (see the flake hunt). Two backstops, NOT the primary fix
    // (the real waitFor sync bugs are fixed in the tests themselves):
    //  · testTimeout/hookTimeout: the suite's own waitFor helpers budget up to 10s (beeper-bridge),
    //    several tests wait out REAL multi-second backoffs (the ear probe's 3s redial) and many boot
    //    the spine per test — but vitest's DEFAULT is 5s, so a genuinely-slow-under-load test was
    //    killed at 5s though its own wait had not expired. 20s lets it finish; a real hang still fails.
    //  · maxWorkers: this box has 16 CPUs and the suite runs ~100 real loopback HTTP servers across
    //    its files; at the default (one worker per CPU) the saturated event loop made loopback fetch()
    //    intermittently throw `fetch failed` / `bad port` (undici mislabelling a transient connect
    //    failure — the base URL is constant and most calls on the same bridge succeed). Not a product
    //    bug, the bridge fails open correctly, but the tests assume the local call lands. Capping at 8
    //    keeps the suite PARALLEL (8 files at once), cuts those failures sharply (~40% of runs at 16 →
    //    a fraction of that), and is a hair faster for less contention.
    //  · NO retry, deliberately (operator 2026-10-01): a global retry would re-run a failed test and
    //    could turn a GENUINE future flake green — a false pass, the one outcome we will not trade for.
    //    With the sync bugs fixed and maxWorkers capped, the suite is first-pass green (verified 3× at
    //    retry=0 on reve); the residual loopback transport transient, if it ever surfaces, is a false
    //    RED — re-run by hand. A false red costs a rerun; a false green hides a bug. We keep the red.
    testTimeout: 20000,
    hookTimeout: 20000,
    maxWorkers: 8,
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'egpt.mjs',
        'egpt-spine.mjs',
        'egpt-daemon.mjs',
        'src/conversations-state.mjs',
        'config/**/*.mjs',
        'src/**/*.mjs',
        'extension/src/**/*.{js,jsx}',
      ],
      exclude: [
        'tests/**',
        'coverage/**',
        'extension/build.mjs',
        'extension/dist/**',
        'extension/dist-firefox/**',
        'extension/node_modules/**',
        'tools/bus.html',
        '**/*.test.mjs',
      ],
      reporter: ['text', 'html'],
    },
  },
});
