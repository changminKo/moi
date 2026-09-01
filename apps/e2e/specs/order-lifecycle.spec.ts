import { expect, test } from '../fixtures/paper-system.js';

async function selectInstrument(
  page: import('@playwright/test').Page,
  symbol: string,
) {
  await page.getByRole('textbox', { name: 'Search' }).fill(symbol);
  await page
    .getByRole('button', { name: new RegExp(`\\(${symbol}\\)`) })
    .click();
}

async function submitOrder(page: import('@playwright/test').Page) {
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

test('reconciles a KR limit order after partial and complete fills', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.setBook({
    market: 'KR',
    symbol: '005930',
    bids: [{ price: '69900', volume: '10' }],
    asks: [{ price: '70000', volume: '2' }],
  });
  await page.goto('/trade');
  await selectInstrument(page, '005930');
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill('3');
  await page.getByLabel('Price').fill('70000');
  await submitOrder(page);
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await expect(page.getByText('PARTIALLY_FILLED')).toBeVisible();
  await expect(page.getByText('Filled 2 / Remaining 1')).toBeVisible();

  const orderId = await paperSystem.latestOrderId();
  await paperSystem.fill({ orderId, quantity: '1', price: '70000' });
  await page.reload();
  await expect(page.getByText('005930 FILLED')).toBeVisible();
  await expect(page.getByRole('row', { name: /005930 3 0 3/ })).toBeVisible();
});

test('deduplicates a duplicate US fill delivery', async ({
  page,
  paperSystem,
}) => {
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill('1');
  await page.getByLabel('Price').fill('200');
  await submitOrder(page);
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await paperSystem.waitForStream();
  const orderId = await paperSystem.latestOrderId();
  await paperSystem.fill({
    orderId,
    quantity: '1',
    price: '200',
    duplicate: true,
  });
  await expect(page.getByText('AAPL 1 @ 200')).toHaveCount(1);
});

test('cancels the OCO sibling and releases its reservation', async ({
  page,
  paperSystem,
}) => {
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('Price').fill('200');
  await submitOrder(page);
  await paperSystem.fill({
    orderId: await paperSystem.latestOrderId(),
    quantity: '2',
    price: '200',
  });
  await page.getByLabel('Sell').check();
  await page.getByLabel('Type').selectOption('OCO');
  await page.getByLabel('Quantity').fill('2');
  await page.getByRole('textbox', { name: 'Price', exact: true }).fill('210');
  await page.getByLabel('Stop price').fill('190');
  await submitOrder(page);
  const orderId = await paperSystem.latestOrderId();
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await expect(page.getByRole('row', { name: /AAPL 0 2 2/ })).toBeVisible();
  const reservation = await page.evaluate(async () => {
    const response = await fetch('/api/v1/portfolio');
    const snapshot = (await response.json()) as {
      reservations: readonly Record<string, unknown>[];
    };
    return snapshot.reservations[0];
  });
  expect(reservation).toMatchObject({
    kind: 'POSITION',
    market: 'US',
    symbol: 'AAPL',
    amount: '2',
    released: false,
  });
  await paperSystem.triggerOco({ orderId, price: '210' });
  await expect(page.getByText('AAPL FILLED')).toHaveCount(2);
  await expect(page.getByText('AAPL CANCELLED')).toBeVisible();
  // The ledger keeps the sold-out row (quantity 0, the average cost it was
  // held at); the screen stops calling it a holding and reports it as closed,
  // so "held today, now closed" still reads differently from "never held".
  await expect(
    page
      .getByRole('region', { name: 'Positions', exact: true })
      .getByText('AAPL'),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Closed positions' })
      .getByRole('row', { name: /AAPL/ }),
  ).toBeVisible();
  const liveReservations = await page.evaluate(async () => {
    const response = await fetch('/api/v1/portfolio');
    const snapshot = (await response.json()) as {
      reservations: readonly Record<string, unknown>[];
    };
    return snapshot.reservations;
  });
  expect(liveReservations).toEqual([]);
});
