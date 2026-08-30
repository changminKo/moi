import { useTranslation } from 'react-i18next';
import { formatDecimal } from '../../lib/format-number';
import { sparklineGeometry, type TickPoint } from './sparkline';

const WIDTH = 240;
const HEIGHT = 48;

const STROKE: Record<'up' | 'down' | 'flat', string> = {
  up: 'var(--color-up)',
  down: 'var(--color-down)',
  flat: 'var(--color-muted)',
};

/**
 * Inline SVG sparkline over the ticks collected for the selected instrument.
 * The drawing is decorative (`aria-hidden`); screen readers get a summary.
 */
export function QuoteSparkline({ ticks }: { ticks: readonly TickPoint[] }) {
  const { t } = useTranslation();
  const geometry = sparklineGeometry(
    ticks.map((tick) => tick.price),
    WIDTH,
    HEIGHT,
  );
  if (!geometry) {
    return <p className="sparkline-empty">{t('quote.sparklineCollecting')}</p>;
  }
  const summary = t('quote.sparklineSummary', {
    count: ticks.length,
    high: formatDecimal(geometry.high),
    low: formatDecimal(geometry.low),
  });
  return (
    <div className={`quote-sparkline is-${geometry.direction}`}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="presentation"
      >
        <polyline
          points={geometry.points}
          fill="none"
          stroke={STROKE[geometry.direction]}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{summary}</span>
    </div>
  );
}
