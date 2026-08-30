import { cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { QuoteSnapshot } from '../../lib/api-types';
import '../../lib/i18n';
import { QuotePanel } from './quote-panel';

afterEach(cleanup);
beforeEach(async () => {
  await i18next.changeLanguage('ko');
});

const ISO = '2026-08-30T07:49:08.683Z';

const quote: QuoteSnapshot = {
  market: 'US',
  symbol: 'AAPL',
  price: '189.10',
  asOf: ISO,
  health: 'HEALTHY',
  recoveryEpoch: '1',
  marketDataVersion: '2',
};

const timestampText = () =>
  screen.getByTestId('quote-asof').textContent?.trim() ?? '';

describe('QuotePanel timestamp', () => {
  test('renders the instant in the reader locale, not the wire format', () => {
    render(<QuotePanel quote={quote} />);

    const text = timestampText();
    expect(text).toContain('2026');
    // The ISO punctuation is what the reader should never see.
    expect(text).not.toContain('T07:49');
    expect(text).not.toContain('Z');
  });

  test('keeps the machine-readable instant on the time element', () => {
    render(<QuotePanel quote={quote} />);

    expect(screen.getByTestId('quote-asof')).toHaveAttribute('datetime', ISO);
  });

  test('re-renders the timestamp when the locale changes', async () => {
    render(<QuotePanel quote={quote} />);
    const inKorean = timestampText();

    await i18next.changeLanguage('en');
    const inEnglish = timestampText();

    expect(inEnglish).not.toBe(inKorean);
    expect(inEnglish).toContain('2026');
  });
});
