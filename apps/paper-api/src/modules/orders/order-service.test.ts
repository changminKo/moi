import { DomainError } from '@moi/trading-core';
import { describe, expect, it, vi } from 'vitest';
import { OrderService } from './order-service.js';

const marketOrder = {
  market: 'KR' as const,
  symbol: '005930',
  side: 'BUY' as const,
  quantity: '1',
  type: 'MARKET' as const,
};

describe('OrderService MARKET gate against the calendar', () => {
  it('rejects a MARKET order the calendar reports as closed', async () => {
    const service = new OrderService({
      calendar: { get: async () => ({ session: 'CLOSED' as const }) },
    });

    await expect(service.place('session-1', marketOrder)).rejects.toMatchObject(
      {
        code: 'MARKET_CLOSED',
      },
    );
  });

  it('lets a calendar failure through instead of calling it a closed market (#122)', async () => {
    // A provider answer the decoder cannot read must not read as a holiday.
    // The rejection leaves `place` unchanged and the error handler answers 500
    // INTERNAL_ERROR, which is a visible fault rather than a plausible lie.
    const failure = new Error('Invalid Toss calendar response: result');
    const execute = vi.fn();
    const service = new OrderService({
      calendar: {
        get: async () => {
          throw failure;
        },
      },
      execute,
    });

    await expect(service.place('session-1', marketOrder)).rejects.toBe(failure);

    expect(execute).not.toHaveBeenCalled();
  });

  it('never consults the calendar for a LIMIT order', async () => {
    const get = vi.fn(async () => ({ session: 'CLOSED' as const }));
    const service = new OrderService({ calendar: { get } });

    const order = await service.place('session-1', {
      ...marketOrder,
      type: 'LIMIT',
      limitPrice: '70000',
    });

    expect(order).toMatchObject({ status: 'OPEN' });
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps the whitelist refusal ahead of the calendar', async () => {
    const get = vi.fn(async () => ({ session: 'REGULAR' as const }));
    const service = new OrderService({
      whitelist: { isTradable: () => false },
      calendar: { get },
    });

    await expect(
      service.place('session-1', marketOrder),
    ).rejects.toBeInstanceOf(DomainError);
    expect(get).not.toHaveBeenCalled();
  });
});
