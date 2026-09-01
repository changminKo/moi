import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';

import { readPlaceOrderCommand } from './broker.js';
import {
  type OrderIntent,
  type PlaceDecision,
  readOrderIntent,
  readStrategyDecisions,
} from './strategy.js';

const intent = {
  market: 'KR',
  symbol: '005930',
  side: 'BUY',
  type: 'LIMIT',
  quantity: '10',
  limitPrice: '71000',
} as const;

const expectDomainError = (act: () => unknown, code: string, match: RegExp) => {
  expect(act).toThrow(DomainError);
  expect(act).toThrow(match);

  try {
    act();
  } catch (error) {
    expect((error as DomainError).code).toBe(code);
  }
};

describe('readOrderIntent', () => {
  it('returns a snapshot carrying only the instruction fields', () => {
    const read = readOrderIntent({ ...intent });

    // Spread, because the reader returns a prototype-free snapshot — the same
    // discipline, for the same reason, as `readPlaceOrderCommand`.
    expect({ ...read }).toStrictEqual(intent);
    expect(Object.keys(read)).toStrictEqual([
      'market',
      'symbol',
      'side',
      'type',
      'quantity',
      'limitPrice',
    ]);
  });

  // §6.2: the gateway derives the idempotency key from the decision it stored,
  // so an intent that names a session or a key is a strategy that misunderstood
  // the contract. The snapshot's fixed field list is what actually keeps either
  // off the wire; this rejection is the diagnostic that says so out loud.
  it.each(['sessionId', 'idempotencyKey'])(
    'refuses an intent carrying %s',
    (field) => {
      expectDomainError(
        () => readOrderIntent({ ...intent, [field]: 'sess_1' }),
        'INVALID_ORDER',
        new RegExp(`an order intent cannot carry ${field}`, 'u'),
      );
    },
  );

  it('applies the same price rules as a place-order command', () => {
    expectDomainError(
      () => readOrderIntent({ ...intent, type: 'MARKET' }),
      'INVALID_ORDER',
      /a MARKET order cannot carry limitPrice/u,
    );
    expectDomainError(
      () =>
        readOrderIntent({
          market: 'KR',
          symbol: '005930',
          side: 'BUY',
          type: 'LIMIT',
          quantity: '10',
        }),
      'INVALID_ORDER',
      /a LIMIT order requires limitPrice/u,
    );
    expectDomainError(
      () => readOrderIntent({ ...intent, quantity: '1.5' }),
      'INVALID_QUANTITY',
      /quantity must be a positive whole number/u,
    );
    expectDomainError(
      () => readOrderIntent({ ...intent, market: 'JP' }),
      'INVALID_ORDER',
      /market must be one of KR, US/u,
    );
  });

  it('is exactly a place-order command minus the two gateway fields', () => {
    const command = readPlaceOrderCommand({
      ...intent,
      sessionId: 'sess_1',
      idempotencyKey: 'key_1',
    });
    const {
      sessionId: _session,
      idempotencyKey: _key,
      ...instruction
    } = command;

    expect({ ...readOrderIntent({ ...intent }) }).toStrictEqual({
      ...instruction,
    });
  });

  it('reads every field exactly once, so a proxy cannot answer twice', () => {
    const reads: string[] = [];
    const proxied = new Proxy(
      { ...intent },
      {
        get: (target, field, receiver) => {
          if (typeof field === 'string') {
            reads.push(field);
          }

          return Reflect.get(target, field, receiver);
        },
      },
    );

    expect({ ...readOrderIntent(proxied) }).toStrictEqual(intent);
    expect(reads.filter((field) => field === 'limitPrice')).toHaveLength(1);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it.each([
    ['null', null],
    ['a string', 'BUY 10'],
    ['an array', [] as unknown],
  ])('refuses %s in place of an intent', (_label, value) => {
    expectDomainError(
      () => readOrderIntent(value),
      'INVALID_ORDER',
      /an order intent must be an object/u,
    );
  });
});

describe('readStrategyDecisions', () => {
  it('accepts the three decision kinds and snapshots the list', () => {
    const source = [
      { kind: 'noop', reason: 'warming-up' },
      { kind: 'place', intent: { ...intent }, reason: 'golden-cross' },
      { kind: 'cancel', orderId: 'ord_1', reason: 'dead-cross' },
    ];
    const read = readStrategyDecisions(source);

    source.length = 0;

    expect(read).toHaveLength(3);
    expect(Object.isFrozen(read)).toBe(true);
    expect(read[0]).toStrictEqual({ kind: 'noop', reason: 'warming-up' });
    expect(read[1]).toStrictEqual({
      kind: 'place',
      intent: expect.objectContaining({ ...intent }),
      reason: 'golden-cross',
    });
    expect(Object.keys((read[1] as PlaceDecision).intent)).toStrictEqual([
      'market',
      'symbol',
      'side',
      'type',
      'quantity',
      'limitPrice',
    ]);
    expect(read[2]).toStrictEqual({
      kind: 'cancel',
      orderId: 'ord_1',
      reason: 'dead-cross',
    });
  });

  it('accepts a noop with no reason and an empty decision list', () => {
    expect(readStrategyDecisions([{ kind: 'noop' }])).toStrictEqual([
      { kind: 'noop' },
    ]);
    expect(readStrategyDecisions([])).toStrictEqual([]);
  });

  it.each([
    ['a non-array', { kind: 'noop' }, /strategy decisions must be an array/u],
    [
      'an unknown kind',
      [{ kind: 'buy' }],
      /kind must be one of noop, place, cancel/u,
    ],
    [
      'a place with no reason',
      [{ kind: 'place', intent }],
      /reason must be a non-empty identifier/u,
    ],
    [
      'a cancel with no order',
      [{ kind: 'cancel', reason: 'x' }],
      /orderId must be a non-empty identifier/u,
    ],
    [
      'a noop with a blank reason',
      [{ kind: 'noop', reason: '  ' }],
      /reason must be a non-empty identifier/u,
    ],
    [
      'a place with no intent',
      [{ kind: 'place', reason: 'x' }],
      /an order intent must be an object/u,
    ],
  ])('refuses %s', (_label, value, match) => {
    expectDomainError(
      () => readStrategyDecisions(value),
      'INVALID_ORDER',
      match,
    );
  });
});

describe('OrderIntent', () => {
  it('keeps the discrimination that makes an impossible order a compile error', () => {
    // @ts-expect-error a MARKET intent cannot carry a limit price
    const impossible: OrderIntent = { ...intent, type: 'MARKET' };
    // @ts-expect-error a LIMIT intent cannot omit its limit price
    const priceless: OrderIntent = {
      market: 'KR',
      symbol: 'A',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '1',
    };
    // @ts-expect-error an intent carries no session
    const scoped: OrderIntent = { ...intent, sessionId: 'sess_1' };

    expect([impossible, priceless, scoped]).toHaveLength(3);
  });
});
