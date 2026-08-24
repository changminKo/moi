import { describe, expect, it } from 'vitest';
import { createFeeModel } from '@skipjack/trading-core';
import { PaperEngine } from './paper-engine.js';

const feeModel = createFeeModel({ version: 'fees-1', market: 'US', currency: 'USD', commissionRate: '0', sellTaxRate: '0', roundingDecimals: 2, roundingMode: 'HALF_UP' });
const envelope = (payload: any, version = 1n) => ({ recoveryEpoch: 1n, leaderFencingToken: 1n, marketDataVersion: version, payload });
const book = { symbol: 'AAPL', market: 'US' as const, currency: 'USD' as const, bids: [{ price: '99', volume: '10' }], asks: [{ price: '100', volume: '2' }] };

describe('PaperEngine', () => {
  it('IOC partially fills and cancels the remainder', async () => {
    const engine = new PaperEngine({ feeModel });
    await engine.onOrderBook(envelope(book));
    const order = await engine.placeImmediateOrder({ sessionId: 's1', market: 'US', symbol: 'AAPL', currency: 'USD', side: 'BUY', quantity: '3' });
    expect(order.status).toBe('CANCELLED');
    expect(order.filledQuantity).toBe('2');
    expect(order.terminalReason).toBe('IOC_REMAINDER');
  });

  it('does not match outside the regular session', async () => {
    const engine = new PaperEngine({ feeModel, calendar: { isRegularSession: () => false } });
    await engine.onOrderBook(envelope(book));
    const order = await engine.placeImmediateOrder({ sessionId: 's1', market: 'US', symbol: 'AAPL', currency: 'USD', side: 'BUY', quantity: '1' });
    expect(order.status).toBe('OPEN');
  });
});
