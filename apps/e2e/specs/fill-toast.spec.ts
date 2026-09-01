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

async function placeLimit(
  page: import('@playwright/test').Page,
  quantity: string,
  price: string,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/orders' &&
      response.request().method() === 'POST',
  );
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill(quantity);
  await page.getByLabel('Price').fill(price);
  await page
    .getByRole('button', { name: 'Order ticket — Place order' })
    .click();
  expect((await responsePromise).ok()).toBe(true);
}

const toasts = (page: import('@playwright/test').Page) =>
  page.getByRole('list', { name: 'Fill notifications' });

test('announces a partial fill on the trade screen the reader never left', async ({
  page,
  paperSystem,
}) => {
  // Two on offer against an order for three: the order half fills at once and
  // stays open for the rest.
  await paperSystem.setBook({
    market: 'KR',
    symbol: '005930',
    bids: [{ price: '69900', volume: '10' }],
    asks: [{ price: '70000', volume: '2' }],
  });
  await page.goto('/trade');
  await selectInstrument(page, '005930');
  await placeLimit(page, '3', '70000');

  // The acceptance line stays where it always was, beside the button, and now
  // says only what it can vouch for.
  await expect(page.getByRole('status')).toHaveText('Order accepted.');
  // The fill itself arrives over the stream, with no form to attach to.
  await expect(toasts(page)).toContainText(
    '005930 Buy 2 filled · 70,000 · 2/3',
  );
});

test('announces a fill that lands while the reader is on the portfolio', async ({
  page,
  paperSystem,
}) => {
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');
  await placeLimit(page, '1', '200');
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await paperSystem.waitForStream();
  await paperSystem.fill({
    orderId: await paperSystem.latestOrderId(),
    quantity: '1',
    price: '200',
  });
  await expect(toasts(page)).toContainText(
    'AAPL Buy 1 filled · 200 · order complete',
  );
});

test('never re-announces a fill the browser is only being replayed', async ({
  page,
  paperSystem,
}) => {
  // `GET /api/v1/stream` without `afterSequence` replays the outbox from zero,
  // and the first connect of every page load omits it. Without a guard, a
  // reload would toast the whole trading history over again.
  await paperSystem.setBook({
    market: 'KR',
    symbol: '005930',
    bids: [{ price: '69900', volume: '10' }],
    asks: [{ price: '70000', volume: '5' }],
  });
  await page.goto('/trade');
  await selectInstrument(page, '005930');
  await placeLimit(page, '2', '70000');
  await expect(toasts(page)).toContainText('70,000');

  await paperSystem.setBook({
    market: 'KR',
    symbol: '005930',
    bids: [{ price: '69900', volume: '10' }],
    asks: [{ price: '70500', volume: '5' }],
  });
  // `?symbol=` survives the reload and reselects the instrument, so the
  // ticket is already mounted; searching again would toggle it back off.
  await page.reload();
  await placeLimit(page, '1', '70500');

  // The new fill is proof the replay has already been delivered on this
  // connection: replay precedes every live event the socket sends. So the
  // stack holding exactly one toast is a statement about the old fill.
  await expect(toasts(page)).toContainText('70,500');
  await expect(toasts(page).getByRole('listitem')).toHaveCount(1);
  await expect(toasts(page)).not.toContainText('70,000');
});
