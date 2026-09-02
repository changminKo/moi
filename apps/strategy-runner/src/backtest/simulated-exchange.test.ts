import type { OrderIntent, Tick } from '@moi/strategy-sdk/strategy';
import type { FeeScheduleConfig } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { SimulatedExchange } from './simulated-exchange.js';

const FEES: readonly FeeScheduleConfig[] = [
  {
    version: 'backtest-1',
    market: 'KR',
    currency: 'KRW',
    // 0.1% commission, 0.2% sell tax, whole won, half up.
    commissionRate: '0.001',
    sellTaxRate: '0.002',
    roundingDecimals: 0,
    roundingMode: 'HALF_UP',
  },
];

const exchange = (cash = '10000000'): SimulatedExchange =>
  new SimulatedExchange({
    fees: FEES,
    cash: [{ currency: 'KRW', amount: cash }],
  });

const tick = (
  price: string,
  book: { readonly bid?: string | null; readonly ask?: string | null } = {},
  index = 0,
): Tick => ({
  market: 'KR',
  symbol: '005930',
  price,
  priceSource: 'rest-snapshot',
  bestBid: book.bid === undefined ? null : book.bid,
  bestAsk: book.ask === undefined ? null : book.ask,
  asOf: `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`,
  marketDataVersion: String(index + 1),
  gapBefore: false,
});

const intent = (
  side: 'BUY' | 'SELL',
  quantity: string,
  price?: string,
): OrderIntent =>
  price === undefined
    ? { market: 'KR', symbol: '005930', side, type: 'MARKET', quantity }
    : {
        market: 'KR',
        symbol: '005930',
        side,
        type: 'LIMIT',
        quantity,
        limitPrice: price,
      };

describe('a market order', () => {
  it('fills at the opposite touch, not at the quoted price', () => {
    const result = exchange().submit(
      intent('BUY', '10'),
      tick('70000', { bid: '69900', ask: '70100' }),
    );

    expect(result).toMatchObject({ outcome: 'filled' });
    expect(result.outcome === 'filled' && result.fill).toMatchObject({
      price: '70100',
      quantity: '10',
      side: 'BUY',
      // 70100 × 10 × 0.001 = 701.
      fee: '701',
    });
  });

  it('sells at the bid', () => {
    const market = exchange();

    market.submit(intent('BUY', '10'), tick('70000', { ask: '70000' }));

    const result = market.submit(
      intent('SELL', '10'),
      tick('70500', { bid: '70400', ask: '70600' }, 1),
    );

    // 70400 × 10 = 704000; commission 704 + sell tax 1408 = 2112.
    expect(result.outcome === 'filled' && result.fill).toMatchObject({
      price: '70400',
      fee: '2112',
    });
  });

  it('falls back to the tick price when the book has no opposite touch', () => {
    const result = exchange().submit(intent('BUY', '10'), tick('70000'));

    expect(result.outcome === 'filled' && result.fill).toMatchObject({
      price: '70000',
    });
  });

  it('refuses an order the cash cannot pay for', () => {
    const result = exchange('1000').submit(
      intent('BUY', '10'),
      tick('70000', { ask: '70000' }),
    );

    expect(result).toMatchObject({
      outcome: 'rejected',
      code: 'INSUFFICIENT_CASH',
    });
  });

  it('refuses to sell more than the position holds', () => {
    const result = exchange().submit(
      intent('SELL', '10'),
      tick('70000', { bid: '70000' }),
    );

    expect(result).toMatchObject({
      outcome: 'rejected',
      code: 'INSUFFICIENT_AVAILABLE_POSITION',
    });
  });

  /**
   * §8.2 names exactly two fill rules, for a limit and for a market order.
   * A stop has a trigger the harness does not model, and silently never filling
   * one would report a strategy as safe because its protective order did
   * nothing.
   */
  it('refuses an order type it does not simulate rather than never filling it', () => {
    const result = exchange().submit(
      {
        market: 'KR',
        symbol: '005930',
        side: 'SELL',
        type: 'STOP',
        quantity: '10',
        stopPrice: '69000',
      },
      tick('70000', { bid: '70000' }),
    );

    expect(result).toMatchObject({
      outcome: 'rejected',
      code: 'UNSUPPORTED_ORDER_TYPE',
    });
  });
});

