import {
  calculateExecution,
  type ExecutionOrder,
  type ExecutionResult,
  type FeeModel,
  type OrderBookSnapshot,
  type OrderStatus,
  type Quantity,
} from '@moi/trading-core';
import type { PricingContext } from './pricing-context.js';

export interface MatchableOrder extends ExecutionOrder {
  readonly status: OrderStatus;
  readonly sessionId: string;
  readonly version: bigint;
}

export interface OrderMatch {
  readonly order: MatchableOrder;
  readonly execution: ExecutionResult;
  readonly nextStatus: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED';
  readonly filledQuantity: Quantity;
}

/** Match one order against an immutable copy of the observed book. */
export function matchOrder(
  order: MatchableOrder,
  book: OrderBookSnapshot,
  pricing: PricingContext,
  feeModel: FeeModel,
  maxDeviationBps = 10_000,
): OrderMatch {
  const execution = calculateExecution(order, book, feeModel, {
    referenceMid: pricing.referencePrice,
    maxDeviationBps,
  });
  const filled =
    BigInt(order.filledQuantity ?? '0') + BigInt(execution.filledQuantity);
  const total = BigInt(order.quantity);
  // A MARKET order is immediate-or-cancel: whatever the book (or price
  // protection) leaves unfilled is cancelled now, never left resting.
  const nextStatus =
    filled >= total
      ? 'FILLED'
      : execution.terminalReason !== undefined || order.type === 'MARKET'
        ? 'CANCELLED'
        : execution.filledQuantity === '0'
          ? 'OPEN'
          : 'PARTIALLY_FILLED';
  return { order, execution, nextStatus, filledQuantity: filled.toString() };
}

export function cloneOrderBook(book: OrderBookSnapshot): OrderBookSnapshot {
  return {
    symbol: book.symbol,
    market: book.market,
    currency: book.currency,
    bids: book.bids.map((x) => ({ price: x.price, volume: x.volume })),
    asks: book.asks.map((x) => ({ price: x.price, volume: x.volume })),
  };
}
