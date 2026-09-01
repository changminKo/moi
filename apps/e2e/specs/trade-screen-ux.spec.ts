import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/paper-system.js';

/**
 * The four reported gaps on the trade screen, each exercised through the
 * browser: a price with no currency on it, a chart window nobody could
 * change, an order ticket that priced nothing and said nothing after a
 * submit, and a conversion that left its own form standing while the wallet
 * beside it went stale.
 *
 * All four are rendering and interaction behaviour, which is exactly what the
 * unit suites cannot see — the crash this week shipped past them.
 */

async function selectInstrument(page: Page, symbol: string) {
  await page.getByRole('textbox', { name: 'Search' }).fill(symbol);
  await page
    .getByRole('button', { name: new RegExp(`\\(${symbol}\\)`) })
    .click();
}

/** The first <dd> of a wallet card is its available balance. */
const availableBalance = (page: Page, currency: 'KRW' | 'USD') =>
  page
    .locator('.wallet-grid article')
    .filter({ has: page.getByRole('heading', { name: currency, exact: true }) })
    .locator('dd')
    .first();

test('prices the quote panel in the instrument currency', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.setBook({
    market: 'US',
    symbol: 'AAPL',
    bids: [{ price: '199', volume: '10' }],
    asks: [{ price: '200', volume: '10' }],
  });
  await paperSystem.setBook({
    market: 'KR',
    symbol: '005930',
    bids: [{ price: '69900', volume: '10' }],
    asks: [{ price: '70000', volume: '10' }],
  });
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');

  // The harness quotes the best ask, 200, and states USD on the book.
  await expect(page.locator('.quote-price')).toHaveText('$200');
  await expect(
    page.getByRole('heading', { name: 'Order book depth · USD' }),
  ).toBeVisible();
  // The book's own rows stay bare — the heading carries the currency once.
  await expect(page.locator('.book-side-ask .book-price').first()).toHaveText(
    '200',
  );

  await selectInstrument(page, '005930');
  await expect(page.locator('.quote-price')).toHaveText('₩70,000');
  await expect(
    page.getByRole('heading', { name: 'Order book depth · KRW' }),
  ).toBeVisible();
});

test('remembers the chart window the reader picks', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.reset();
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');

  // One REST snapshot is one tick, so the chart is still collecting — and the
  // control has to be reachable in exactly that state, since narrowing the
  // window is what a reader with little history would want to do.
  await expect(page.getByText('Collecting chart data…')).toBeVisible();
  const group = page.getByRole('group', { name: 'Chart window' });
  await expect(group).toBeVisible();
  await expect(page.getByRole('radio', { name: '120 ticks' })).toBeChecked();

  await page.getByRole('radio', { name: '30 ticks' }).click();
  await expect(page.getByRole('radio', { name: '30 ticks' })).toBeChecked();

  await page.reload();
  await expect(page.getByRole('radio', { name: '30 ticks' })).toBeChecked();
});

test('says how much of the chosen window it has actually collected', async ({
  page,
  paperSystem,
}) => {
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');
  await paperSystem.waitForStream();

  await expect
    .poll(
      async () => {
        await paperSystem.setBook({
          market: 'US',
          symbol: 'AAPL',
          bids: [{ price: '316.44', volume: '80' }],
          asks: [{ price: '316.65', volume: '40' }],
        });
        // Read without blocking. The summary only exists from the second tick
        // on, and `waitForStream` only promises *a* stream — the shell opens
        // one for account events at page load, so the quote subscription can
        // still be a moment behind and swallow the first book. Blocking here
        // would spend the whole budget on one push; returning empty lets the
        // poll do what it was written to do and push another.
        return (
          (await page
            .locator('.sparkline-summary')
            .textContent({ timeout: 1_000 })
            .catch(() => null)) ?? ''
        );
      },
      { timeout: 20_000 },
    )
    .toMatch(/of 120 ticks so far/);
});

