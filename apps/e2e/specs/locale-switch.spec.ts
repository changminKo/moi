import { expect, test } from '../fixtures/paper-system.js';

// The shared fixture seeds `moi.locale=en` for every context; this spec
// removes the seed to observe the real product default.
test('defaults to Korean, switches to English, and the choice survives a reload', async ({
  page,
}) => {
  await page.goto('/trade');
  await page.evaluate(() => window.localStorage.removeItem('moi.locale'));
  await page.reload();

  // Korean default
  await expect(page.getByRole('link', { name: '거래' })).toBeVisible();
  await expect(page.getByRole('link', { name: '포트폴리오' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

  // Switch to English
  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('link', { name: 'Trade' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Portfolio' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Persisted across a reload
  await page.reload();
  await expect(page.getByRole('link', { name: 'Trade' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // And back to Korean through the switch
  await page.getByRole('button', { name: '한국어' }).click();
  await expect(page.getByRole('link', { name: '거래' })).toBeVisible();
});
