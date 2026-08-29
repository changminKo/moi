import Decimal from 'decimal.js';
import type { BookLevel } from '../../lib/api-types';
export function depthPercent(size: string, maxSize: string): number {
  if (maxSize === '0') return 0;
  return Decimal.min(new Decimal(size).div(maxSize).mul(100), 100).toNumber();
}
export function OrderBook({
  bids = [],
  asks = [],
}: {
  bids?: readonly BookLevel[];
  asks?: readonly BookLevel[];
}) {
  const levels = [
    ...asks.map((x) => ({ ...x, side: 'ask' })),
    ...bids.map((x) => ({ ...x, side: 'bid' })),
  ];
  const max = levels
    .reduce((m, x) => Decimal.max(m, x.size), new Decimal(0))
    .toString();
  return (
    <section aria-labelledby="order-book-title" className="panel">
      <h2 id="order-book-title">Order book depth</h2>
      <ul>
        {levels.map((level) => (
          <li key={`${level.side}-${level.price}-${level.size}`}>
            <span>{level.side}</span> <span>{level.price}</span>{' '}
            <span>{level.size}</span>
            <span
              className="depth-bar"
              aria-hidden="true"
              style={{ width: `${depthPercent(level.size, max)}%` }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
