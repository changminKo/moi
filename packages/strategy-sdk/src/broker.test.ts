import {
  createFeeModel,
  DomainError,
  type OrderType,
  planOcoReservation,
  planReservation,
  type ReservationOrder,
} from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import {
  assertPlaceOrderCommand,
  PLACE_ORDER_PRICE_RULES,
  type PlaceOrderCommand,
} from './broker.js';

const attempt = (act: () => void): string | undefined => {
  try {
    act();

    return undefined;
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }

    return error.code;
  }
};

// --- The trading-core oracle -------------------------------------------------
// These helpers ask trading-core's own executable gates what they accept. They
// deliberately restate no rule of their own, so a change in trading-core moves
// the expectation and this file fails until the SDK is realigned.

/** Every order type `planReservation` can validate at all. */
const RESERVABLE_TYPES = [
  'MARKET',
  'LIMIT',
  'STOP',
  'TAKE_PROFIT',
] as const satisfies readonly OrderType[];

type ReservableType = (typeof RESERVABLE_TYPES)[number];

const reservationOrder = (
  type: ReservableType,
  prices: {
    readonly limitPrice?: string;
    readonly referencePrice?: string;
  },
): ReservationOrder =>
  ({
    id: 'oracle-order',
    status:
      type === 'STOP' || type === 'TAKE_PROFIT' ? 'PENDING_TRIGGER' : 'OPEN',
    side: 'BUY',
    type,
    currency: 'USD',
    symbol: 'AAPL',
    quantity: '1',
    ...prices,
  }) as ReservationOrder;

/** What trading-core's reservation gate demands of `limitPrice` for a type. */
const reservationLimitPriceRule = (
  type: ReservableType,
): 'required' | 'forbidden' => {
  const withLimit = attempt(() =>
    planReservation(reservationOrder(type, { limitPrice: '190.25' })),
  );
  const withReference = attempt(() =>
    planReservation(reservationOrder(type, { referencePrice: '188.00' })),
  );

  if (withLimit === undefined && withReference !== undefined) {
    return 'required';
  }

  if (withLimit !== undefined && withReference === undefined) {
    return 'forbidden';
  }

  throw new Error(
    `the reservation gate is ambiguous for ${type}: limit=${withLimit ?? 'accept'} reference=${withReference ?? 'accept'}`,
  );
};

const usdFeeModel = createFeeModel({
  version: 'oracle-v1',
  market: 'US',
  currency: 'USD',
  commissionRate: '0',
  sellTaxRate: '0',
  roundingDecimals: 2,
  roundingMode: 'HALF_UP',
});

/** Whether trading-core's money domain admits a price string at all. */
const moneyDomainAdmitsPrice = (price: string): boolean => {
  try {
    usdFeeModel.calculate({ market: 'US', side: 'BUY', price, quantity: '1' });

    return true;
  } catch (error) {
    // Only a price rejection answers the question: a later overflow on the
    // computed commission means the price itself was accepted.
    return !(
      error instanceof DomainError &&
      error.code === 'INVALID_PRICE' &&
      error.message.startsWith('Price')
    );
  }
};

// --- Fixtures ----------------------------------------------------------------

const base = {
  sessionId: 'session-1',
  idempotencyKey: 'key-1',
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  quantity: '3',
} as const;

const command = (
  type: OrderType,
  prices: Record<string, unknown> = {},
): unknown => ({ ...base, type, ...prices });

describe('PlaceOrderCommand price rules pinned to trading-core', () => {
  it('never publishes an optional limitPrice, because no trading-core gate has one', () => {
    for (const [type, rules] of Object.entries(PLACE_ORDER_PRICE_RULES)) {
      expect(rules.limitPrice, `${type}.limitPrice`).not.toBe('optional');
    }
  });

  it.each(RESERVABLE_TYPES)('matches the reservation gate for %s', (type) => {
    expect(PLACE_ORDER_PRICE_RULES[type].limitPrice).toBe(
      reservationLimitPriceRule(type),
    );
  });

  it('rejects the stop-limit shape the reservation gate rejects', () => {
    expect(
      attempt(() =>
        planReservation(
          reservationOrder('STOP', {
            limitPrice: '190.25',
            referencePrice: '188.00',
          }),
        ),
      ),
      'trading-core still rejects a STOP carrying a limit price',
    ).toBe('INVALID_ORDER');

    expect(
      attempt(() =>
        assertPlaceOrderCommand(
          command('STOP', { triggerPrice: '188.00', limitPrice: '190.25' }),
        ),
      ),
    ).toBe('INVALID_ORDER');
    expect(
      attempt(() =>
        assertPlaceOrderCommand(
          command('TAKE_PROFIT', {
            triggerPrice: '188.00',
            limitPrice: '190.25',
          }),
        ),
      ),
    ).toBe('INVALID_ORDER');
  });

  it('keeps OCO required/required, matching the two-leg group it desugars into', () => {
    expect(PLACE_ORDER_PRICE_RULES.OCO).toStrictEqual({
      limitPrice: 'required',
      triggerPrice: 'required',
    });

    // The documented reading: one OCO command becomes a LIMIT leg carrying
    // limitPrice plus a triggered leg carrying triggerPrice as its reference.
    expect(
      attempt(() =>
        planOcoReservation([
          {
            id: 'oco-limit',
            status: 'OPEN',
            side: 'SELL',
            type: 'LIMIT',
            currency: 'USD',
            symbol: 'AAPL',
            quantity: '2',
            limitPrice: '210.00',
          },
          {
            id: 'oco-stop',
            status: 'PENDING_TRIGGER',
            side: 'SELL',
            type: 'STOP',
            currency: 'USD',
            symbol: 'AAPL',
            quantity: '2',
            referencePrice: '180.00',
          },
        ]),
      ),
    ).toBeUndefined();

    // A single OCO order is not reservable, which is why `placeOrder` returns
    // one snapshot and cannot address the sibling leg.
    expect(
      attempt(() =>
        planReservation({
          ...reservationOrder('LIMIT', { limitPrice: '1' }),
          type: 'OCO',
        } as unknown as ReservationOrder),
      ),
    ).toBe('INVALID_ORDER');
  });
});

