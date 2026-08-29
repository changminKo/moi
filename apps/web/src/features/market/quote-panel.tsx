import type { QuoteSnapshot } from '../../lib/api-types';
import { OrderBook } from './order-book';
import './quote-panel.css';

export function QuotePanel({ quote }: { quote: QuoteSnapshot | null }) {
  if (!quote)
    return (
      <section className="panel quote-panel is-empty" aria-live="polite">
        Select an instrument to see its quote.
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
      <p className="quote-price">{quote.price ?? '—'}</p>
      <p className="quote-asof">Timestamp: {quote.asOf}</p>
      <OrderBook
        {...(quote.bids ? { bids: quote.bids } : {})}
        {...(quote.asks ? { asks: quote.asks } : {})}
      />
    </section>
  );
}
