import Decimal from 'decimal.js';
import type { BookLevel } from '../../lib/api-types';
import { formatDecimal } from '../../lib/format-number';

export function depthPercent(size: string, maxSize: string): number {
  if (maxSize === '0') return 0;
  return Decimal.min(new Decimal(size).div(maxSize).mul(100), 100).toNumber();
}

function BookSide({
  side,
  levels,
  max,
}: {
  side: 'ask' | 'bid';
  levels: readonly BookLevel[];
  max: string;
}) {
  return (
    <ul className={`book-side book-side-${side}`} aria-label={`${side}s`}>
      {levels.length === 0 && <li className="book-empty">No {side}s</li>}
      {levels.map((level) => (
        <li key={`${side}-${level.price}-${level.size}`} className="book-level">
          <span className="sr-only">{side}</span>
          <span className="book-price">{formatDecimal(level.price)}</span>
          <span className="book-size">{formatDecimal(level.size)}</span>
          <span
            className="depth-bar"
            aria-hidden="true"
            style={{ width: `${depthPercent(level.size, max)}%` }}
          />
        </li>
      ))}
    </ul>
  );
}

export function OrderBook({
  bids = [],
  asks = [],
}: {
  bids?: readonly BookLevel[];
  asks?: readonly BookLevel[];
}) {
  const max = [...asks, ...bids]
    .reduce((m, x) => Decimal.max(m, x.size), new Decimal(0))
    .toString();
  return (
    <section aria-labelledby="order-book-title" className="panel order-book">
      <h2 id="order-book-title">Order book depth</h2>
      <div className="book-sides">
        <BookSide side="ask" levels={asks} max={max} />
        <BookSide side="bid" levels={bids} max={max} />
      </div>
    </section>
  );
}