describe('a limit order', () => {
  it('rests until the price reaches it, then fills at the limit', () => {
    const market = exchange();
    const submitted = market.submit(
      intent('BUY', '10', '69000'),
      tick('70000', { ask: '70100' }),
    );

    expect(submitted).toMatchObject({ outcome: 'resting' });
    expect(market.match(tick('69500', { ask: '69600' }, 1))).toStrictEqual([]);

    const fills = market.match(tick('68900', { ask: '68950' }, 2));

    expect(fills).toHaveLength(1);
    // The touch was better than the limit; the harness does not claim price
    // improvement it cannot observe from a snapshot.
    expect(fills[0]).toMatchObject({ price: '69000', quantity: '10' });
    expect(market.portfolio().activeOrders).toStrictEqual([]);
  });

  it('fills immediately when the touch is already through the limit', () => {
    const result = exchange().submit(
      intent('BUY', '10', '70500'),
      tick('70000', { ask: '70100' }),
    );

    expect(result).toMatchObject({ outcome: 'filled' });
    expect(result.outcome === 'filled' && result.fill.price).toBe('70500');
  });

  it('reserves the cash it would spend, and releases it on a cancel', () => {
    const market = exchange('700000');
    const first = market.submit(
      intent('BUY', '10', '69000'),
      tick('70000', { ask: '70100' }),
    );

    // 69000 × 10 = 690000 of notional, plus the 690 commission the fill will
    // charge — the reservation is what the fill costs, not part of it.
    expect(market.portfolio().wallets).toStrictEqual([
      {
        currency: 'KRW',
        total: '700000',
        available: '9310',
        reserved: '690690',
      },
    ]);
    expect(
      market.submit(
        intent('BUY', '10', '68000'),
        tick('70000', { ask: '70100' }),
      ),
    ).toMatchObject({ outcome: 'rejected', code: 'INSUFFICIENT_CASH' });

    expect(
      market.cancel(first.outcome === 'resting' ? first.orderId : ''),
    ).toBe(true);
    expect(market.portfolio().wallets[0]).toMatchObject({
      available: '700000',
      reserved: '0',
    });
  });

  it('reserves the position a resting sell would deliver', () => {
    const market = exchange();

    market.submit(intent('BUY', '10'), tick('70000', { ask: '70000' }));
    market.submit(
      intent('SELL', '4', '71000'),
      tick('70000', { bid: '70000' }, 1),
    );

    expect(market.portfolio().positions[0]).toMatchObject({
      total: '10',
      available: '6',
      reserved: '4',
    });
  });

  /**
   * The case a Codex review found by running the code: a resting buy reserved
   * its notional and nothing else, so the fill — which also pays the fee —
   * took the wallet to `-690` with no refusal and no flag. A negative wallet is
   * the one thing this harness must never report, because the whole reason it
   * models cash at all is to answer "did the strategy have the money".
   *
   * The reservation is now what the fill will *cost*. That is exact rather than
   * conservative: a resting limit fills at its own limit price for its own
   * quantity in its own market, so the fee is fully determined at submit time —
   * the same `notional + fee` the immediate-fill path already checks. One rule,
   * both paths, and the failure is removed rather than detected.
   */
  it('refuses a resting buy that could not pay the fee when it fills', () => {
    // Exactly the notional and not a won more.
    const market = exchange('690000');
    const result = market.submit(
      intent('BUY', '10', '69000'),
      tick('70000', { ask: '70100' }),
    );

    expect(result).toMatchObject({
      outcome: 'rejected',
      code: 'INSUFFICIENT_CASH',
    });
    expect(market.portfolio().wallets[0]).toStrictEqual({
      currency: 'KRW',
      total: '690000',
      available: '690000',
      reserved: '0',
    });
  });

  it('spends a fully reserved buy down to exactly zero, never below', () => {
    // 690000 notional + 690 commission, to the won.
    const market = exchange('690690');

    expect(
      market.submit(
        intent('BUY', '10', '69000'),
        tick('70000', { ask: '70100' }),
      ),
    ).toMatchObject({ outcome: 'resting' });
    expect(market.portfolio().wallets[0]).toMatchObject({
      available: '0',
      reserved: '690690',
    });

    expect(market.match(tick('68900', { ask: '68950' }, 1))).toHaveLength(1);
    expect(market.portfolio().wallets[0]).toStrictEqual({
      currency: 'KRW',
      total: '0',
      available: '0',
      reserved: '0',
    });
  });

  /**
   * The guard behind the fix. Reserving the fill cost makes the resting-buy
   * path safe by construction, but "no wallet goes negative" is the invariant
   * this class claims, and an invariant that is only true by construction is
   * one a later change can quietly break. So a settlement that would take a
   * wallet below zero fails closed (AGENTS.md rule 6) rather than reporting the
   * negative balance — an aborted replay is a message, a negative wallet is a
   * report nobody can tell is wrong.
   */
  it('fails closed rather than settling a wallet below zero', () => {
    const market = new SimulatedExchange({
      fees: [{ ...(FEES[0] as FeeScheduleConfig), sellTaxRate: '2' }],
      cash: [{ currency: 'KRW', amount: '700700' }],
    });

    market.submit(intent('BUY', '10'), tick('70000', { ask: '70000' }));

    expect(market.portfolio().wallets[0]).toMatchObject({ available: '0' });
    expect(() =>
      market.submit(intent('SELL', '10'), tick('70000', { bid: '70000' }, 1)),
    ).toThrow(/below zero|negative/u);
  });

  it('lists a resting order as open so the risk gate can count it', () => {
    const market = exchange();

    market.submit(
      intent('BUY', '10', '69000'),
      tick('70000', { ask: '70100' }),
    );

    expect(market.portfolio().activeOrders).toHaveLength(1);
    expect(market.portfolio().activeOrders[0]).toMatchObject({
      status: 'OPEN',
      type: 'LIMIT',
      side: 'BUY',
      quantity: '10',
      filledQuantity: '0',
      limitPrice: '69000',
    });
  });
});

