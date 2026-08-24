import type { DecimalString, OrderBookSnapshot } from '@skipjack/trading-core';
import { snapshotInput } from '../db/database.js';

/** The complete market-data provenance attached to an execution. */
export interface PricingContext {
  readonly source: 'WEBSOCKET' | 'RECOVERY_REST';
  readonly recoveryEpoch: bigint;
  readonly marketDataVersion: bigint;
  readonly leaderFencingToken: bigint;
  readonly referencePrice: DecimalString;
  readonly referenceTimestamp: string | null;
  readonly book: OrderBookSnapshot;
  readonly pricingModelVersion: string;
  readonly feeModelVersion: string;
  readonly recoveryFill?: boolean;
  readonly incidentId?: string;
}

/** Copies the book as well as the context, preventing later feed mutation. */
export function createPricingContext(input: PricingContext): PricingContext {
  const book = snapshotInput({
    symbol: input.book.symbol,
    market: input.book.market,
    currency: input.book.currency,
    bids: input.book.bids.map((level) => snapshotInput({ price: level.price, volume: level.volume })),
    asks: input.book.asks.map((level) => snapshotInput({ price: level.price, volume: level.volume })),
  });
  return Object.freeze(snapshotInput({
    source: input.source,
    recoveryEpoch: input.recoveryEpoch,
    marketDataVersion: input.marketDataVersion,
    leaderFencingToken: input.leaderFencingToken,
    referencePrice: input.referencePrice,
    referenceTimestamp: input.referenceTimestamp,
    book,
    pricingModelVersion: input.pricingModelVersion,
    feeModelVersion: input.feeModelVersion,
    recoveryFill: input.recoveryFill ?? false,
    ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
  }));
}
