import { describe, expect, it } from 'vitest';

import type { PositionSnapshot, WalletSnapshot } from './reservation.js';
import {
  planOcoReservation,
  planReservation,
  releaseReservation,
  reserveCash,
  reservePosition,
} from './reservation.js';

const walletFixture = (
  overrides: Partial<WalletSnapshot> = {},
): WalletSnapshot => ({
  currency: 'KRW',
  total: '1000',
  available: '1000',
  reserved: '0',
  version: 3n,
  ...overrides,
});

const positionFixture = (
  overrides: Partial<PositionSnapshot> = {},
): PositionSnapshot => ({
  symbol: '005930',
  total: '10',
  available: '10',
  reserved: '0',
  version: 6n,
  ...overrides,
});

describe('cash reservations', () => {
  it('moves cash from available to reserved without changing total', () => {
    const wallet = walletFixture();

    expect(reserveCash(wallet, '250')).toEqual({
      ...wallet,
      available: '750',
      reserved: '250',
      version: 4n,
    });
  });

  it('rejects two orders that spend the same available cash', () => {
    const once = reserveCash(walletFixture(), '800');

    expect(() => reserveCash(once, '300')).toThrowError(
      expect.objectContaining({
        code: 'INSUFFICIENT_AVAILABLE_CASH',
        retryable: false,
      }),
    );
  });

  it('releases only the unused cash after a partial execution', () => {
    const reserved = reserveCash(walletFixture(), '1000');

    expect(releaseReservation(reserved, '400')).toEqual({
      ...reserved,
      available: '400',
      reserved: '600',
      version: 5n,
    });
  });
});

describe('position reservations', () => {
  it('moves shares from available to reserved without changing total', () => {
    const position = positionFixture();

    expect(reservePosition(position, '4')).toEqual({
      ...position,
      available: '6',
      reserved: '4',
      version: 7n,
    });
  });

  it('rejects a sell reservation that exceeds available shares', () => {
    expect(() => reservePosition(positionFixture(), '11')).toThrowError(
      expect.objectContaining({
        code: 'INSUFFICIENT_AVAILABLE_POSITION',
        retryable: false,
      }),
    );
  });

  it('releases shares for cancellation without changing another symbol', () => {
    const samsung = reservePosition(positionFixture(), '4');
    const skHynix = positionFixture({
      symbol: '000660',
      total: '8',
      available: '8',
    });

    expect(releaseReservation(samsung, '4')).toEqual({
      ...samsung,
      available: '10',
      reserved: '0',
      version: 8n,
    });
    expect(skHynix).toEqual(
      positionFixture({ symbol: '000660', total: '8', available: '8' }),
    );
  });
});

describe('reservation planning', () => {
  it('reserves remaining limit-buy notional plus the estimated fee', () => {
    expect(
      planReservation({
        id: 'buy-limit',
        status: 'PARTIALLY_FILLED',
        side: 'BUY',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '10',
        filledQuantity: '3',
        limitPrice: '70000',
        estimatedFee: '140',
      }),
    ).toEqual({ cash: { currency: 'KRW', amount: '490140' } });
  });

  it('uses the five-percent protected reference price for a market buy', () => {
    expect(
      planReservation({
        id: 'buy-market',
        status: 'OPEN',
        side: 'BUY',
        type: 'MARKET',
        currency: 'USD',
        symbol: 'AAPL',
        quantity: '2',
        referencePrice: '193.20',
        estimatedFee: '1.50',
      }),
    ).toEqual({ cash: { currency: 'USD', amount: '407.22' } });
  });

  it('reserves only the remaining shares for a sell order', () => {
    expect(
      planReservation({
        id: 'sell',
        status: 'PARTIALLY_FILLED',
        side: 'SELL',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '10',
        filledQuantity: '3',
        limitPrice: '71000',
      }),
    ).toEqual({ position: { symbol: '005930', quantity: '7' } });
  });

  it('releases the full cash reservation after the final buy fill', () => {
    expect(
      planReservation({
        id: 'filled-buy',
        status: 'FILLED',
        side: 'BUY',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '10',
        filledQuantity: '10',
        limitPrice: '70000',
        estimatedFee: '140',
      }),
    ).toEqual({ cash: { currency: 'KRW', amount: '0' } });
  });

  it('uses one maximum cash exposure for two OCO buy legs', () => {
    expect(
      planOcoReservation([
        {
          id: 'oco-stop',
          status: 'PENDING_TRIGGER',
          side: 'BUY',
          type: 'STOP',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          referencePrice: '200',
          estimatedFee: '1',
        },
        {
          id: 'oco-limit',
          status: 'PENDING_TRIGGER',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          limitPrice: '190',
          estimatedFee: '2',
        },
      ]),
    ).toEqual({ cash: { currency: 'USD', amount: '421' } });
  });

  it('uses one shared quantity for two OCO sell legs', () => {
    expect(
      planOcoReservation([
        {
          id: 'oco-stop',
          status: 'PENDING_TRIGGER',
          side: 'SELL',
          type: 'STOP',
          currency: 'KRW',
          symbol: '005930',
          quantity: '10',
          filledQuantity: '2',
          referencePrice: '70000',
        },
        {
          id: 'oco-limit',
          status: 'PENDING_TRIGGER',
          side: 'SELL',
          type: 'TAKE_PROFIT',
          currency: 'KRW',
          symbol: '005930',
          quantity: '10',
          limitPrice: '75000',
        },
      ]),
    ).toEqual({ position: { symbol: '005930', quantity: '10' } });
  });

  it('rejects an OCO plan that mixes currencies or symbols', () => {
    expect(() =>
      planOcoReservation([
        {
          id: 'first',
          status: 'PENDING_TRIGGER',
          side: 'SELL',
          type: 'STOP',
          currency: 'KRW',
          symbol: '005930',
          quantity: '1',
          referencePrice: '70000',
        },
        {
          id: 'second',
          status: 'PENDING_TRIGGER',
          side: 'SELL',
          type: 'TAKE_PROFIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '1',
          limitPrice: '190',
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });
});
