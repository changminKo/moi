import { describe, expect, it } from 'vitest';
import {
  createPortfolioState,
  type PortfolioSnapshot,
  reducePortfolio,
} from './portfolio-store';

/**
 * The two properties the live stream has to hold before its patched snapshot
 * may be written into the `PORTFOLIO_QUERY_KEY` cache.
 *
 * Today nothing writes there: the store patches its own state and the cache
 * only moves on a refetch, so the trade page's wallets and the sell-side
 * holding go stale between invalidations. The fix is to write the patched
 * snapshot straight into the cache — no extra request, and every cache reader
 * (wallets, positions, the FX ticket) becomes live at once.
 *
 * That fix is also what turns two accidents into contracts. Both are checked
 * here first, and both fail on purpose until the implementation lands:
 *
 * 1. **The patch must be a complete snapshot.** `applyEvent` spreads the
 *    payload over the previous snapshot, so any field the payload omits is
 *    carried forward silently. It is safe today only because
 *    `ProductionRuntime.#enrichPayload` happens to put the *whole* portfolio
 *    on every event — an accident of the server's convenience, not a promise
 *    it made. The gate that is supposed to catch a partial payload,
 *    `isSnapshotPatch`, only asks whether `wallets` is an array. The moment
 *    the store's output becomes the cache, a half-applied snapshot stops
 *    being a local display bug and becomes what every reader of the cache
 *    sees. So a payload that is not a complete snapshot must refuse to apply
 *    and refetch instead — the behaviour `reducePortfolio` already has for a
 *    payload with no snapshot shape at all.
 *
 * 2. **Only what `GET /api/v1/portfolio` answers may reach the cache.** The
 *    enriched payload is that response *plus the event's own fields*
 *    (`orderId`, `status`, `filledQuantity`, `recoveryEpoch`, `recoveryFill`),
 *    and `applyEvent` spreads all of them onto the snapshot it returns. A
 *    cache entry is read by components that never saw the event, so those
 *    fields would arrive as portfolio state that the REST shape says cannot
 *    exist — and would linger after the event that explained them.
 */

/**
 * Every key `GET /api/v1/portfolio` answers with, from `PortfolioSnapshot` in
 * `apps/paper-api/src/modules/portfolio/portfolio-schemas.ts`.
 *
 * `sessionId` is one of them, and is *required* there: a client checks the
 * payload back against the session its transport holds, and an optional field
 * on one side with a required one on the other is precisely how the SDK and
 * this API drifted apart (spec §16.32). So `sessionId` riding along on an
 * enriched event is not the leak — it belongs. The event's own fields are.
 *
 * The web-side `PortfolioSnapshot` (`portfolio-model.ts`) still omits
 * `sessionId`, which is the same divergence in the other direction and wants
 * closing when the cache write lands.
 */
const REST_SNAPSHOT_KEYS = [
  'accountSequence',
  'activeOrders',
  'market',
  'positions',
  'reservations',
  'sessionId',
  'wallets',
] as const;

const restSnapshot = (accountSequence: string) =>
  ({
    sessionId: 's-1',
    wallets: [{ currency: 'KRW', total: '10', available: '10', reserved: '0' }],
    positions: [
      {
        market: 'US',
        symbol: 'AAPL',
        total: '3',
        available: '3',
        reserved: '0',
      },
    ],
    reservations: [],
    activeOrders: [],
    accountSequence,
    market: { health: { US: 'HEALTHY' }, recoveryFill: { US: false } },
  }) as unknown as PortfolioSnapshot;

/** An `ORDER_FILLED` exactly as `#enrichPayload` puts it on the wire. */
const enrichedFill = (accountSequence: string) => ({
  type: 'event' as const,
  eventId: `e-${accountSequence}`,
  accountSequence,
  eventType: 'ORDER_FILLED',
  payload: {
    orderId: 'o-1',
    status: 'FILLED',
    filledQuantity: '3',
    recoveryEpoch: '1',
    recoveryFill: false,
    ...restSnapshot(accountSequence),
  },
});

describe('what may be written to the portfolio query cache', () => {
  it('refuses a payload that is not a complete snapshot, and refetches instead', () => {
    // Passes `isSnapshotPatch` — `wallets` is an array — but says nothing
    // about positions, reservations, activeOrders or market. Applying it
    // carries the previous values forward under a new account sequence, which
    // is a snapshot the server never sent.
    const partial = {
      type: 'event' as const,
      eventId: 'e-43',
      accountSequence: '43',
      eventType: 'ORDER_FILLED',
      payload: {
        orderId: 'o-1',
        status: 'FILLED',
        wallets: [
          { currency: 'KRW', total: '9', available: '9', reserved: '0' },
        ],
      },
    };

    const next = reducePortfolio(
      createPortfolioState(restSnapshot('42')),
      partial,
    );

    expect(next.sync).toEqual({ status: 'STALE', refreshRequested: true });
  });

  it('refuses a payload whose collections are the wrong shape', () => {
    const malformed = {
      type: 'event' as const,
      eventId: 'e-43',
      accountSequence: '43',
      payload: { ...restSnapshot('43'), positions: undefined },
    };

    const next = reducePortfolio(
      createPortfolioState(restSnapshot('42')),
      malformed,
    );

    expect(next.sync).toEqual({ status: 'STALE', refreshRequested: true });
  });

  it('keeps a complete snapshot patch live, and applies it', () => {
    // The guard above must not swallow the ordinary case: this is what every
    // real event looks like, and it has to keep patching without a refetch.
    const next = reducePortfolio(
      createPortfolioState(restSnapshot('42')),
      enrichedFill('43'),
    );

    expect(next.sync).toEqual({ status: 'LIVE', refreshRequested: false });
    expect(next.snapshot.accountSequence).toBe('43');
  });

  it('carries none of the event own fields onto the snapshot', () => {
    const next = reducePortfolio(
      createPortfolioState(restSnapshot('42')),
      enrichedFill('43'),
    );

    expect(Object.keys(next.snapshot).sort()).toEqual([...REST_SNAPSHOT_KEYS]);
  });
});