describe('assertPlaceOrderCommand price shapes', () => {
  const CASES: readonly (readonly [
    OrderType,
    Record<string, unknown>,
    string | undefined,
  ])[] = [
    ['MARKET', {}, undefined],
    ['MARKET', { limitPrice: '1' }, 'INVALID_ORDER'],
    ['MARKET', { triggerPrice: '1' }, 'INVALID_ORDER'],
    ['LIMIT', { limitPrice: '190.25' }, undefined],
    ['LIMIT', {}, 'INVALID_ORDER'],
    ['LIMIT', { limitPrice: '1', triggerPrice: '1' }, 'INVALID_ORDER'],
    ['STOP', { triggerPrice: '188.00' }, undefined],
    ['STOP', {}, 'INVALID_ORDER'],
    ['STOP', { triggerPrice: '188.00', limitPrice: '190.25' }, 'INVALID_ORDER'],
    ['TAKE_PROFIT', { triggerPrice: '188.00' }, undefined],
    ['TAKE_PROFIT', {}, 'INVALID_ORDER'],
    [
      'TAKE_PROFIT',
      { triggerPrice: '188.00', limitPrice: '190.25' },
      'INVALID_ORDER',
    ],
    ['OCO', { limitPrice: '210.00', triggerPrice: '180.00' }, undefined],
    ['OCO', { limitPrice: '210.00' }, 'INVALID_ORDER'],
    ['OCO', { triggerPrice: '180.00' }, 'INVALID_ORDER'],
    ['OCO', {}, 'INVALID_ORDER'],
  ];

  it.each(CASES)('%s with %o', (type, prices, expected) => {
    expect(attempt(() => assertPlaceOrderCommand(command(type, prices)))).toBe(
      expected,
    );
  });
});

describe('assertPlaceOrderCommand explicit undefined', () => {
  // `exactOptionalPropertyTypes` makes an explicit `undefined` a compile error,
  // so the runtime must agree: a present-but-undefined key is still a key the
  // shape forbids.
  it.each([
    ['MARKET', 'limitPrice'],
    ['MARKET', 'triggerPrice'],
    ['LIMIT', 'triggerPrice'],
    ['STOP', 'limitPrice'],
    ['TAKE_PROFIT', 'limitPrice'],
  ] as const)('rejects %s carrying an explicit undefined %s', (type, field) => {
    const prices: Record<string, unknown> =
      type === 'LIMIT'
        ? { limitPrice: '190.25' }
        : type === 'MARKET'
          ? {}
          : { triggerPrice: '188.00' };

    expect(
      attempt(() =>
        assertPlaceOrderCommand(
          command(type, { ...prices, [field]: undefined }),
        ),
      ),
    ).toBe('INVALID_ORDER');
  });

  it('still accepts a required price that is genuinely absent nowhere', () => {
    expect(
      attempt(() => assertPlaceOrderCommand(command('MARKET'))),
    ).toBeUndefined();
  });
});

describe('assertPlaceOrderCommand quantity', () => {
  it.each([
    ['3', undefined],
    ['1e3', 'INVALID_QUANTITY'],
    ['0x10', 'INVALID_QUANTITY'],
    ['+1', 'INVALID_QUANTITY'],
    ['1_0', 'INVALID_QUANTITY'],
    ['3.0', 'INVALID_QUANTITY'],
    ['0', 'INVALID_QUANTITY'],
    ['-1', 'INVALID_QUANTITY'],
    [' 3', 'INVALID_QUANTITY'],
  ])('holds %s to a plain whole number', (quantity, expected) => {
    expect(
      attempt(() =>
        assertPlaceOrderCommand({ ...base, type: 'MARKET', quantity }),
      ),
    ).toBe(expected);
  });
});

