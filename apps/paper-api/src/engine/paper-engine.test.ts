import { createFeeModel } from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import { PaperEngine } from './paper-engine.js';

const feeModel = createFeeModel({
  version: 'fees-1',
  market: 'US',
  currency: 'USD',
  commissionRate: '0',
  sellTaxRate: '0',
  roundingDecimals: 2,
  roundingMode: 'HALF_UP',
});
const envelope = <T>(payload: T, version = 1n) => ({
  recoveryEpoch: 1n,
  leaderFencingToken: 1n,
  marketDataVersion: version,
  payload,
});
const book = {
  symbol: 'AAPL',
  market: 'US' as const,
  currency: 'USD' as const,
  bids: [{ price: '99', volume: '10' }],
  asks: [{ price: '100', volume: '2' }],
};

describe('PaperEngine', () => {
  it('derives recovery-fill provenance from a REST recovery book', async () => {
    const pricingSources: string[] = [];
    const engine = new PaperEngine({
      feeModel,
      onFill: (_order, _match, pricing) => {
        pricingSources.push(`${pricing.source}:${pricing.recoveryFill}`);
      },
    });
    await engine.placeImmediateOrder({
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      type: 'LIMIT',
      limitPrice: '100',
      quantity: '1',
    });

    await engine.onRecoveryOrderBook(envelope(book));

    expect(pricingSources).toEqual(['RECOVERY_REST:true']);
  });
  it('IOC partially fills and cancels the remainder', async () => {
    const engine = new PaperEngine({ feeModel });
    await engine.onOrderBook(envelope(book));
    const order = await engine.placeImmediateOrder({
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      quantity: '3',
    });
    expect(order.status).toBe('CANCELLED');
    expect(order.filledQuantity).toBe('2');
    expect(order.terminalReason).toBe('IOC_REMAINDER');
  });

  it('does not match outside the regular session', async () => {
    const engine = new PaperEngine({
      feeModel,
      calendar: { isRegularSession: () => false },
    });
    await engine.onOrderBook(envelope(book));
    const order = await engine.placeImmediateOrder({
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      quantity: '1',
    });
    expect(order.status).toBe('OPEN');
  });

  it('removes a cancelled order from subsequent matching', async () => {
    const fills: string[] = [];
    const engine = new PaperEngine({
      feeModel,
      onFill: (order) => {
        fills.push(order.id);
      },
    });
    await engine.placeImmediateOrder({
      id: 'cancelled',
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      type: 'LIMIT',
      limitPrice: '100',
      quantity: '1',
    });

    await engine.cancelOrder('cancelled');
    await engine.onOrderBook(envelope(book));

    expect(fills).toEqual([]);
    expect(engine.getOrder('cancelled')?.status).toBe('CANCELLED');
  });

  it('clears volatile orders and books when the runtime resets', async () => {
    const engine = new PaperEngine({ feeModel });
    await engine.onOrderBook(envelope(book));
    await engine.placeImmediateOrder({
      id: 'before-reset',
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      quantity: '1',
    });

    await engine.reset();
    const after = await engine.placeImmediateOrder({
      id: 'after-reset',
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      quantity: '1',
    });

    expect(engine.getOrder('before-reset')).toBeUndefined();
    expect(after.status).toBe('OPEN');
    expect(after.filledQuantity).toBe('0');
  });
});

describe('PaperEngine.restoreOrder', () => {
  it('registers a persisted order without matching and keeps its filled quantity', async () => {
    const { createFeeModel } = await import('@skipjack/trading-core');
    const fills: unknown[] = [];
    const engine = new PaperEngine({
      feeModel: createFeeModel({
        version: 't',
        market: 'US',
        currency: 'USD',
        commissionRate: '0',
        sellTaxRate: '0',
        roundingDecimals: 2,
        roundingMode: 'HALF_UP',
      }),
      onFill: (order, match) => {
        fills.push({
          id: order.id,
          filled: match.filledQuantity,
          next: match.nextStatus,
        });
      },
    });
    engine.restoreOrder({
      id: 'o1',
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '5',
      limitPrice: '100',
      status: 'PARTIALLY_FILLED',
      version: 3n,
      filledQuantity: '2',
    });
    engine.restoreOrder({
      id: 'c1',
      sessionId: 's1',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      type: 'STOP',
      quantity: '1',
      stopPrice: '300',
      status: 'PENDING_TRIGGER',
      version: 1n,
      filledQuantity: '0',
    });
    expect(engine.getOrder('o1')).toMatchObject({
      status: 'PARTIALLY_FILLED',
      filledQuantity: '2',
      version: 3n,
    });
    expect(engine.getOrder('c1')).toMatchObject({ status: 'PENDING_TRIGGER' });
    expect(fills).toHaveLength(0);
    await engine.onOrderBook({
      recoveryEpoch: 2n,
      leaderFencingToken: 2n,
      marketDataVersion: 1n,
      payload: {
        market: 'US',
        symbol: 'AAPL',
        currency: 'USD',
        asks: [{ price: '99', volume: '10' }],
        bids: [{ price: '98', volume: '10' }],
      },
    });
    expect(fills).toEqual([{ id: 'o1', filled: '5', next: 'FILLED' }]);
    expect(engine.getOrder('o1')?.status).toBe('FILLED');
  });

  describe('PaperEngine conditional trigger bookkeeping', () => {
    it('marks the triggered order in both maps and hands it to onConditionalTrigger', async () => {
      const triggered: string[] = [];
      const engine = new PaperEngine({
        feeModel: createFeeModel({
          version: 't',
          market: 'US',
          currency: 'USD',
          commissionRate: '0',
          sellTaxRate: '0',
          roundingDecimals: 2,
          roundingMode: 'HALF_UP',
        }),
        onConditionalTrigger: (order) => {
          triggered.push(`${order.id}:${order.status}`);
        },
      });
      engine.registerConditionalOrder({
        id: 'stop-1',
        sessionId: 's',
        market: 'US',
        symbol: 'AAPL',
        currency: 'USD',
        side: 'BUY',
        type: 'STOP',
        quantity: '1',
        stopPrice: '200',
        status: 'PENDING_TRIGGER',
        version: 0n,
        filledQuantity: '0',
      });
      await engine.onTrade({
        recoveryEpoch: 1n,
        leaderFencingToken: 1n,
        marketDataVersion: 1n,
        payload: {
          market: 'US',
          symbol: 'AAPL',
          price: '201',
          sourceTimestamp: null,
        },
      });
      expect(triggered).toEqual(['stop-1:TRIGGERED']);
      expect(engine.getOrder('stop-1')?.status).toBe('TRIGGERED');
    });
  });
});
