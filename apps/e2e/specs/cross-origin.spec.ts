import { expect, test } from '../fixtures/paper-system.js';
import { RETRY_SESSION } from '../ui-labels.js';

/**
 * Runs only under the `cross-origin-chromium` project, where the page is
 * served by `apps/web/server.mjs` on its own origin and the API listens on
 * another (playwright.config.ts). It is the regression test for #25: a release
 * whose bundle ignored the injected runtime config and called its own origin,
 * which every API-side deploy check passed while the screen showed nothing but
 * "Retry session".
 *
 * The other specs in this project prove the journeys still work across the
 * boundary. This one proves the boundary is really there — without it a
 * misconfigured harness could serve everything same-origin and the project
 * would stay green while testing nothing new.
 */
function injectedApiOrigin(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __MOI_RUNTIME_CONFIG__?: { apiOrigin?: string };
        }
      ).__MOI_RUNTIME_CONFIG__?.apiOrigin,
  );
}

test('calls the injected API origin rather than the origin it was served from', async ({
  page,
  paperSystem,
}) => {
  const apiOrigins = new Set<string>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/')) apiOrigins.add(url.origin);
  });
  const socketOrigins = new Set<string>();
  page.on('websocket', (socket) => {
    socketOrigins.add(new URL(socket.url()).origin);
  });

  await page.goto('/trade');
  // The wallet is the session bootstrap having succeeded across the boundary:
  // a cross-origin POST that fails CORS, the CSRF `Origin` check or the cookie
  // leaves the retry button instead.
  await expect(page.getByText('₩10,000,000').first()).toBeVisible();
  // Spelled in both languages: this is an absence, and the wrong spelling
  // would pass whatever the screen actually said (`ui-labels.ts`).
  await expect(page.getByRole('button', { name: RETRY_SESSION })).toHaveCount(
    0,
  );

  const pageOrigin = new URL(page.url()).origin;
  const apiOrigin = await injectedApiOrigin(page);
  expect(
    apiOrigin,
    'the static server must inject an API origin into /runtime-config.js',
  ).toBeTruthy();
  expect(
    apiOrigin,
    'the project is pointless unless the API really is somewhere else',
  ).not.toBe(pageOrigin);

  // Every API call went there, and none to the page's own origin — which is
  // the static server, and answers 405 to a POST exactly as it did in #25.
  expect([...apiOrigins]).toEqual([apiOrigin]);

  // The stream upgrade crosses the same boundary and is checked against the
  // API's own `publicOrigin`, so it is a second, independent origin check.
  // Waiting on the harness's own count of live stream sessions makes the
  // socket's arrival a fact rather than a race against the default 5 s poll.
  await paperSystem.waitForStream();
  await expect
    .poll(() => [...socketOrigins], {
      message: 'the quote stream must open against the injected API origin',
      timeout: 15_000,
    })
    .toEqual([String(apiOrigin).replace(/^http/u, 'ws')]);
});
