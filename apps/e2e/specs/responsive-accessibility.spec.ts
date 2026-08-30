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

  // The pill and the heading beside it must read as one line. Measured, not
  // eyeballed: a stray margin on the heading once shifted its text by half the
  // margin while the badge stayed centred, and no unit test could see it
  // because jsdom does no layout.
  const centres = await page.evaluate(() => {
    const header = document.querySelector('.quote-header');
    const heading = header?.querySelector('h2');
    const badge = header?.querySelector('.status-badge');
    if (!heading || !badge) return null;
    const centre = (element: Element) => {
      const box = element.getBoundingClientRect();
      return (box.top + box.bottom) / 2;
    };
    return { heading: centre(heading), badge: centre(badge) };
  });
  expect(
    centres,
    'the quote header must render a heading and a badge',
  ).not.toBe(null);
  expect(
    Math.abs((centres?.badge ?? 0) - (centres?.heading ?? 0)),
    `${testInfo.project.name}: badge and heading must share an optical line`,
  ).toBeLessThan(1);
});
