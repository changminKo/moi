import { describe, expect, it } from 'vitest';
import {
  createPortfolioState,
  type PortfolioSnapshot,
  reducePortfolio,
} from './portfolio-store';

const snapshot = (accountSequence: string): PortfolioSnapshot => ({
  wallets: [],
  positions: [],
  reservations: [],
  activeOrders: [],
  accountSequence,
  market: { health: {}, recoveryFill: { US: true } },
});
const event = (eventId: string, accountSequence: string) => ({
  type: 'event' as const,
  eventId,
  accountSequence,
  payload: { market: { recoveryFill: { US: true } } },
});

describe('portfolio reconciliation', () => {
  it('deduplicates an event id', () => {
    const once = reducePortfolio(
      createPortfolioState(snapshot('41')),
      event('e42', '42'),
    );
    const twice = reducePortfolio(once, event('e42', '42'));
    expect(twice).toBe(once);
  });

  it('coalesces a sequence gap and ignores later events while stale', () => {
    const afterGap = reducePortfolio(
      createPortfolioState(snapshot('42')),
      event('e44', '44'),
    );
    const afterAnotherEvent = reducePortfolio(afterGap, event('e45', '45'));
    expect(afterGap.sync).toEqual({ status: 'STALE', refreshRequested: true });
    expect(afterAnotherEvent).toBe(afterGap);
  });

  it('accepts an authoritative snapshot and preserves recovery fill metadata', () => {
    const stale = reducePortfolio(
      createPortfolioState(snapshot('42')),
      event('e44', '44'),
    );
    const recovered = reducePortfolio(stale, snapshot('46'));
    expect(recovered.sync).toEqual({ status: 'LIVE', refreshRequested: false });
    expect(recovered.snapshot.accountSequence).toBe('46');
    expect(recovered.snapshot.market.recoveryFill.US).toBe(true);
  });
});
