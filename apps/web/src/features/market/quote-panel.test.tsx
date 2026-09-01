import { cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Instrument, QuoteSnapshot } from '../../lib/api-types';
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

// Scoped by id, not role: the panel also renders the order book's own <h2>,
// and both are headings.
const title = () => document.getElementById('quote-title') as HTMLElement;

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

const appleInstrument: Instrument = {
  market: 'US',
  symbol: 'AAPL',
  name: '애플',
  tradable: true,
};

describe('QuotePanel instrument name', () => {
  test('shows the Korean display name with the ticker still visible', () => {
    render(<QuotePanel quote={quote} instrument={appleInstrument} />);

    const heading = title();
    expect(heading).toHaveTextContent('애플');
    expect(heading).toHaveTextContent('US:AAPL');
    // #quote-title is what the section is labelled by; it must survive.
    expect(heading).toHaveAttribute('id', 'quote-title');
  });

  test('shows the ticker once, not twice, when no instrument is passed', () => {
    render(<QuotePanel quote={quote} />);

    const heading = title();
    expect(heading.textContent).toBe('US:AAPL');
  });

  test('shows the ticker once when the name falls back to the symbol', () => {
    render(
      <QuotePanel
        quote={quote}
        instrument={{ ...appleInstrument, name: appleInstrument.symbol }}
      />,
    );

    const heading = title();
    expect(heading.textContent).toBe('US:AAPL');
  });

  test('ignores a stale instrument that does not match the streamed quote', () => {
    render(
      <QuotePanel
        quote={quote}
        instrument={{
          market: 'KR',
          symbol: '005930',
          name: '삼성전자',
          tradable: true,
        }}
      />,
    );

    const heading = title();
    expect(heading.textContent).toBe('US:AAPL');
  });

  test('keeps the section labelled by the heading', () => {
    render(<QuotePanel quote={quote} instrument={appleInstrument} />);

    expect(screen.getByRole('region', { name: /애플/ })).toBeInTheDocument();
  });

  // jsdom does no layout, so this cannot see the ellipsis truncation itself
  // (that's pinned in the e2e responsive-accessibility spec, which measures
  // real box heights); what it can pin is that a long name is still handed
  // to the DOM verbatim under .quote-name — truncation is CSS's job
  // (overflow/text-overflow on that class), not something the component
  // should do by slicing the string itself.
  test('hands a long name to the DOM in full, leaving truncation to CSS', () => {
    const longName =
      '아주 길게 늘어나는 가상의 종목명 테스트 케이스 문자열입니다 계속 이어집니다';
    render(
      <QuotePanel
        quote={quote}
        instrument={{ ...appleInstrument, name: longName }}
      />,
    );

    const nameNode = document.querySelector('.quote-name');
    expect(nameNode).toHaveTextContent(longName);
    const heading = title();
    expect(heading).toHaveTextContent('US:AAPL');
  });
});
