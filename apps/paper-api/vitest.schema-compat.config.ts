import { defineConfig } from 'vitest/config';

/**
 * The previous-release schema-compatibility gate (#46). It builds nothing and
 * runs nothing from `src/`: the ordinary `pnpm test` (`vitest run --dir src`)
 * never sees this directory, and CI invokes this config only from the
 * dedicated `schema-compatibility` job after the previous image is built.
 */
const DOCKER_BUDGET_MS = 300_000;

export default defineConfig({
  test: {
    // The Docker-bound scenarios and the strategy's own unit test; nothing
    // under src/.
    include: ['schema-compat/**/*.test.ts'],
    fileParallelism: false,
    // Each scenario starts a network, PostgreSQL, Redis and the previous image
    // in its own test body, so the budget applies to tests and hooks alike.
    hookTimeout: DOCKER_BUDGET_MS,
    testTimeout: DOCKER_BUDGET_MS,
  },
});
