import { describe, expect, it } from 'vitest';
import {
  mapOrderDraft,
  type OrderDraft,
  validateOrderDraft,
} from './order-form';

describe('order form model', () => {
  it('maps each discriminated draft to the server request without UI-only fields', () => {
    const cases: readonly [OrderDraft, Record<string, unknown>][] = [
      [
        { kind: 'MARKET', side: 'BUY', quantity: '2' },
        { type: 'MARKET', side: 'BUY', quantity: '2' },
      ],
      [
        { kind: 'LIMIT', side: 'SELL', quantity: '2', limitPrice: '10' },
        { type: 'LIMIT', side: 'SELL', quantity: '2', limitPrice: '10' },
      ],
      [
        { kind: 'STOP', side: 'BUY', quantity: '2', stopPrice: '10' },
        { type: 'STOP', side: 'BUY', quantity: '2', stopPrice: '10' },
      ],
      [
        {
          kind: 'TAKE_PROFIT',
          side: 'SELL',
          quantity: '2',
          triggerPrice: '10',
        },
        { type: 'TAKE_PROFIT', side: 'SELL', quantity: '2', stopPrice: '10' },
      ],
      [
        {
          kind: 'OCO',
          side: 'SELL',
          quantity: '2',
          takeProfitPrice: '12',
          stopPrice: '10',
        },
        {
          type: 'OCO',
          side: 'SELL',
          quantity: '2',
          legs: [
            { type: 'LIMIT', side: 'SELL', quantity: '2', limitPrice: '12' },
            { type: 'STOP', side: 'SELL', quantity: '2', stopPrice: '10' },
          ],
        },
      ],
    ];
    for (const [draft, expected] of cases)
      expect(mapOrderDraft(draft)).toEqual(expected);
  });

  it.each([
    ['zero', { kind: 'MARKET', side: 'BUY', quantity: '0' }],
    ['negative', { kind: 'MARKET', side: 'BUY', quantity: '-1' }],
    ['exponent', { kind: 'MARKET', side: 'BUY', quantity: '1e2' }],
    ['fractional', { kind: 'MARKET', side: 'BUY', quantity: '1.2' }],
    [
      'missing conditional',
      { kind: 'LIMIT', side: 'BUY', quantity: '1', limitPrice: '' },
    ],
    [
      'identical OCO triggers',
      {
        kind: 'OCO',
        side: 'SELL',
        quantity: '1',
        takeProfitPrice: '10',
        stopPrice: '10',
      },
    ],
  ] as const)('rejects %s', (_name, draft) => {
    expect(
      Object.keys(validateOrderDraft(draft as OrderDraft)).length,
    ).toBeGreaterThan(0);
  });
});
