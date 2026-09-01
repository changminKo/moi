import Decimal from 'decimal.js';
import { formatDecimal, isDecimal } from '../../lib/format-number';

export type TickPoint = Readonly<{ asOf: string; price: string }>;

/**
 * The chart windows a reader can pick between, in ticks. A short fixed set
 * rather than a free field: the axis is index-spaced, so only a count means
 * anything here, and four options fit the panel as a segmented control while a
 * number box would invite values (3, 100000) the ring can never serve.
 */
export const SPARKLINE_WINDOWS = [30, 60, 120, 240] as const;
export type SparklineWindowSize = (typeof SPARKLINE_WINDOWS)[number];

/** What the panel shipped with, and so what an untouched panel still shows. */
export const DEFAULT_SPARKLINE_WINDOW: SparklineWindowSize = 120;

/**
 * The ring holds the widest window; every narrower one is a slice of it
 * (`takeWindow`). Collecting only the default would make the widest option a
 * lie — the older ticks would already have been dropped by the time the
 * reader asked for them.
 */
export const SPARKLINE_CAP: number = Math.max(...SPARKLINE_WINDOWS);

/**
 * The newest `size` points of the ring. Returns the ring itself when it holds
 * fewer, which is the honest case a wide window starts in: the panel says how
 * many of the requested ticks it actually has rather than padding the chart.
 */
export function takeWindow(
  points: readonly TickPoint[],
  size: number,
): readonly TickPoint[] {
  return points.length <= size ? points : points.slice(points.length - size);
}

/**
 * Appends a tick to the ring of collected points. A repeat of the previous
 * `asOf` *and* price is ignored — a reconnect can replay the last snapshot —
 * while a genuinely new price is kept even when it shares a timestamp.
 */
export function appendTick(
  points: readonly TickPoint[],
  tick: TickPoint,
  cap: number = SPARKLINE_CAP,
): readonly TickPoint[] {
  const last = points[points.length - 1];
  if (last && last.asOf === tick.asOf && last.price === tick.price)
    return points;
  const next = [...points, tick];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export type SparklineGeometry = Readonly<{
  /** SVG polyline `points` attribute. */
  points: string;
  direction: 'up' | 'down' | 'flat';
  high: string;
  low: string;
}>;

/**
 * Scales decimal-string prices into polyline coordinates. Price comparison and
 * extrema stay in Decimal; only the final pixel ratio becomes a JS number.
 */
export function sparklineGeometry(
  prices: readonly string[],
  width: number,
  height: number,
  pad = 2,
): SparklineGeometry | null {
  // Prices arrive as strings from the API; anything unparseable ('—', '')
  // is dropped rather than thrown at render time.
  const parsed = prices
    .filter(isDecimal)
    .map((raw) => ({ raw, value: new Decimal(raw) }));
  if (parsed.length < 2) return null;
  const decimals = parsed.map((point) => point.value);
  const high = Decimal.max(...decimals);
  const low = Decimal.min(...decimals);
  const range = high.sub(low);
  const innerWidth = width - pad * 2;
  const innerHeight = height - pad * 2;
  const step = innerWidth / (decimals.length - 1);
  const coordinates = decimals.map((price, index) => {
    const ratio = range.isZero() ? 0.5 : price.sub(low).div(range).toNumber();
    const x = pad + step * index;
    const y = pad + (1 - ratio) * innerHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const first = decimals[0];
  const last = decimals[decimals.length - 1];
  if (first === undefined || last === undefined) return null;
  const direction = last.gt(first) ? 'up' : last.lt(first) ? 'down' : 'flat';
  // The raw strings are reported, not Decimal's normalised form, so the
  // summary reads exactly like the price the panel shows ('20.50', not '20.5').
  const highest = parsed.reduce((a, b) => (b.value.gt(a.value) ? b : a));
  const lowest = parsed.reduce((a, b) => (b.value.lt(a.value) ? b : a));
  return {
    points: coordinates.join(' '),
    direction,
    high: formatDecimal(highest.raw),
    low: formatDecimal(lowest.raw),
  };
}
