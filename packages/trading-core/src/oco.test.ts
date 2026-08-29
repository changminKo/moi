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
    const triggeredWinner = leg('stop-leg', {
      status: 'TRIGGERED',
      version: 3n,
    });
    const once = resolveOco(
      ocoFixture({ legs: [triggeredWinner, leg('take-profit-leg')] }),
      'stop-leg',
    );

    expect(once).toEqual({
      id: 'oco-1',
      status: 'RESOLVED',
      winnerLegId: 'stop-leg',
      legs: [
        triggeredWinner,
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
      filledQuantity: '2',
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

  it('resolves a progressed second leg while cancelling the first pending leg', () => {
    const progressedWinner = leg('take-profit-leg', {
      status: 'OPEN',
      version: 6n,
    });
    const result = resolveOco(
      ocoFixture({ legs: [leg('stop-leg'), progressedWinner] }),
      'take-profit-leg',
    );

    expect(result.legs).toEqual([
      { ...leg('stop-leg'), status: 'CANCELLED', version: 2n },
      progressedWinner,
    ]);
    expect(result.winnerLegId).toBe('take-profit-leg');
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

  it('rejects duplicate leg identifiers', () => {
    expect(() =>
      resolveOco(
        ocoFixture({ legs: [leg('same-leg'), leg('same-leg')] }),
        'same-leg',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it.each(['RECEIVED', 'CANCELLED', 'EXPIRED', 'REJECTED'] as const)(
    'rejects %s sibling state in an active group',
    (siblingStatus) => {
      expect(() =>
        resolveOco(
          ocoFixture({
            legs: [
              leg('stop-leg', { status: 'TRIGGERED' }),
              leg('take-profit-leg', { status: siblingStatus }),
            ],
          }),
          'stop-leg',
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );

  it.each([
    {
      name: 'first requested winner with a partially filled second sibling',
      winnerLegId: 'stop-leg',
      legs: [
        leg('stop-leg', { status: 'TRIGGERED' }),
        leg('take-profit-leg', {
          status: 'PARTIALLY_FILLED',
          filledQuantity: '2',
        }),
      ],
    },
    {
      name: 'second requested winner with an open first sibling',
      winnerLegId: 'take-profit-leg',
      legs: [
        leg('stop-leg', { status: 'OPEN' }),
        leg('take-profit-leg', { status: 'TRIGGERED' }),
      ],
    },
    {
      name: 'both legs carrying fill progress',
      winnerLegId: 'stop-leg',
      legs: [
        leg('stop-leg', { status: 'FILLED', filledQuantity: '5' }),
        leg('take-profit-leg', {
          status: 'PARTIALLY_FILLED',
          filledQuantity: '2',
        }),
      ],
    },
    {
      name: 'a pending first winner while the second leg has progressed',
      winnerLegId: 'stop-leg',
      legs: [
        leg('stop-leg'),
        leg('take-profit-leg', {
          status: 'PARTIALLY_FILLED',
          filledQuantity: '2',
        }),
      ],
    },
    {
      name: 'a pending second winner while the first leg has progressed',
      winnerLegId: 'take-profit-leg',
      legs: [leg('stop-leg', { status: 'TRIGGERED' }), leg('take-profit-leg')],
    },
  ] as const)('rejects $name', ({ winnerLegId, legs }) => {
    expect(() => resolveOco(ocoFixture({ legs }), winnerLegId)).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it('rejects fill progress on a still-pending sibling', () => {
    expect(() =>
      resolveOco(
        ocoFixture({
          legs: [
            leg('stop-leg', { status: 'TRIGGERED' }),
            leg('take-profit-leg', {
              filledQuantity: '1',
            }),
          ],
        }),
        'stop-leg',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });
});
