import Decimal from 'decimal.js';
import { formatDecimal, isDecimal } from '../../lib/format-number';

export type TickPoint = Readonly<{ asOf: string; price: string }>;

export const SPARKLINE_CAP = 120;

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
