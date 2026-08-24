import { describe, expect, it } from 'vitest';
import { MarketStateStore } from './market-state-store.js';
import {
  RecoveryCoordinator,
  type RecoverySnapshot,
} from './recovery-coordinator.js';

const snapshot = (price: string): RecoverySnapshot => ({
  market: 'US',
  symbol: 'AAPL',
  price,
  fetchedAt: '2026-01-01T00:00:00Z',
  book: {
    market: 'US',
    symbol: 'AAPL',
    currency: 'USD',
    bids: [{ price: '88', volume: '2' }],
    asks: [{ price: '89', volume: '2' }],
  },
});
describe('RecoveryCoordinator', () => {
  it('uses current REST state for recovery triggers and replaces the baseline', async () => {
    let sleeps = 0;
    const store = new MarketStateStore();
    const c = new RecoveryCoordinator({
      stream: {
        connect: async () => undefined,
        declare: async () => ({ accepted: ['trade:US:AAPL'], rejected: [] }),
      },
      snapshots: { getRecoverySnapshot: async () => snapshot('89') },
      stateStore: store,
      acquireLease: async () =>
        ({ market: 'US', epoch: 3n, fencingToken: 4n }) as never,
      symbols: ['AAPL'],
      subscriptions: [{ channel: 'trade', market: 'US', symbols: ['AAPL'] }],
      stabilityMs: 5_000,
      clock: {
        now: () => 0,
        sleep: async () => {
          sleeps += 1;
        },
      },
      evaluateRecovery: (s) => [
        { symbol: s.symbol, recoveryFill: true, referencePrice: s.price },
      ],
    });
    const result = await c.recover('US', new AbortController().signal);
    expect(result).toMatchObject({
      epoch: 3n,
      recoveredSymbols: ['AAPL'],
      blockedSymbols: [],
      recoveryTriggers: [{ recoveryFill: true, referencePrice: '89' }],
    });
    expect(store.get('AAPL')).toEqual(snapshot('89'));
    expect(sleeps).toBe(1);
  });
  it('keeps failed symbols blocked and records a symbol incident', async () => {
    const incidents: unknown[] = [],
      c = new RecoveryCoordinator({
        stream: {
          connect: async () => undefined,
          declare: async () => ({ accepted: [], rejected: [] }),
        },
        snapshots: {
          getRecoverySnapshot: async () => {
            throw new Error('offline');
          },
        },
        stateStore: new MarketStateStore(),
        acquireLease: async () =>
          ({ market: 'KR', epoch: 2n, fencingToken: 2n }) as never,
        symbols: ['005930'],
        subscriptions: [],
        stabilityMs: 0,
        incidents: {
          activate: async (input) => {
            incidents.push(input);
          },
        },
      });
    const result = await c.recover('KR', new AbortController().signal);
    expect(result.blockedSymbols).toEqual(['005930']);
    expect(incidents).toHaveLength(1);
  });
});
