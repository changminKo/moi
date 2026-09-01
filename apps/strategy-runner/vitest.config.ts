import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every state-store suite writes to its own temporary directory, so files
    // may run in parallel. The round-trip and restart-idempotency suites are
    // container-bound and live in `apps/paper-api`, which serialises them.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
