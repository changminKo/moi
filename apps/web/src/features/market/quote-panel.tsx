import type { QuoteSnapshot } from '../../lib/api-types';
import { OrderBook } from './order-book';
export function QuotePanel({ quote }: { quote: QuoteSnapshot | null }) {
  if (!quote)
    return (
      <section className="panel" aria-live="polite">
        Select an instrument to see its quote.
      </section>
    );
  const health = quote.health ?? 'HEALTHY';
  return (
    <section className="panel" aria-labelledby="quote-title">
      <h2 id="quote-title">
        {quote.market}:{quote.symbol}
      </h2>
      <p className="quote-price">{quote.price ?? '—'}</p>
      <p>Timestamp: {quote.asOf}</p>
      <span className={`status-badge status-${health}`}>{health}</span>
      <OrderBook
        {...(quote.bids ? { bids: quote.bids } : {})}
        {...(quote.asks ? { asks: quote.asks } : {})}
      />
    </section>
  );
}
