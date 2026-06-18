// vitest config — enables whole-project coverage so the report reflects
// what's tested vs. what's still untouched, not just files imported by tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'egpt.mjs',
        'egpt-daemon.mjs',
        'egpt-spine.mjs',
        'dispatch.mjs',
        'conversations-state.mjs',
        'config/**/*.mjs',
        'slash/**/*.mjs',
        'src/**/*.mjs',
        'extension/src/**/*.{js,jsx}',
      ],
      exclude: [
        'tests/**',
        'attic/**',
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
