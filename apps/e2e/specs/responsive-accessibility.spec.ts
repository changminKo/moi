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

  // A name too long for the row must ellipsis, not wrap the heading onto a
  // second line — that would grow the heading's box and break the alignment
  // above. The e2e fixture only ever seeds a short name ("Apple"), so this
  // exercises the real CSS layout (jsdom has none) by growing the live
  // element's text directly, rather than widening the shared instrument
  // catalog every other spec in this suite also depends on.
  const nameHeightDelta = await page.evaluate(() => {
    const nameEl = document.querySelector<HTMLElement>('.quote-name');
    if (!nameEl) return null;
    const before = nameEl.getBoundingClientRect().height;
    nameEl.textContent =
      '아주 길게 늘어나는 가상의 종목명을 흉내 낸 테스트용 문자열이며 한 줄로는 절대 담기지 않을 만큼 계속 이어집니다';
    const after = nameEl.getBoundingClientRect().height;
    return after - before;
  });
  expect(
    nameHeightDelta,
    'the quote heading must render a .quote-name span to test truncation on',
  ).not.toBe(null);
  expect(
    nameHeightDelta,
    `${testInfo.project.name}: a long name must ellipsis, not wrap the heading onto a second line`,
  ).toBeLessThan(1);
});