describe('the simulated account', () => {
  it('tracks exact average cost and realised PnL across a round trip', () => {
    const market = exchange();

    market.submit(intent('BUY', '10'), tick('70000', { ask: '70000' }));
    market.submit(intent('BUY', '10'), tick('72000', { ask: '72000' }, 1));

    // (700000 + 700) + (720000 + 720) = 1421420 over 20 = 71071.
    expect(market.portfolio().positions[0]).toMatchObject({
      total: '20',
      averageCost: '71071',
    });

    market.submit(intent('SELL', '20'), tick('75000', { bid: '75000' }, 2));

    // 1500000 proceeds, fee 1500 + 3000 = 4500, cost 1421420.
    expect(market.realisedPnl('KR:005930')).toBe('74080');
    expect(market.portfolio().positions).toStrictEqual([]);
  });

  it('keeps the cash the fills actually moved', () => {
    const market = exchange();

    market.submit(intent('BUY', '10'), tick('70000', { ask: '70000' }));

    // 10000000 − 700000 − 700.
    expect(market.portfolio().wallets[0]).toMatchObject({
      available: '9299300',
      total: '9299300',
    });
  });

  it('totals the fees it charged, per currency', () => {
    const market = exchange();

    market.submit(intent('BUY', '10'), tick('70000', { ask: '70000' }));
    market.submit(intent('SELL', '10'), tick('70000', { bid: '70000' }, 1));

    // 700 on the buy; 700 + 1400 on the sell.
    expect(market.feesPaid()).toStrictEqual([
      { currency: 'KRW', amount: '2800' },
    ]);
  });

  it('refuses to trade a market it has no fee schedule for', () => {
    expect(() =>
      exchange().submit(
        {
          market: 'US',
          symbol: 'AAPL',
          side: 'BUY',
          type: 'MARKET',
          quantity: '1',
        },
        { ...tick('100', { ask: '100' }), market: 'US', symbol: 'AAPL' },
      ),
    ).toThrow(/fee schedule/u);
  });
});
