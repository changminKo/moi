import { expect, test } from '../fixtures/paper-system.js';

test('creates one anonymous wallet and reloads it', async ({ page }) => {
  await page.goto('/trade');
  await expect(page.getByText('₩10,000,000').first()).toBeVisible();
  await expect(page.getByText('$0').first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('₩10,000,000').first()).toBeVisible();
});

test('converts KRW to USD and reloads the authoritative totals', async ({
  page,
}) => {
  await page.goto('/trade');
  await page.getByLabel('Amount').fill('1000000');
  await page.getByRole('button', { name: 'Get quote' }).click();
  await expect(
    page.getByText('You receive: $700', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByRole('button', { name: 'Get quote' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('₩9,000,000').first()).toBeVisible();
  // The harness funds each session with $100,000 (see start-system) so the
  // browser journeys can place US orders; the conversion adds $700 on top.
  await expect(page.getByText('$100,700').first()).toBeVisible();
});
