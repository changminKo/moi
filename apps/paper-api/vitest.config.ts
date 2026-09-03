import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Integration files start their PostgreSQL/Redis containers in beforeAll.
    // vitest's default hook budget is 10 s, which a container start meets on
    // an idle machine and misses when Docker is busy (#65: `Hook timed out in
    // 10000ms` with no assertion failing). The budget is a ceiling, not a
    // wait: a healthy start still takes the same two to four seconds.
    hookTimeout: 120_000,
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
