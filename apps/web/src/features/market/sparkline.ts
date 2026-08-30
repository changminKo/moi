import Decimal from 'decimal.js';

export type TickPoint = Readonly<{ asOf: string; price: string }>;

export const SPARKLINE_CAP = 120;

/**
 * Appends a tick to the ring of collected points. Consecutive duplicates
 * (same `asOf`) are ignored — the poller can observe the same snapshot twice.
 */
export function appendTick(
  points: readonly TickPoint[],
  tick: TickPoint,
  cap: number = SPARKLINE_CAP,
): readonly TickPoint[] {
  const last = points[points.length - 1];
  if (last && last.asOf === tick.asOf) return points;
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
  if (prices.length < 2) return null;
  const decimals = prices.map((price) => new Decimal(price));
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
  return {
    points: coordinates.join(' '),
    direction,
    high: high.toString(),
    low: low.toString(),
  };
}
