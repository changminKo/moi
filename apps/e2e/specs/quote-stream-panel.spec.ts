import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/paper-system.js';

/**
 * The order book and the chart, driven by a real `quote` frame over the
 * WebSocket.
 *
 * Production served a blank panel on `/trade?symbol=AAPL` with the US market
 * open: `pageerror: [DecimalError] Invalid argument: undefined`, `root
 * children: 0`, `sparkline elements: 0`. The web type spelled a book level's
 * quantity `size` while every other layer — the wire, `OrderBookLevel`, the
 * ledger column `book_level_volume` — spells it `volume`, so `Decimal.max`
 * read `undefined` during render and took the whole tree down.
 *
 * No e2e run could have caught it: the harness handed books straight to the
 * paper engine and published no `quote` frame at all, and its fake REST quote
 * answered `bids`/`asks` in the web's `size` spelling rather than the wire's.
 * Both are fixed in `start-system.ts`, so this spec exercises the path the
 * crash lived on.
 */

async function selectInstrument(page: Page, symbol: string) {
  await page.getByRole('textbox', { name: 'Search' }).fill(symbol);
  await page
    .getByRole('button', { name: new RegExp(`\\(${symbol}\\)`) })
    .click();
}

/** Every uncaught page exception, so a render throw fails loudly. */
function collectPageErrors(page: Page): readonly Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

const askLevels = (page: Page) =>
  page.locator('[aria-label="Asks"] .book-level');
const bidLevels = (page: Page) =>
  page.locator('[aria-label="Bids"] .book-level');

test('renders streamed order-book depth without unmounting the app', async ({
  page,
  paperSystem,
}) => {
  const errors = collectPageErrors(page);
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');
  await paperSystem.waitForStream();

  // Re-seeding on each poll removes the race between the socket finishing its
  // `quoteSymbols` subscription and the frame being published.
  await expect
    .poll(
      async () => {
        await paperSystem.setBook({
          market: 'US',
          symbol: 'AAPL',
          bids: [{ price: '316.44', volume: '80' }],
          asks: [{ price: '316.65', volume: '40' }],
        });
        return askLevels(page).first().textContent();
      },
      { timeout: 20_000 },
    )
    .toContain('316.65');

  await expect(askLevels(page).first()).toContainText('40');
  await expect(bidLevels(page).first()).toContainText('316.44');
  await expect(bidLevels(page).first()).toContainText('80');

  // The bar for the shallower side is scaled against the deeper one, so a
  // real width proves the depth arithmetic ran on a parsed volume.
  const askBar = askLevels(page).first().locator('.depth-bar');
  await expect(askBar).toHaveAttribute('style', /width:\s*50%/);

  // The panel, the ticket and the book are all still mounted.
  await expect(page.getByRole('region', { name: /US:AAPL/ })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Order book depth' }),
  ).toBeVisible();
  expect(errors.map((error) => error.message)).toEqual([]);
});

test('draws the price chart once the stream has pushed a second price', async ({
  page,
  paperSystem,
}) => {
  const errors = collectPageErrors(page);
  await page.goto('/trade');
  await selectInstrument(page, 'AAPL');

  // The REST snapshot is the first tick, so the chart is still collecting.
  await expect(page.getByText('Collecting chart data…')).toBeVisible();
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
        return page.locator('.quote-sparkline polyline').count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const points = await page
    .locator('.quote-sparkline polyline')
    .getAttribute('points');
  expect(points?.split(' ').length ?? 0).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Collecting chart data…')).toBeHidden();
  expect(errors.map((error) => error.message)).toEqual([]);
});

/*
 * A third case — a level the wire spells `size`, the spelling that crashed
 * production — is deliberately NOT an e2e test: it is unreachable through
 * this harness. `/book` hands the book to the paper engine, and
 * `assertBook` in `@moi/trading-core` refuses a level whose volume is not a
 * decimal, so the control request fails before any frame is published. The
 * server-side validation is sound; the gap was only ever in the browser, and
 * a frame that bad is injected directly at the boundary instead — see
 * `lib/quote-frame.test.ts` and the malformed-payload cases in
 * `features/market/quote-stream.test.tsx`.
 */
