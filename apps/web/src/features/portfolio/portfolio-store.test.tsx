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
/**
 * An event whose payload is a full snapshot patch, so it applies LIVE. The
 * spread is load-bearing: `PortfolioSnapshot` is an interface and has no
 * implicit index signature, so the interface value is not assignable to the
 * stream message's `Record` payload — the object literal is.
 */
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

    // The realistic duplicate: the same event redelivered as-is.
    const duplicate = reducePortfolio(once, patch('e42', '42'));
    expect(duplicate).toBe(once);
    // And the stronger shape — the same id with a sequence that would
    // otherwise be a gap — pins that dedupe runs before the sequence check.
    const twice = reducePortfolio(once, patch('e42', '43'));
    expect(twice).toBe(once);
    expect(twice.sync.status).toBe('LIVE');
    expect(twice.snapshot.accountSequence).toBe('42');
  });

  it('coalesces a sequence gap and ignores later events while stale', () => {
    // A full patch, so STALE here can only come from the gap itself (#95's
    // sibling: with the bare `event()` fixture `!isSnapshotPatch` also forced
    // STALE, so removing the gap check left this test green).
    const afterGap = reducePortfolio(
      createPortfolioState(snapshot('42')),
      patch('e44', '44'),
    );
    const afterAnotherEvent = reducePortfolio(afterGap, patch('e45', '45'));
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
