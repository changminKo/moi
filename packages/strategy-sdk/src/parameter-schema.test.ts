import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';

import {
  defineParameterSchema,
  enumParameter,
  integerParameter,
  quantityParameter,
  symbolParameter,
} from './parameter-schema.js';

const schema = defineParameterSchema({
  market: enumParameter(['KR', 'US']),
  symbol: symbolParameter(),
  fastPeriod: integerParameter({ min: 1, max: 512 }),
  quantity: quantityParameter(),
});

const valid = {
  market: 'KR',
  symbol: '005930',
  fastPeriod: 5,
  quantity: '10',
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

describe('defineParameterSchema', () => {
  it('parses a declared record into a frozen typed value', () => {
    const params = schema.parse({ ...valid });

    expect(params).toStrictEqual(valid);
    expect(Object.isFrozen(params)).toBe(true);
  });

  it('describes its fields in declaration order', () => {
    expect(schema.fieldNames).toStrictEqual([
      'market',
      'symbol',
      'fastPeriod',
      'quantity',
    ]);
    expect(schema.describe().map((field) => field.name)).toStrictEqual([
      'market',
      'symbol',
      'fastPeriod',
      'quantity',
    ]);
    expect(schema.describe()[2]).toStrictEqual({
      name: 'fastPeriod',
      kind: 'integer',
      constraint: 'a whole number from 1 to 512',
    });
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['a string', 'market=KR'],
    ['an array', [] as unknown],
  ])('refuses %s in place of a parameter record', (_label, input) => {
    expectDomainError(
      () => schema.parse(input),
      'INVALID_ORDER',
      /strategy parameters must be an object/u,
    );
  });

  it('refuses a key the schema does not declare, naming it', () => {
    expectDomainError(
      () => schema.parse({ ...valid, slowPeriod: 20, typo: true }),
      'INVALID_ORDER',
      /unknown strategy parameters: slowPeriod, typo/u,
    );
  });

  it('refuses a declared key that is missing', () => {
    const { symbol: _omitted, ...withoutSymbol } = valid;

    expectDomainError(
      () => schema.parse(withoutSymbol),
      'INVALID_ORDER',
      /symbol is required/u,
    );
  });

  // Parameters arrive as decoded JSON or as an object literal, never as a class
  // or a proxy, so presence here is own-key presence — unlike the
  // prototype-inclusive command policy in `validation.ts`. A polluted prototype
  // must therefore not be able to supply a parameter nobody wrote down.
  it('does not accept a parameter supplied by Object.prototype', () => {
    Object.defineProperty(Object.prototype, 'symbol', {
      configurable: true,
      value: '005930',
      writable: true,
    });

    try {
      const { symbol: _omitted, ...withoutSymbol } = valid;

      expectDomainError(
        () => schema.parse(withoutSymbol),
        'INVALID_ORDER',
        /symbol is required/u,
      );
    } finally {
      Reflect.deleteProperty(Object.prototype, 'symbol');
    }
  });

  it('reads every declared field exactly once', () => {
    const reads: string[] = [];
    const spy = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(valid).map(([name, value]) => [
          name,
          {
            enumerable: true,
            get: () => {
              reads.push(name);

              return value;
            },
          },
        ]),
      ),
    );

    expect(schema.parse(spy)).toStrictEqual(valid);
    expect(reads).toStrictEqual(['market', 'symbol', 'fastPeriod', 'quantity']);
  });

  it('runs a refinement after every field is read, and propagates its error', () => {
    const seen: unknown[] = [];
    const refined = defineParameterSchema(
      {
        fastPeriod: integerParameter({ min: 1, max: 512 }),
        slowPeriod: integerParameter({ min: 1, max: 512 }),
      },
      (params) => {
        seen.push(params);

        if (params.fastPeriod >= params.slowPeriod) {
          throw new DomainError(
            'INVALID_ORDER',
            'fastPeriod must be shorter than slowPeriod',
          );
        }
      },
    );

    expect(refined.parse({ fastPeriod: 5, slowPeriod: 20 })).toStrictEqual({
      fastPeriod: 5,
      slowPeriod: 20,
    });
    expect(seen).toStrictEqual([{ fastPeriod: 5, slowPeriod: 20 }]);

    expectDomainError(
      () => refined.parse({ fastPeriod: 20, slowPeriod: 5 }),
      'INVALID_ORDER',
      /fastPeriod must be shorter than slowPeriod/u,
    );
  });
});

describe('integerParameter', () => {
  it.each([
    ['a numeric string', '5'],
    ['a fraction', 5.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 5n],
    ['below the minimum', 0],
    ['above the maximum', 513],
  ])('refuses %s', (_label, fastPeriod) => {
    expectDomainError(
      () => schema.parse({ ...valid, fastPeriod }),
      'INVALID_ORDER',
      /fastPeriod must be a whole number from 1 to 512/u,
    );
  });

  it.each([1, 2, 512])('accepts %i', (fastPeriod) => {
    expect(schema.parse({ ...valid, fastPeriod }).fastPeriod).toBe(fastPeriod);
  });
});

describe('enumParameter', () => {
  it.each([
    ['a member of no list', 'JP'],
    ['a lowercase member', 'kr'],
    ['a prototype member', 'toString'],
    ['a non-string', 1],
  ])('refuses %s', (_label, market) => {
    expectDomainError(
      () => schema.parse({ ...valid, market }),
      'INVALID_ORDER',
      /market must be one of KR, US/u,
    );
  });
});

describe('symbolParameter', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a control character', 'AAP\nL'],
    ['a non-string', 5],
    ['an over-long identifier', 'A'.repeat(201)],
  ])('refuses %s', (_label, symbol) => {
    expectDomainError(
      () => schema.parse({ ...valid, symbol }),
      'INVALID_ORDER',
      /symbol must be a non-empty identifier/u,
    );
  });
});

describe('quantityParameter', () => {
  it.each([
    ['zero', '0'],
    ['a fraction', '1.5'],
    ['exponent notation', '1e3'],
    ['a signed value', '+1'],
    ['a leading zero', '007'],
    ['a JS number', 10],
    ['a negative value', '-1'],
  ])('refuses %s', (_label, quantity) => {
    expectDomainError(
      () => schema.parse({ ...valid, quantity }),
      'INVALID_QUANTITY',
      /quantity must be a positive whole number in plain decimal form/u,
    );
  });

  it('accepts a plain positive whole decimal string', () => {
    expect(schema.parse({ ...valid, quantity: '1' }).quantity).toBe('1');
  });
});
