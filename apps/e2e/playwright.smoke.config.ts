import { defineConfig, devices } from '@playwright/test';
import { requireSmokeWebOrigin } from './smoke/smoke-contract.js';

/**
 * The post-deploy browser smoke (#25). Operator-run against a **deployed**
 * origin — never CI, which may not reach production and must never drive it.
 *
 *   SMOKE_WEB_ORIGIN=https://moi.example pnpm smoke:prod
 *
 * Kept in its own config so nothing picks it up by accident: the CI e2e run
 * (`playwright.config.ts`) has `testDir: './specs'` and never sees `smoke/`,
 * and this config has no `webServer` — there is nothing local to start.
 * Reading the origin here fails before a browser is launched when it is unset.
 */
const baseURL = requireSmokeWebOrigin(process.env.SMOKE_WEB_ORIGIN);

export default defineConfig({
  testDir: './smoke',
  testMatch: /.*\.smoke\.ts$/u,
  fullyParallel: false,
  // A production run is a single observation: a retry would paper over the
  // intermittent failure that is worth knowing about.
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'production-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
