import { expect, test } from '@playwright/test';
import {
  apiCallsToOrigin,
  type ConsoleErrorRecord,
  isIgnorableConsoleError,
  type ObservedResponse,
  readRuntimeConfigApiOrigin,
  requireSmokeWebOrigin,
} from './smoke-contract.js';

/**
 * What `deploy.sh` cannot see. Every check it makes talks to the API, and the
 * first Oracle release passed all of them while `/trade` was unusable: the
 * bundle ignored the injected runtime config, called its own origin, got a 405
 * from the static server and showed nothing but the retry button (#25).
 *
 * So this opens the deployed page in a real browser and asks the three
 * questions the API could never answer: was the runtime config served with a
 * real API origin in it, did the session bootstrap actually reach that origin,
 * and did the page stay quiet while doing it.
 *
 * The product default is Korean and a deployed host has no seeded locale, so
 * the two labels are matched in either language.
 */
const webOrigin = requireSmokeWebOrigin(process.env.SMOKE_WEB_ORIGIN);
const RETRY_SESSION = /Retry session|세션 다시 시작/u;
const WALLET_PANEL = /Wallet|지갑/u;
const MONEY = /[₩$]\s?\d[\d,]*/u;

test('the deployed trade screen bootstraps its session against the configured API origin', async ({
  page,
  request,
}) => {
  const consoleErrors: ConsoleErrorRecord[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    consoleErrors.push({
      text: message.text(),
      location: message.location().url,
    });
  });
  page.on('pageerror', (error) => {
    consoleErrors.push({ text: `pageerror: ${error.message}` });
  });
  const responses: ObservedResponse[] = [];
  page.on('response', (response) => {
    responses.push({ url: response.url(), status: response.status() });
  });

  // The file the browser learns the API origin from. Read first, so a failure
  // here names the cause rather than showing up as an unexplained blank page.
  const configResponse = await request.get(
    new URL('/runtime-config.js', webOrigin).toString(),
  );
  expect(
    configResponse.status(),
    `${webOrigin}/runtime-config.js must be served`,
  ).toBe(200);
  const apiOrigin = readRuntimeConfigApiOrigin(await configResponse.text());

  await page.goto(new URL('/trade', webOrigin).toString());

  // The retry button is exactly what a failed bootstrap leaves on the screen,
  // so the two outcomes are raced: waiting only for the wallet would report a
  // broken session as an unexplained timeout.
  const retry = page.getByRole('button', { name: RETRY_SESSION });
  const wallet = page.getByRole('region', { name: WALLET_PANEL });
  await expect
    .poll(
      async () => {
        if ((await wallet.count()) > 0) return 'wallet';
        if ((await retry.count()) > 0) return 'retry';
        return 'loading';
      },
      {
        message:
          'the session bootstrap must reach the wallet; "retry" means it failed, as it did in #25',
        timeout: 30_000,
      },
    )
    .toBe('wallet');
  await expect(retry).toHaveCount(0);
  await expect(
    wallet.getByText(MONEY).first(),
    'the wallet must render an amount, not an empty panel',
  ).toBeVisible();

  // The bundle honoured what it read: at least one API call succeeded against
  // the origin the runtime config named. Under the single-origin edge that is
  // the web origin itself; under a two-origin deployment it is not.
  await expect
    .poll(() => apiCallsToOrigin(responses, apiOrigin).length, {
      message: `the page must have called ${apiOrigin} successfully; #25 was a page that called its own origin instead`,
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const unexpected = consoleErrors.filter(
    (record) => !isIgnorableConsoleError(record),
  );
  expect(
    unexpected,
    'a healthy page logs no console error but a missing favicon',
  ).toEqual([]);
});
