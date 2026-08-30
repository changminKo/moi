import { expect, test } from '../fixtures/paper-system.js';

// Every other spec runs against a context that seeds `moi.locale=en` through an
// init script, which re-runs on each navigation. To observe the real product
// default this spec opts out entirely with its own context, built straight
// from the browser so no init script is registered on it.
test('defaults to Korean, switches to English, and the choice survives a reload', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext(baseURL ? { baseURL } : {});
  try {
    const page = await context.newPage();
    await page.goto('/trade');

    // Korean is the default: <html lang> and the pressed state are the stable
    // hooks; the link names confirm the catalogue is actually applied.
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByRole('button', { name: '한국어' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByRole('link', { name: '거래', exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'EN' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'EN' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByRole('link', { name: 'Trade', exact: true }),
    ).toBeVisible();

    // The explicit choice is persisted, so a reload keeps English.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('link', { name: 'Portfolio', exact: true }),
    ).toBeVisible();

    // And the switch works in the other direction too.
    await page.getByRole('button', { name: '한국어' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(
      page.getByRole('link', { name: '포트폴리오', exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
