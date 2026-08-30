import { useTranslation } from 'react-i18next';
import type { QuoteSnapshot } from '../../lib/api-types';
import { formatTimestamp } from '../../lib/format-datetime';
import { formatDecimal } from '../../lib/format-number';
import { OrderBook } from './order-book';
import { QuoteSparkline } from './quote-sparkline';
import { useQuoteTicks } from './use-quote-ticks';
import './quote-panel.css';

export function QuotePanel({ quote }: { quote: QuoteSnapshot | null }) {
  const { t, i18n } = useTranslation();
  const ticks = useQuoteTicks(quote);
  if (!quote)
    return (
      <section className="panel quote-panel is-empty" aria-live="polite">
        {t('quote.empty')}
      </section>
    );
  const health = quote.health ?? 'HEALTHY';
  return (
    <section className="panel quote-panel" aria-labelledby="quote-title">
      <div className="quote-header">
        <h2 id="quote-title">
          {quote.market}:{quote.symbol}
        </h2>
        <span className={`status-badge status-${health}`}>{health}</span>
      </div>
      <p className="quote-price">{formatDecimal(quote.price ?? '—')}</p>
      <p className="quote-asof">
        {t('quote.timestamp')}:{' '}
        <time dateTime={quote.asOf} data-testid="quote-asof">
          {formatTimestamp(quote.asOf, i18n.language)}
        </time>
      </p>
      <QuoteSparkline ticks={ticks} />
      <OrderBook
        {...(quote.bids ? { bids: quote.bids } : {})}
        {...(quote.asks ? { asks: quote.asks } : {})}
      />
    </section>
  );
}
