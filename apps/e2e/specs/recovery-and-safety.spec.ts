import { expect, test } from '../fixtures/paper-system.js';

async function mutationToken(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/v1/sessions/anonymous', {
      method: 'POST',
      credentials: 'include',
    });
    const value = (await response.json()) as { csrfToken: string };
    return value.csrfToken;
  });
}

async function bypassOrderStatus(
  page: import('@playwright/test').Page,
  csrfToken: string,
) {
  return page.evaluate(async (csrf) => {
    const response = await fetch('/api/v1/orders', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({
        market: 'US',
        symbol: 'AAPL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '190',
      }),
    });
    return response.status;
  }, csrfToken);
}

async function placeOpenOrder(page: import('@playwright/test').Page) {
  await page.goto('/trade');
  await page.getByRole('textbox', { name: 'Search' }).fill('AAPL');
  await page.getByRole('button', { name: /Apple.*\(AAPL\)/ }).click();
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill('1');
  await page.getByRole('textbox', { name: 'Price', exact: true }).fill('190');
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/orders' &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Order ticket — Place order' })
    .click();
  expect((await responsePromise).ok()).toBe(true);
}

test('rejects placement while degraded, permits cancel, then labels a recovery fill', async ({
  page,
  paperSystem,
}) => {
  await placeOpenOrder(page);
  const orderId = await paperSystem.latestOrderId();
  await paperSystem.setMode('DEGRADED');
  await page.reload();
  await expect(page.getByText('Market data delayed').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Order ticket — Place order' }),
  ).toBeDisabled();
  expect(await bypassOrderStatus(page, await mutationToken(page))).toBe(409);

  await page.getByRole('link', { name: '포트폴리오' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => paperSystem.orderStatus(orderId)).toBe('CANCELLED');

  await paperSystem.recover();
  await placeOpenOrder(page);
  const recoveryOrderId = await paperSystem.latestOrderId();
  await paperSystem.fill({
    orderId: recoveryOrderId,
    quantity: '1',
    price: '190',
    recoveryFill: true,
  });
  await page.getByRole('link', { name: '포트폴리오' }).click();
  await page.reload();
  await expect(page.getByText('Recovery fill')).toBeVisible();
});

test('emergency latch enforces cancel-only while preserving cancellation', async ({
  page,
  paperSystem,
}) => {
  await placeOpenOrder(page);
  const orderId = await paperSystem.latestOrderId();
  await paperSystem.setMode('CANCEL_ONLY');
  await page.reload();
  await expect(
    page.getByText('Safety mode: cancellations only').first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Order ticket — Place order' }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Get quote' })).toBeDisabled();
  const csrfToken = await mutationToken(page);
  expect(await bypassOrderStatus(page, csrfToken)).toBe(409);
  const fxStatus = await page.evaluate(async (csrf) => {
    const response = await fetch('/api/v1/fx/quotes', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ from: 'KRW', to: 'USD', amount: '1000' }),
    });
    return response.status;
  }, csrfToken);
  expect(fxStatus).toBe(409);
  await page.getByRole('link', { name: '포트폴리오' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => paperSystem.orderStatus(orderId)).toBe('CANCELLED');
});

test('requests exactly one REST snapshot for an account-sequence gap', async ({
  page,
  paperSystem,
}) => {
  await page.goto('/portfolio');
  await paperSystem.waitForStream();
  let snapshots = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/portfolio') snapshots += 1;
  });
  await paperSystem.emitSequenceGap();
  await expect.poll(() => snapshots).toBe(1);
  await expect.poll(() => paperSystem.snapshotRequests()).toBeGreaterThan(1);
});
