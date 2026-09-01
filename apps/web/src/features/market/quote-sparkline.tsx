import { useTranslation } from 'react-i18next';
import {
  SPARKLINE_WINDOWS,
  type SparklineWindowSize,
  sparklineGeometry,
  type TickPoint,
  takeWindow,
} from './sparkline';

const WIDTH = 240;
const HEIGHT = 48;

const STROKE: Record<'up' | 'down' | 'flat', string> = {
  up: 'var(--color-up)',
  down: 'var(--color-down)',
  flat: 'var(--color-muted)',
};

/**
 * Inline SVG sparkline over the ticks collected for the selected instrument,
 * with the window control above it.
 *
 * The drawing is decorative (`aria-hidden`); the summary beneath it is the
 * readable version and is now visible rather than screen-reader only, because
 * it is the one place that can be honest about a window the ring has not
 * filled yet: choosing 240 ticks cannot conjure history the stream never
 * pushed, so the summary says "47 of 240 ticks so far" until it has them.
 */
export function QuoteSparkline({
  ticks,
  windowSize,
  onWindowSizeChange,
}: {
  ticks: readonly TickPoint[];
  windowSize: SparklineWindowSize;
  onWindowSizeChange: (size: SparklineWindowSize) => void;
}) {
  const { t } = useTranslation();
  const windowed = takeWindow(ticks, windowSize);
  const geometry = sparklineGeometry(
    windowed.map((tick) => tick.price),
    WIDTH,
    HEIGHT,
  );
  const control = (
    <fieldset className="chart-window">
      <legend>{t('quote.chartWindow')}</legend>
      <div className="chart-window-options">
        {SPARKLINE_WINDOWS.map((size) => (
          <label key={size}>
            <input
              className="chart-window-radio"
              type="radio"
              name="chart-window"
              checked={size === windowSize}
              onChange={() => onWindowSizeChange(size)}
            />{' '}
            {t('quote.chartWindowOption', { count: size })}
          </label>
        ))}
      </div>
    </fieldset>
  );
  // The control stays put while the chart has too few points to draw: it is
  // how the reader narrows the window to something the ring can already fill.
  if (!geometry) {
    return (
      <div className="quote-sparkline">
        {control}
        <p className="sparkline-empty">{t('quote.sparklineCollecting')}</p>
      </div>
    );
  }
  const values = {
    count: windowed.length,
    window: windowSize,
    high: geometry.high,
    low: geometry.low,
  };
  const summary =
    windowed.length < windowSize
      ? t('quote.sparklineSummaryPartial', values)
      : t('quote.sparklineSummary', values);
  return (
    <div className="quote-sparkline">
      {control}
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
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
      <p className="sparkline-summary">{summary}</p>
    </div>
  );
}
