import { defineConfig } from 'vitest/config';

/** Runs only the two-process leader handoff drill (§10), alone. */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.drill.integration.test.ts'],
    fileParallelism: false,
  },
});
