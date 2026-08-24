import { createFeeModel } from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import { matchOrder } from './match-orders.js';
import { createPricingContext } from './pricing-context.js';

describe('normal matching', () => {
  it('uses independent immutable depth for each account', () => {
    const book = {
      symbol: 'AAPL',
      market: 'US' as const,
      currency: 'USD' as const,
      bids: [{ price: '99', volume: '10' }],
      asks: [{ price: '100', volume: '2' }],
    };
    const pricing = createPricingContext({
      source: 'WEBSOCKET',
      recoveryEpoch: 1n,
      marketDataVersion: 1n,
      leaderFencingToken: 1n,
      referencePrice: '100',
      referenceTimestamp: null,
      book,
      pricingModelVersion: 'p1',
      feeModelVersion: 'f1',
    });
    const fee = createFeeModel({
      version: 'f1',
      market: 'US',
      currency: 'USD',
      commissionRate: '0',
      sellTaxRate: '0',
      roundingDecimals: 2,
      roundingMode: 'HALF_UP',
    });
    const base = {
      market: 'US' as const,
      currency: 'USD' as const,
      symbol: 'AAPL',
      side: 'BUY' as const,
      type: 'MARKET' as const,
      quantity: '2',
      status: 'OPEN' as const,
      sessionId: 's',
      version: 0n,
    };
    expect(
      matchOrder({ ...base, id: 'a' }, book, pricing, fee).filledQuantity,
    ).toBe('2');
    expect(
      matchOrder({ ...base, id: 'b' }, book, pricing, fee).filledQuantity,
    ).toBe('2');
  });
});
