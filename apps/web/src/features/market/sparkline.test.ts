import { describe, expect, it } from 'vitest';
import { appendTick, sparklineGeometry, type TickPoint } from './sparkline';

const tick = (asOf: string, price: string): TickPoint => ({ asOf, price });

describe('appendTick', () => {
  it('appends new ticks and skips consecutive duplicates by asOf', () => {
    let points: readonly TickPoint[] = [];
    points = appendTick(points, tick('t1', '10'));
    points = appendTick(points, tick('t1', '10'));
    points = appendTick(points, tick('t2', '11'));
    expect(points.map((p) => p.asOf)).toEqual(['t1', 't2']);
  });

  it('caps the ring and keeps the newest points', () => {
    let points: readonly TickPoint[] = [];
    for (let index = 0; index < 130; index += 1) {
      points = appendTick(points, tick(`t${index}`, String(index)));
    }
    expect(points).toHaveLength(120);
    expect(points[0]?.asOf).toBe('t10');
    expect(points[119]?.asOf).toBe('t129');
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
    expect(geometry?.high).toBe('20.5');
    expect(geometry?.low).toBe('20.1');
  });
});
