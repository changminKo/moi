import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './metrics.js';

describe('metrics registry', () => {
  it('renders bounded labels and never accepts identifiers as labels', () => {
    const metrics = new MetricsRegistry();
    metrics.counter('order_event_total', {
      market: 'US',
      event_type: 'PLACED',
      status: 'accepted',
    });
    expect(() =>
      metrics.counter('order_event_total', { symbol: 'AAPL' }),
    ).toThrow();
    const output = metrics.metrics();
    expect(output).toContain(
      'order_event_total{event_type="PLACED",market="US",status="accepted"} 1',
    );
    expect(output).not.toContain('AAPL');
  });
});
