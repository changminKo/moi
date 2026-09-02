import { describe, expect, it } from 'vitest';
import { realizedPnlFromOrders } from './realized-pnl';

// Fill rows as the snapshot's `activeOrders[].fills` carries them: the full
// `FillRecord` from `fillRecord()` (spec §16.45), typed `unknown` at this
// boundary like every other wire row the web reads.
type Row = Record<string, unknown>;

let sequence = 0;
function fill(overrides: Row): Row {
  sequence += 1;
  return {
    id: `fill-${sequence}`,
    fillSequence: String(sequence),
    accountSequence: String(sequence),
    orderId: 'order-1',
    market: 'US',
    symbol: 'AAPL',
    side: 'BUY',
    quantity: '1',
    price: '100',
    fee: '0',
    currency: 'USD',
    isRecoveryFill: false,
    occurredAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

const order = (...fills: Row[]): Row => ({ id: 'order', fills });

describe('realizedPnlFromOrders', () => {
  it('nets the sale proceeds against the cost of what was sold, fees included', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '2', price: '100', fee: '1' }),
        fill({ side: 'SELL', quantity: '2', price: '110', fee: '1' }),
      ),
    ]);
    // (220 − 1) − (200 + 1)
    expect(summary.bySymbol.get('AAPL')).toEqual({
      realizedPnl: '18',
      currency: 'USD',
    });
    expect(summary.totals).toEqual([{ currency: 'USD', realizedPnl: '18' }]);
    expect(summary.unavailable.size).toBe(0);
  });

  it('folds fills in fillSequence order, not in the order the snapshot lists them', () => {
    const sell = fill({
      side: 'SELL',
      quantity: '2',
      price: '110',
      fillSequence: '20',
    });
    const buy = fill({
      side: 'BUY',
      quantity: '2',
      price: '100',
      fillSequence: '19',
    });
    // The sell's order comes first in `activeOrders`; a naive array walk would
    // sell before buying and reject the sequence.
    const summary = realizedPnlFromOrders([order(sell), order(buy)]);
    expect(summary.bySymbol.get('AAPL')?.realizedPnl).toBe('20');
    expect(summary.unavailable.size).toBe(0);
  });

  it('realizes only the sold share of a position still partly held', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '4', price: '100' }),
        fill({ side: 'SELL', quantity: '1', price: '110' }),
      ),
    ]);
    expect(summary.bySymbol.get('AAPL')?.realizedPnl).toBe('10');
  });

  it('reports zero for a symbol that has only been bought', () => {
    const summary = realizedPnlFromOrders([
      order(fill({ side: 'BUY', quantity: '3', price: '100' })),
    ]);
    expect(summary.bySymbol.get('AAPL')).toEqual({
      realizedPnl: '0',
      currency: 'USD',
    });
  });

  it('totals per settlement currency, KRW before USD', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '1', price: '100' }),
        fill({ side: 'SELL', quantity: '1', price: '90' }),
      ),
      order(
        fill({
          symbol: '005930',
          market: 'KR',
          currency: 'KRW',
          side: 'BUY',
          quantity: '10',
          price: '70000',
        }),
        fill({
          symbol: '005930',
          market: 'KR',
          currency: 'KRW',
          side: 'SELL',
          quantity: '10',
          price: '71000',
        }),
      ),
    ]);
    expect(summary.totals).toEqual([
      { currency: 'KRW', realizedPnl: '10000' },
      { currency: 'USD', realizedPnl: '-10' },
    ]);
  });

  it('marks a symbol unavailable when one of its rows cannot be read, leaving the others intact', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '1', price: '100' }),
        fill({ side: undefined, quantity: '1', price: '110' }),
      ),
      order(
        fill({ symbol: 'MSFT', side: 'BUY', quantity: '1', price: '300' }),
        fill({ symbol: 'MSFT', side: 'SELL', quantity: '1', price: '310' }),
      ),
    ]);
    expect(summary.unavailable).toEqual(new Set(['AAPL']));
    expect(summary.bySymbol.has('AAPL')).toBe(false);
    expect(summary.bySymbol.get('MSFT')?.realizedPnl).toBe('10');
    expect(summary.totals).toEqual([{ currency: 'USD', realizedPnl: '10' }]);
  });

  it('marks a symbol unavailable when its fills sell more than was ever bought', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '1', price: '100' }),
        fill({ side: 'SELL', quantity: '2', price: '110' }),
      ),
    ]);
    expect(summary.unavailable).toEqual(new Set(['AAPL']));
    expect(summary.totals).toEqual([]);
  });

  it('marks a symbol unavailable when its fills disagree about the currency', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '1', price: '100', currency: 'USD' }),
        fill({ side: 'SELL', quantity: '1', price: '110', currency: 'KRW' }),
      ),
    ]);
    expect(summary.unavailable).toEqual(new Set(['AAPL']));
    expect(summary.bySymbol.has('AAPL')).toBe(false);
  });

  it('marks a symbol unavailable when a row has no readable fillSequence to order it by', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({
          side: 'BUY',
          quantity: '1',
          price: '100',
          fillSequence: undefined,
        }),
        fill({ side: 'SELL', quantity: '1', price: '110' }),
      ),
    ]);
    expect(summary.unavailable).toEqual(new Set(['AAPL']));
  });

  it('answers empty for a session with no fills', () => {
    const summary = realizedPnlFromOrders([order(), { id: 'no-fills-field' }]);
    expect(summary.bySymbol.size).toBe(0);
    expect(summary.totals).toEqual([]);
    expect(summary.unavailable.size).toBe(0);
  });
});