test('estimates what the order would cost as the quantity is typed', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.setBook({
    market: 'US',
    symbol: 'AAPL',
    bids: [{ price: '100', volume: '10' }],
    asks: [{ price: '110', volume: '10' }],
  });
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');

  const estimate = page.locator('.order-estimate');
  await expect(estimate).toHaveText('');

  // A MARKET BUY is estimated at the best ask, 110 — the price the server
  // sizes its cash reservation from — not at the bid.
  await page.getByLabel('Quantity').fill('3');
  await expect(estimate).toHaveText('Estimated ≈ $330');

  // A SELL is the symmetric client-side choice: a seller is paid the bid.
  await page.getByRole('radio', { name: 'Sell' }).click();
  await expect(estimate).toHaveText('Estimated ≈ $300');
  await page.getByRole('radio', { name: 'Buy' }).click();

  // A LIMIT order is estimated at the reader's own price instead.
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Price').fill('150');
  await expect(estimate).toHaveText('Estimated ≈ $450');
});

test('reports an accepted order and empties the quantity', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.reset();
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('Price').fill('150');
  await page
    .getByRole('button', { name: 'Order ticket — Place order' })
    .click();

  // The endpoint answers OPEN with nothing filled, so the wording says
  // accepted rather than done. What happens next is the fill toast's job.
  await expect(page.getByRole('status')).toHaveText('Order accepted.');
  await expect(page.getByLabel('Quantity')).toHaveValue('');
  await expect(page.getByLabel('Price')).toHaveValue('150');
});

test('turns a rejected order into a sentence and keeps what was typed', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.reset();
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');
  // USD is funded at 100,000, so a 150,000 limit order cannot be reserved:
  // the ledger refuses it with INSUFFICIENT_AVAILABLE_CASH.
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill('1000');
  await page.getByLabel('Price').fill('150');
  await page
    .getByRole('button', { name: 'Order ticket — Place order' })
    .click();

  await expect(page.getByRole('alert')).toHaveText(
    'Not enough available cash for this order',
  );
  await expect(page.getByLabel('Quantity')).toHaveValue('1,000');
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('resets the conversion form and refreshes the wallet beside it', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.reset();
  await page.goto('/trade');
  await expect(availableBalance(page, 'KRW')).toHaveText('₩10,000,000');

  await page.getByLabel('Amount').fill('1000');
  await page.getByRole('button', { name: 'Get quote' }).click();
  await page.getByRole('button', { name: 'Convert' }).click();

  // The form that produced the conversion is gone, amount and all …
  await expect(page.getByRole('button', { name: 'Convert' })).toHaveCount(0);
  await expect(page.getByLabel('Amount')).toHaveValue('');
  // … and the wallet the conversion moved is re-read, not left stale.
  await expect(availableBalance(page, 'KRW')).toHaveText('₩9,999,000');
  await expect(availableBalance(page, 'USD')).toHaveText('$100,000.7');
});

test('states the sell-side holding, and what an open order has reserved', async ({
  page,
  paperSystem,
}) => {
  await paperSystem.setBook({
    market: 'KR',
    symbol: '005930',
    bids: [{ price: '69900', volume: '10' }],
    asks: [{ price: '70000', volume: '5' }],
  });
  await page.goto('/trade');
  await selectInstrument(page, '005930');

  // Nothing held yet, and the ticket says so rather than leaving the reader
  // to guess at an empty quantity field.
  await page.getByLabel('Sell').check();
  await expect(page.locator('.order-holding')).toHaveText('No holding');

  await page.getByLabel('Buy').check();
  await expect(page.locator('.order-holding')).toHaveCount(0);
  await page.getByLabel('Type').selectOption('LIMIT');
  await page.getByLabel('Quantity').fill('3');
  await page.getByLabel('Price').fill('70000');
  await page
    .getByRole('button', { name: 'Order ticket — Place order' })
    .click();
  await expect(page.locator('.toast-region')).toContainText('3 filled');

  await page.getByLabel('Sell').check();
  await expect(page.locator('.order-holding')).toHaveText(
    '3 available to sell',
  );

  // A resting sell order holds part of the position, and the line says which
  // part — otherwise the ticket refusing the full quantity has no explanation.
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('Price').fill('80000');
  await page
    .getByRole('button', { name: 'Order ticket — Place order' })
    .click();
  await expect(page.locator('.order-holding')).toHaveText(
    '1 available to sell · 2 reserved',
  );
});
