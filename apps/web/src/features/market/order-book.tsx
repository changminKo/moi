import Decimal from 'decimal.js';
import { useTranslation } from 'react-i18next';
import type { BookLevel } from '../../lib/api-types';
import { formatDecimal, isDecimal } from '../../lib/format-number';

/**
 * Both functions below hold to the contract `format-number.ts` states for the
 * render boundary: anything that is not a plain decimal passes through without
 * a throw. A quote panel is still worth reading when one level is malformed,
 * and an exception here has no ErrorBoundary above it — it unmounts the app.
 */
export function depthPercent(volume: string, maxVolume: string): number {
  if (!isDecimal(volume) || !isDecimal(maxVolume)) return 0;
  const max = new Decimal(maxVolume);
  if (max.isZero()) return 0;
  return Decimal.min(new Decimal(volume).div(max).mul(100), 100).toNumber();
}

/** The deepest level across the levels given, as a decimal string. */
export function maxVolume(levels: readonly BookLevel[]): string {
  return levels
    .reduce(
      (deepest, level) =>
        isDecimal(level.volume) ? Decimal.max(deepest, level.volume) : deepest,
      new Decimal(0),
    )
    .toString();
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
  const { t } = useTranslation();
  return (
    <ul
      className={`book-side book-side-${side}`}
      aria-label={side === 'ask' ? t('quote.asks') : t('quote.bids')}
    >
      {levels.length === 0 && (
        <li className="book-empty">
          {side === 'ask' ? t('quote.noAsks') : t('quote.noBids')}
        </li>
      )}
      {levels.map((level) => (
        <li
          key={`${side}-${level.price}-${level.volume}`}
          className="book-level"
        >
          <span className="sr-only">
            {side === 'ask' ? t('quote.ask') : t('quote.bid')}
          </span>
          <span className="book-price">{formatDecimal(level.price)}</span>
          <span className="book-size">{formatDecimal(level.volume)}</span>
          <span
            className="depth-bar"
            aria-hidden="true"
            style={{ width: `${depthPercent(level.volume, max)}%` }}
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
  const { t } = useTranslation();
  const max = maxVolume([...asks, ...bids]);
  return (
    <section aria-labelledby="order-book-title" className="panel order-book">
      <h2 id="order-book-title">{t('quote.bookTitle')}</h2>
      <div className="book-sides">
        <BookSide side="ask" levels={asks} max={max} />
        <BookSide side="bid" levels={bids} max={max} />
      </div>
    </section>
  );
}
