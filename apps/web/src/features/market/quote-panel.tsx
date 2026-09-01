import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Instrument, QuoteSnapshot } from '../../lib/api-types';
import { resolveQuoteCurrency, withCurrency } from '../../lib/currency';
import { formatTimestamp } from '../../lib/format-datetime';
import { formatDecimal, isDecimal } from '../../lib/format-number';
import { OrderBook } from './order-book';
import { QuoteSparkline } from './quote-sparkline';
import type { SparklineWindowSize } from './sparkline';
import { readSparklineWindow, writeSparklineWindow } from './sparkline-window';
import { useQuoteTicks } from './use-quote-ticks';
import './quote-panel.css';

export function QuotePanel({
  quote,
  instrument = null,
}: {
  quote: QuoteSnapshot | null;
  /**
   * The selected instrument, carried by the trade page alongside the quote
   * it drove — the quote stream itself has no display name. Only trusted
   * when it names the same market/symbol as `quote`: a deep link or a
   * pending selection can otherwise race ahead of the stream and mislabel a
   * still-loading quote with the previous instrument's name.
   */
  instrument?: Instrument | null;
}) {
  const { t, i18n } = useTranslation();
  const ticks = useQuoteTicks(quote);
  // Read once, on mount: the choice is the reader's, and the panel is not
  // unmounted by an instrument switch, so it carries across both switches and
  // reloads while the tick ring below is rebuilt per instrument.
  const [windowSize, setWindowSize] =
    useState<SparklineWindowSize>(readSparklineWindow);
  const chooseWindow = (size: SparklineWindowSize) => {
    setWindowSize(size);
    writeSparklineWindow(size);
  };
  if (!quote)
    return (
      <section className="panel quote-panel is-empty" aria-live="polite">
        {t('quote.empty')}
      </section>
    );
  const health = quote.health ?? 'HEALTHY';
  const ticker = `${quote.market}:${quote.symbol}`;
  // Same fallback rule as the instrument list (instrument-search.tsx): a
  // name that is just the symbol echoed back is not a name, so show the
  // ticker once rather than doubling it up.
  const displayName =
    instrument &&
    instrument.market === quote.market &&
    instrument.symbol === quote.symbol &&
    instrument.name !== instrument.symbol
      ? instrument.name
      : null;
  const currency = resolveQuoteCurrency(instrument, quote);
  // The em dash of a priceless quote is a label, not an amount: tagging it
  // with a symbol would read as a price of nothing. `formatDecimal` already
  // passes it through unchanged, and `withCurrency` is skipped for it.
  const price = quote.price;
  const priceText =
    price !== null && isDecimal(price)
      ? withCurrency(currency, formatDecimal(price))
      : formatDecimal(price ?? '—');
  return (
    <section className="panel quote-panel" aria-labelledby="quote-title">
      <div className="quote-header">
        <h2 id="quote-title">
          {displayName ? (
            <>
              <span className="quote-name">{displayName}</span>
              <span className="quote-ticker">{ticker}</span>
            </>
          ) : (
            ticker
          )}
        </h2>
        <span className={`status-badge status-${health}`}>{health}</span>
      </div>
      <p className="quote-price">{priceText}</p>
      <p className="quote-asof">
        {t('quote.timestamp')}:{' '}
        <time dateTime={quote.asOf} data-testid="quote-asof">
          {formatTimestamp(quote.asOf, i18n.language)}
        </time>
      </p>
      <QuoteSparkline
        ticks={ticks}
        windowSize={windowSize}
        onWindowSizeChange={chooseWindow}
      />
      <OrderBook
        {...(quote.bids ? { bids: quote.bids } : {})}
        {...(quote.asks ? { asks: quote.asks } : {})}
        {...(currency === undefined ? {} : { currency })}
      />
    </section>
  );
}
