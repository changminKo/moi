import { describe, expect, it } from 'vitest';
import { MarketStateStore } from './market-state-store.js';

describe('MarketStateStore', () => {
  it('rejects stale epochs and tokens without advancing the version', () => {
    const store = new MarketStateStore();
    const epoch = store.beginEpoch(3n, 8n);
    expect(epoch).toEqual({ recoveryEpoch: 3n, leaderFencingToken: 8n });
    expect(store.applyEvent({ symbol: 'AAPL', version: 1n, payload: 'one' })).toMatchObject({ marketDataVersion: 1n });
    expect(() => store.applyEvent({ symbol: 'AAPL', version: 2n, payload: 'old', recoveryEpoch: 2n, leaderFencingToken: 8n })).toThrow(/stale/i);
    expect(store.currentVersion).toBe(1n);
  });

  it('rejects out-of-order symbol versions and accepts baselines', () => {
    const store = new MarketStateStore({ recoveryEpoch: 1n, leaderFencingToken: 2n });
    store.applyEvent({ symbol: 'AAPL', version: 4n, payload: 'four' });
    expect(() => store.applyEvent({ symbol: 'AAPL', version: 4n, payload: 'again' })).toThrow(/monotonic|order/i);
    expect(store.replaceBaseline('AAPL', 'baseline')).toMatchObject({ marketDataVersion: 2n });
    expect(store.get('AAPL')).toBe('baseline');
  });
});
