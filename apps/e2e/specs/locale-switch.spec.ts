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

    // A quote's timestamp follows the same choice: the reader sees their own
    // wall clock and language, while the element keeps the wire instant for
    // machines. Selecting an instrument is what puts a quote on the page.
    await page.getByRole('textbox', { name: 'Search' }).fill('AAPL');
    await page.getByRole('button', { name: /AAPL/ }).first().click();
    const timestamp = page.getByTestId('quote-asof');
    await expect(timestamp).toBeVisible();
    const wire = await timestamp.getAttribute('datetime');
    expect(wire, 'the wire instant stays machine-readable').toMatch(/Z$/);
    const inEnglish = (await timestamp.textContent())?.trim() ?? '';
    expect(inEnglish, 'the reader never sees ISO punctuation').not.toContain(
      'T',
    );
    expect(inEnglish).toMatch(/AM|PM/);

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
