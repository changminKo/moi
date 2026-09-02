import { describe, expect, it } from 'vitest';
import { realizedKey, realizedPnlFromOrders } from './realized-pnl';

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
    expect(summary.byPosition.get(realizedKey('US', 'AAPL'))).toEqual({
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
    expect(summary.byPosition.get(realizedKey('US', 'AAPL'))?.realizedPnl).toBe(
      '20',
    );
    expect(summary.unavailable.size).toBe(0);
  });

  it('realizes only the sold share of a position still partly held', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '4', price: '100' }),
        fill({ side: 'SELL', quantity: '1', price: '110' }),
      ),
    ]);
    expect(summary.byPosition.get(realizedKey('US', 'AAPL'))?.realizedPnl).toBe(
      '10',
    );
  });

  it('reports zero for a symbol that has only been bought', () => {
    const summary = realizedPnlFromOrders([
      order(fill({ side: 'BUY', quantity: '3', price: '100' })),
    ]);
    expect(summary.byPosition.get(realizedKey('US', 'AAPL'))).toEqual({
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

  it('keeps the same symbol on two markets apart, as the ledger does', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ symbol: 'DUAL', market: 'US', currency: 'USD', side: 'BUY' }),
        fill({
          symbol: 'DUAL',
          market: 'US',
          currency: 'USD',
          side: 'SELL',
          price: '105',
        }),
      ),
      order(
        fill({
          symbol: 'DUAL',
          market: 'KR',
          currency: 'KRW',
          side: 'BUY',
          price: '1000',
        }),
        fill({
          symbol: 'DUAL',
          market: 'KR',
          currency: 'KRW',
          side: 'SELL',
          price: '900',
        }),
      ),
    ]);
    expect(summary.byPosition.get(realizedKey('US', 'DUAL'))?.realizedPnl).toBe(
      '5',
    );
    expect(summary.byPosition.get(realizedKey('KR', 'DUAL'))?.realizedPnl).toBe(
      '-100',
    );
    expect(summary.unavailable.size).toBe(0);
  });

  it('marks a row without a market unavailable rather than guessing one', () => {
    const summary = realizedPnlFromOrders([
      order(fill({ market: undefined, side: 'BUY' })),
    ]);
    expect(summary.byPosition.size).toBe(0);
    expect(summary.unavailable.size).toBe(1);
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
    expect([...summary.unavailable.keys()]).toEqual([
      realizedKey('US', 'AAPL'),
    ]);
    expect(summary.unavailable.get(realizedKey('US', 'AAPL'))).toMatch(/side/);
    expect(summary.byPosition.has(realizedKey('US', 'AAPL'))).toBe(false);
    expect(summary.byPosition.get(realizedKey('US', 'MSFT'))?.realizedPnl).toBe(
      '10',
    );
    expect(summary.totals).toEqual([{ currency: 'USD', realizedPnl: '10' }]);
  });

  it('marks a symbol unavailable when its fills sell more than was ever bought', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '1', price: '100' }),
        fill({ side: 'SELL', quantity: '2', price: '110' }),
      ),
    ]);
    expect(summary.unavailable.get(realizedKey('US', 'AAPL'))).toMatch(
      /INSUFFICIENT_AVAILABLE_POSITION/,
    );
    expect(summary.totals).toEqual([]);
  });

  it('marks a symbol unavailable when its fills disagree about the currency', () => {
    const summary = realizedPnlFromOrders([
      order(
        fill({ side: 'BUY', quantity: '1', price: '100', currency: 'USD' }),
        fill({ side: 'SELL', quantity: '1', price: '110', currency: 'KRW' }),
      ),
    ]);
    expect([...summary.unavailable.keys()]).toEqual([
      realizedKey('US', 'AAPL'),
    ]);
    expect(summary.byPosition.has(realizedKey('US', 'AAPL'))).toBe(false);
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
    expect([...summary.unavailable.keys()]).toEqual([
      realizedKey('US', 'AAPL'),
    ]);
  });

  it('answers empty for a session with no fills', () => {
    const summary = realizedPnlFromOrders([order(), { id: 'no-fills-field' }]);
    expect(summary.byPosition.size).toBe(0);
    expect(summary.totals).toEqual([]);
    expect(summary.unavailable.size).toBe(0);
  });
});
