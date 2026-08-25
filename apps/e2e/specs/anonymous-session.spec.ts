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
  await expect(page.getByText('Destination: 700')).toBeVisible();
  await page.getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByRole('button', { name: 'Get quote' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('₩9,000,000').first()).toBeVisible();
  await expect(page.getByText('$700').first()).toBeVisible();
});
