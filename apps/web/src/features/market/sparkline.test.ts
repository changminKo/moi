import { describe, expect, it } from 'vitest';
import {
  appendTick,
  DEFAULT_SPARKLINE_WINDOW,
  SPARKLINE_CAP,
  SPARKLINE_WINDOWS,
  sparklineGeometry,
  type TickPoint,
  takeWindow,
} from './sparkline';

const tick = (asOf: string, price: string): TickPoint => ({ asOf, price });

describe('appendTick', () => {
  it('appends new ticks and skips consecutive duplicates by asOf', () => {
    let points: readonly TickPoint[] = [];
    points = appendTick(points, tick('t1', '10'));
    points = appendTick(points, tick('t1', '10'));
    points = appendTick(points, tick('t2', '11'));
    expect(points.map((p) => p.asOf)).toEqual(['t1', 't2']);
  });

  it('caps the ring at the widest selectable window', () => {
    let points: readonly TickPoint[] = [];
    for (let index = 0; index < SPARKLINE_CAP + 10; index += 1) {
      points = appendTick(points, tick(`t${index}`, String(index)));
    }
    expect(points).toHaveLength(SPARKLINE_CAP);
    expect(points[0]?.asOf).toBe('t10');
    expect(points[SPARKLINE_CAP - 1]?.asOf).toBe(`t${SPARKLINE_CAP + 9}`);
  });

  it('does not mutate the previous array', () => {
    const before: readonly TickPoint[] = [tick('t1', '10')];
    const after = appendTick(before, tick('t2', '11'));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });
});

describe('sparklineGeometry', () => {
  it('returns null until there are two points', () => {
    expect(sparklineGeometry([], 240, 48)).toBeNull();
    expect(sparklineGeometry(['10'], 240, 48)).toBeNull();
  });

  it('scales decimal strings across the padded viewport', () => {
    const geometry = sparklineGeometry(['10', '20', '15'], 104, 54, 2);
    expect(geometry).not.toBeNull();
    // x: 2, 52, 102 — y: low(10) bottom 52, high(20) top 2, mid(15) centre 27
    expect(geometry?.points).toBe('2.00,52.00 52.00,2.00 102.00,27.00');
    expect(geometry?.direction).toBe('up');
    expect(geometry?.high).toBe('20');
    expect(geometry?.low).toBe('10');
  });

  it('draws a flat middle line when every price is equal', () => {
    const geometry = sparklineGeometry(['7', '7', '7'], 104, 54, 2);
    expect(geometry?.points).toBe('2.00,27.00 52.00,27.00 102.00,27.00');
    expect(geometry?.direction).toBe('flat');
  });

  it('reports a downward direction from first to last', () => {
    const geometry = sparklineGeometry(['20.50', '20.10'], 104, 54, 2);
    expect(geometry?.direction).toBe('down');
    // Reported verbatim (and grouped), so the summary matches the panel.
    expect(geometry?.high).toBe('20.50');
    expect(geometry?.low).toBe('20.10');
  });
});

describe('the selectable chart windows', () => {
  it('offers a small ascending set of options', () => {
    expect([...SPARKLINE_WINDOWS]).toEqual([30, 60, 120, 240]);
  });

  it('keeps the shipped 120 ticks as the default', () => {
    expect(DEFAULT_SPARKLINE_WINDOW).toBe(120);
  });

  // Otherwise the widest option could never fill: the ring would have thrown
  // the older points away before the reader ever asked for them.
  it('holds a ring as deep as the widest window', () => {
    expect(SPARKLINE_CAP).toBe(Math.max(...SPARKLINE_WINDOWS));
  });
});

describe('takeWindow', () => {
  const ring = Array.from({ length: 10 }, (_, index) =>
    tick(`t${index}`, String(index)),
  );

  it('keeps the newest points of a ring longer than the window', () => {
    expect(takeWindow(ring, 3).map((point) => point.asOf)).toEqual([
      't7',
      't8',
      't9',
    ]);
  });

  it('returns the ring itself when it is shorter than the window', () => {
    expect(takeWindow(ring, 240)).toBe(ring);
  });
});
