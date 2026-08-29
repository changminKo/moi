import { expect, test } from '../fixtures/paper-system.js';

test('supports keyboard-only order validation without overflow', async ({
  page,
}, testInfo) => {
  await page.goto('/trade');
  await expect(page.locator('main')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search' }).focus();
  await page.keyboard.type('AAPL');
  await expect(
    page.getByRole('button', { name: /Apple.*\(AAPL\)/ }),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: /Apple.*\(AAPL\)/ }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByLabel('Quantity').focus();
  await page.keyboard.type('0');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Order ticket — Place order' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(
    'Quantity must be a positive whole number',
  );

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(
    overflow,
    `${testInfo.project.name} must not overflow horizontally`,
  ).toBe(false);
  await expect(page.getByText('HEALTHY')).toBeVisible();
});
