import { describe, expect, it } from 'vitest';
import {
  createPortfolioState,
  type PortfolioSnapshot,
  reducePortfolio,
} from './portfolio-store';

const snapshot = (accountSequence: string): PortfolioSnapshot => ({
  sessionId: 's-1',
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
/** An event whose payload is a full snapshot patch, so it applies LIVE. */
const patch = (eventId: string, accountSequence: string) => ({
  type: 'event' as const,
  eventId,
  accountSequence,
  payload: { ...snapshot(accountSequence) },
});

describe('portfolio reconciliation', () => {
  it('deduplicates an event id', () => {
    // #95: the fixture must apply LIVE, or the second delivery is swallowed by
    // the STALE short-circuit and the dedupe path is never exercised.
    const once = reducePortfolio(
      createPortfolioState(snapshot('41')),
      patch('e42', '42'),
    );
    expect(once.sync).toEqual({ status: 'LIVE', refreshRequested: false });
    expect(once.snapshot.accountSequence).toBe('42');
    expect(once.seenEventIds.has('e42')).toBe(true);

    // The same event id again — even with a sequence that would otherwise be
    // a gap — is a no-op on the very same state object.
    const twice = reducePortfolio(once, patch('e42', '43'));
    expect(twice).toBe(once);
    expect(twice.sync.status).toBe('LIVE');
    expect(twice.snapshot.accountSequence).toBe('42');
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

describe('reducePortfolio replay guard', () => {
  it('requests a refresh instead of patching when an event payload lacks the snapshot shape', () => {
    const snapshot = {
      accountSequence: '5',
      wallets: [],
      positions: [],
      reservations: [],
      activeOrders: [],
      market: { health: {}, recoveryFill: {} },
    } as never;
    const live = reducePortfolio(
      {
        snapshot: undefined as never,
        sync: { status: 'LIVE', refreshRequested: false },
        seenEventIds: new Set(),
      } as never,
      snapshot,
    );
    const next = reducePortfolio(live, {
      type: 'event',
      eventId: 'e6',
      accountSequence: '6',
      eventType: 'ORDER_FILLED',
      payload: { orderId: 'o1', status: 'FILLED' },
    } as never);
    expect(next.sync).toEqual({ status: 'STALE', refreshRequested: true });
    expect(next.snapshot.accountSequence).toBe('5');
  });
});
