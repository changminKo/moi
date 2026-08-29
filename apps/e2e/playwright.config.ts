import { defineConfig, devices } from '@playwright/test';

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 800 },
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
