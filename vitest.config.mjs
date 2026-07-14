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
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'egpt.mjs',
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
