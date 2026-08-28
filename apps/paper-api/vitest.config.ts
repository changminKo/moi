import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // The two-process handoff drill has its own gate (`pnpm test:drill`); it
    // needs an exclusive Docker/CPU budget and must not share turbo's parallel
    // test run.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.drill.integration.test.ts',
    ],
  },
});
