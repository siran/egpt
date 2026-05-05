// vitest config — enables whole-project coverage so the report reflects
// what's tested vs. what's still untouched, not just files imported by tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        '*.mjs',
        'brains/**/*.mjs',
        'bridges/**/*.mjs',
        'tools/**/*.mjs',
        'extension/src/**/*.{js,jsx}',
      ],
      exclude: [
        'tests/**',
        'extension/build.mjs',
        'extension/dist/**',
        'extension/node_modules/**',
        'tools/bus.html',
        '**/*.test.mjs',
      ],
      reporter: ['text', 'html'],
    },
  },
});
