import { describe, expect, it } from 'vitest';
import { planSettlement } from './fill-settlement.js';

const wallet = { total: '1000', available: '700', reserved: '300' };

describe('planSettlement', () => {
  it('consumes the fill out of the reservation first and keeps the rest reserved', () => {
    const plan = planSettlement(
      {
        balances: wallet,
        reservationRemaining: '300',
        consumed: '120',
        terminal: false,
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    expect(plan).toEqual({
      balances: { total: '880', available: '700', reserved: '180' },
      reservationRemaining: '180',
      released: false,
    });
  });

  it('releases the unused reservation back to available on a terminal fill', () => {
    const plan = planSettlement(
      {
        balances: wallet,
        reservationRemaining: '300',
        consumed: '120',
        terminal: true,
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    expect(plan).toEqual({
      balances: { total: '880', available: '880', reserved: '0' },
      reservationRemaining: '0',
      released: true,
    });
  });

  it('draws any shortfall beyond the reservation from available', () => {
    const plan = planSettlement(
      {
        balances: wallet,
        reservationRemaining: '100',
        consumed: '150',
        terminal: true,
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    expect(plan.balances).toEqual({
      total: '850',
      available: '650',
      reserved: '200',
    });
    expect(plan.released).toBe(true);
  });

  it('settles legacy orders without a reservation out of available alone', () => {
    const plan = planSettlement(
      {
        balances: wallet,
        reservationRemaining: '0',
        consumed: '50',
        terminal: false,
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    expect(plan.balances).toEqual({
      total: '950',
      available: '650',
      reserved: '300',
    });
  });

  it('fails closed with the caller code when available cannot cover the shortfall', () => {
    expect(() =>
      planSettlement(
        {
          balances: wallet,
          reservationRemaining: '0',
          consumed: '701',
          terminal: false,
        },
        'INSUFFICIENT_AVAILABLE_POSITION',
      ),
    ).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_AVAILABLE_POSITION' }),
    );
  });

  it('refuses a reservation larger than the reserved balance as an invariant violation', () => {
    expect(() =>
      planSettlement(
        {
          balances: wallet,
          reservationRemaining: '400',
          consumed: '10',
          terminal: true,
        },
        'INSUFFICIENT_AVAILABLE_CASH',
      ),
    ).toThrow(expect.objectContaining({ code: 'INVARIANT_VIOLATION' }));
  });

  it('rejects a negative consumption', () => {
    expect(() =>
      planSettlement(
        {
          balances: wallet,
          reservationRemaining: '0',
          consumed: '-1',
          terminal: false,
        },
        'INSUFFICIENT_AVAILABLE_CASH',
      ),
    ).toThrow(expect.objectContaining({ code: 'INVARIANT_VIOLATION' }));
  });

  it('keeps exact money beyond 20 significant digits', () => {
    const plan = planSettlement(
      {
        balances: {
          total: '100000000000000000000.01',
          available: '100000000000000000000.01',
          reserved: '0',
        },
        reservationRemaining: '0',
        consumed: '0.02',
        terminal: false,
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    expect(plan.balances.total).toBe('99999999999999999999.99');
    expect(plan.balances.available).toBe('99999999999999999999.99');
  });

  it('hands back reservation above the remaining exposure after a price-improved partial fill', () => {
    // LIMIT BUY 10 @ 100 reserved 1000; 5 filled @ 90 cost 450; remaining
    // exposure is 5 × 100 = 500, so 50 of the 550 left goes back.
    const plan = planSettlement(
      {
        balances: { total: '5000', available: '4000', reserved: '1000' },
        reservationRemaining: '1000',
        consumed: '450',
        terminal: false,
        desiredRemaining: '500',
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    expect(plan).toEqual({
      balances: { total: '4550', available: '4050', reserved: '500' },
      reservationRemaining: '500',
      released: false,
    });
  });

  it('never grows the reservation when the remaining exposure exceeds what is left', () => {
    const plan = planSettlement(
      {
        balances: { total: '5000', available: '4000', reserved: '1000' },
        reservationRemaining: '1000',
        consumed: '600',
        terminal: false,
        desiredRemaining: '900',
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    expect(plan.balances).toEqual({
      total: '4400',
      available: '4000',
      reserved: '400',
    });
    expect(plan.reservationRemaining).toBe('400');
  });
});