describe('assertPlaceOrderCommand price bounds pinned to the money domain', () => {
  const PRICES: readonly (readonly [string, string])[] = [
    ['plain', '190.25'],
    ['80 integer digit', '9'.repeat(80)],
    ['81 integer digit', '9'.repeat(81)],
    ['82 integer digit', '9'.repeat(82)],
    ['80 integer and 80 decimal digit', `${'9'.repeat(80)}.${'9'.repeat(80)}`],
    ['80 significant digit', `${'9'.repeat(40)}.${'9'.repeat(40)}`],
    ['81 significant digit', `${'9'.repeat(41)}.${'9'.repeat(40)}`],
    ['80 decimal place', `0.${'0'.repeat(79)}1`],
    ['81 decimal place', `0.${'0'.repeat(80)}1`],
  ];

  it.each(PRICES)('agrees with the money domain on a %s price', (_l, price) => {
    const sdkAccepts =
      attempt(() =>
        assertPlaceOrderCommand(command('LIMIT', { limitPrice: price })),
      ) === undefined;

    expect(sdkAccepts).toBe(moneyDomainAdmitsPrice(price));
  });

  it.each([
    ['exponent', '1e3'],
    ['hexadecimal', '0x10'],
    ['signed', '+1'],
    ['leading dot', '.5'],
    ['trailing dot', '5.'],
    ['zero', '0'],
  ])('rejects a %s price outright', (_label, price) => {
    expect(
      attempt(() =>
        assertPlaceOrderCommand(command('LIMIT', { limitPrice: price })),
      ),
    ).toBe('INVALID_PRICE');
  });
});

describe('assertPlaceOrderCommand identifiers', () => {
  it.each([
    ['whitespace only', '   '],
    ['newline only', '\n'],
    ['header injection', 'k\r\nX-Admin: 1'],
    ['null byte bearing', 'k\u0000'],
  ])('rejects a %s idempotency key', (_label, idempotencyKey) => {
    expect(
      attempt(() =>
        assertPlaceOrderCommand({ ...base, idempotencyKey, type: 'MARKET' }),
      ),
    ).toBe('INVALID_ORDER');
  });

  it('rejects a whitespace-only symbol the way trading-core does', () => {
    expect(
      attempt(() =>
        assertPlaceOrderCommand({ ...base, symbol: '   ', type: 'MARKET' }),
      ),
    ).toBe('INVALID_ORDER');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'nope'],
    ['an array', []],
  ])('rejects %s as a domain error rather than a TypeError', (_l, value) => {
    expect(attempt(() => assertPlaceOrderCommand(value))).toBe('INVALID_ORDER');
  });
});

// --- Type-level contract ----------------------------------------------------
// Compile-time assertions: `tsc` fails if any of these stops being an error,
// which is exactly the regression that would let an impossible order through.
const accepts = (value: PlaceOrderCommand): PlaceOrderCommand => value;

const typeBase = {
  sessionId: 'session-1',
  idempotencyKey: 'type-level',
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  quantity: '1',
} as const;

const marketBase = { ...typeBase, type: 'MARKET' } as const;
const limitBase = { ...typeBase, type: 'LIMIT' } as const;
const stopBase = { ...typeBase, type: 'STOP' } as const;
const takeProfitBase = { ...typeBase, type: 'TAKE_PROFIT' } as const;
const ocoBase = { ...typeBase, type: 'OCO' } as const;
const prices = { limitPrice: '210.00', triggerPrice: '180.00' } as const;

// @ts-expect-error a MARKET order cannot carry a limit price.
accepts({ ...marketBase, limitPrice: '190.25' });

// @ts-expect-error a MARKET order cannot carry a trigger price.
accepts({ ...marketBase, triggerPrice: '190.25' });

// @ts-expect-error a LIMIT order must carry a limit price.
accepts({ ...limitBase });

// @ts-expect-error a LIMIT order cannot carry a trigger price.
accepts({ ...limitBase, ...prices });

// @ts-expect-error a STOP order must carry a trigger price.
accepts({ ...stopBase });

// @ts-expect-error a STOP order cannot carry a limit price: see PRICE_RULES.
accepts({ ...stopBase, ...prices });

// @ts-expect-error a TAKE_PROFIT order must carry a trigger price.
accepts({ ...takeProfitBase });

// @ts-expect-error a TAKE_PROFIT order cannot carry a limit price.
accepts({ ...takeProfitBase, ...prices });

// @ts-expect-error an OCO order must carry both prices.
accepts({ ...ocoBase });

// Positive controls: the legal shapes must stay legal.
accepts(marketBase);
accepts({ ...limitBase, limitPrice: '190.25' });
accepts({ ...stopBase, triggerPrice: '180.00' });
accepts({ ...takeProfitBase, triggerPrice: '180.00' });
accepts({ ...ocoBase, ...prices });
