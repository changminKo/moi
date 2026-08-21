import { describe, expect, it } from 'vitest';
import { type OcoGroupSnapshot, resolveOco } from './oco.js';
import type { OrderSnapshot } from './order.js';

const leg = (
  id: string,
  overrides: Partial<OrderSnapshot> = {},
): OrderSnapshot => ({
  id,
  status: 'PENDING_TRIGGER',
  version: 1n,
  ...overrides,
});

const ocoFixture = (
  overrides: Partial<OcoGroupSnapshot> = {},
): OcoGroupSnapshot => ({
  id: 'oco-1',
  status: 'ACTIVE',
  legs: [leg('stop-leg'), leg('take-profit-leg')],
  version: 3n,
  ...overrides,
});

describe('resolveOco', () => {
  it('resolves exactly one OCO winner and cancels its sibling', () => {
    const once = resolveOco(ocoFixture(), 'stop-leg');

    expect(once).toEqual({
      id: 'oco-1',
      status: 'RESOLVED',
      winnerLegId: 'stop-leg',
      legs: [
        leg('stop-leg'),
        { ...leg('take-profit-leg'), status: 'CANCELLED', version: 2n },
      ],
      version: 4n,
    });
    expect(() => resolveOco(once, 'take-profit-leg')).toThrowError(
      expect.objectContaining({
        code: 'ORDER_STATE_CONFLICT',
        retryable: false,
      }),
    );
  });

  it('preserves a partially filled winner while cancelling the sibling', () => {
    const partialWinner = leg('stop-leg', {
      status: 'PARTIALLY_FILLED',
      version: 8n,
    });
    const group = ocoFixture({ legs: [partialWinner, leg('take-profit-leg')] });

    const result = resolveOco(group, 'stop-leg');

    expect(result.legs[0]).toEqual(partialWinner);
    expect(result.legs[1]).toMatchObject({
      id: 'take-profit-leg',
      status: 'CANCELLED',
      version: 2n,
    });
    expect(result.winnerLegId).toBe('stop-leg');
  });

  it('rejects a winner that is not a group leg', () => {
    expect(() => resolveOco(ocoFixture(), 'unknown-leg')).toThrowError(
      expect.objectContaining({
        code: 'ORDER_STATE_CONFLICT',
        retryable: false,
      }),
    );
  });

  it('rejects resolution outside the active state', () => {
    expect(() =>
      resolveOco(
        ocoFixture({ status: 'RESOLVED', winnerLegId: 'stop-leg' }),
        'take-profit-leg',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'ORDER_STATE_CONFLICT',
        retryable: false,
      }),
    );
  });

  it('rejects an active group that already records a winner', () => {
    expect(() =>
      resolveOco(ocoFixture({ winnerLegId: 'stop-leg' }), 'take-profit-leg'),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it.each(['CANCELLED', 'EXPIRED', 'REJECTED'] as const)(
    'rejects %s leg as the OCO winner',
    (status) => {
      expect(() =>
        resolveOco(
          ocoFixture({
            legs: [leg('stop-leg', { status }), leg('take-profit-leg')],
          }),
          'stop-leg',
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'ORDER_STATE_CONFLICT',
          retryable: false,
        }),
      );
    },
  );
});
