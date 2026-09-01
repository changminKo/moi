import { describe, expect, it, vi } from 'vitest';

const { commitSpy } = vi.hoisted(() => ({ commitSpy: vi.fn() }));

vi.mock('../../db/unit-of-work.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/unit-of-work.js')>()),
  commitTradingMutation: commitSpy,
}));

import type { UnitOfWork } from '../../db/unit-of-work.js';
import { MarketStateStore } from '../../market-data/market-state-store.js';
import {
  referencePrice,
  type SymbolQuoteState,
  withBook,
  withTrade,
} from '../../market-data/symbol-quote-state.js';
import { OrderPlacementService } from './order-placement-service.js';

const BOOK = {
  market: 'US' as const,
  symbol: 'AAPL',
  currency: 'USD' as const,
  bids: [{ price: '100', volume: '10' }],
  asks: [{ price: '101', volume: '10' }],
};

const TRADE = { price: '100.25', sourceTimestamp: null };

/** Feeds one symbol's slot the way `MarketRuntime.#dispatch` does. */
function storeWith(order: 'book-then-trade' | 'trade-then-book') {
  const store = new MarketStateStore();
  const apply = (payload: SymbolQuoteState) =>
    store.applyEvent({
      symbol: 'AAPL',
      version: store.currentVersion + 1n,
      payload,
    });
  const read = () => store.get('AAPL') as SymbolQuoteState | undefined;
  if (order === 'book-then-trade') {
    apply(withBook(read(), BOOK));
    apply(withTrade(read(), TRADE));
  } else {
    apply(withTrade(read(), TRADE));
    apply(withBook(read(), BOOK));
  }
  return store;
}

function place(store: MarketStateStore) {
  const reference = vi.fn((_market: 'KR' | 'US', symbol: string) =>
    referencePrice(store.get(symbol) as SymbolQuoteState | undefined),
  );
  const service = new OrderPlacementService({
    unitOfWork: {} as UnitOfWork,
    engine: () => ({
      placeImmediateOrder: async () => undefined,
      registerConditionalOrder: () => undefined,
    }),
    referencePrice: reference,
  });
  return {
    reference,
    result: service.place({
      sessionId: 's1',
      idempotencyKey: 'k1',
      requestHash: 'h1',
      input: {
        market: 'US',
        symbol: 'AAPL',
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
      } as never,
    }),
  };
}

describe('OrderPlacementService reference price', () => {
  // A trade frame used to erase the book from the symbol slot, so a MARKET BUY
  // was rejected with MARKET_DATA_DEGRADED depending purely on which frame
  // arrived last.
  it.each(['book-then-trade', 'trade-then-book'] as const)(
    'sizes a MARKET BUY from the ask after %s',
    async (order) => {
      commitSpy.mockReset();
      commitSpy.mockImplementation(async (_uow: unknown, input: unknown) => ({
        replayed: true,
        body: { id: (input as { order: { id: string } }).order.id },
      }));

      const { reference, result } = place(storeWith(order));
      await expect(result).resolves.toBeDefined();
      expect(reference).toHaveReturnedWith('101');

      const committed = commitSpy.mock.calls[0]?.[1] as {
        cash?: { currency: string; amount: string };
        reservationId?: string;
      };
      expect(committed.cash?.currency).toBe('USD');
      expect(committed.cash?.amount).toMatch(/^\d+(\.\d+)?$/);
      expect(committed.reservationId).toBeDefined();
    },
  );

  it('still refuses a MARKET BUY when no frame has arrived at all', async () => {
    commitSpy.mockReset();
    const { result } = place(new MarketStateStore());
    await expect(result).rejects.toThrow(/reference price/i);
    expect(commitSpy).not.toHaveBeenCalled();
  });
});
