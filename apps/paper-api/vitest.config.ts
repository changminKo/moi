import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Every integration file starts its own PostgreSQL/Redis containers. On a
    // shared CI runner running them in parallel starves the containers and
    // drops connections mid-test, so CI runs files one at a time.
    fileParallelism: process.env.CI === undefined,
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
