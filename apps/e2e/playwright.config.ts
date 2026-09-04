import { defineConfig, devices } from '@playwright/test';

const CROSS_ORIGIN_ONLY = /cross-origin\.spec\.ts$/;

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  // `cross-origin.spec.ts` asserts the page and the API sit on different
  // origins, which is false for the two single-origin projects below.
  projects: [
    {
      name: 'chromium',
      testIgnore: CROSS_ORIGIN_ONLY,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testIgnore: CROSS_ORIGIN_ONLY,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 800 },
      },
    },
    // #25: the same journeys against the second deployment shape, where
    // `apps/web/server.mjs` serves the bundle on its own origin and the
    // injected `/runtime-config.js` sends the browser to the API on another
    // one. Nothing proxies `/api` here, so the session bootstrap, the CSRF
    // `Origin` check, the credentialed fetches and the WebSocket upgrade are
    // all genuinely cross-origin — the paths the single-origin stack and the
    // vite dev proxy cannot exercise. Two specs rather than the whole suite:
    // they cover session bootstrap, order placement, streamed fills and the
    // in-page snapshot read, which is every one of those paths, and the suite
    // runs serially so a third copy of the journeys buys little.
    {
      name: 'cross-origin-chromium',
      testMatch: /(anonymous-session|cross-origin|order-lifecycle)\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:4174',
      },
    },
  ],
  webServer: {
    command: 'tsx start-system.ts',
    url: 'http://127.0.0.1:4173/trade',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
