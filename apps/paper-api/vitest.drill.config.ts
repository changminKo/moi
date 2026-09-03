import { defineConfig } from 'vitest/config';

/** Runs only the two-process leader handoff drill (§10), alone. */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.drill.integration.test.ts'],
    fileParallelism: false,
    // The drill's afterAll writes the evidence file and stops two processes
    // and two containers; a container stop meets vitest's default 10 s hook
    // budget on an idle machine and misses it when Docker is busy (#65).
    // A ceiling, not a wait.
    hookTimeout: 120_000,
  },
});
