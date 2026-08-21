import {
  createFeeModel,
  type DecimalString,
  DomainError,
  decimal,
  type Market,
  type OrderType,
  planOcoReservation,
  planReservation,
  type Quantity,
  type ReservationOrder,
  type Side,
} from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import {
  assertPlaceOrderCommand,
  PLACE_ORDER_PRICE_RULES,
  type PlaceLimitOrderCommand,
  type PlaceOrderCommand,
} from './broker.js';
import { moneyDecimal } from './validation.js';

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

/**
 * Every price shape a reservation order can carry. All four are probed, not just
 * the two single-price ones: a gate that starts accepting both prices at once
 * (stop-limit) or stops accepting the one it needs is drift in either direction,
 * and only the full column set makes both visible.
 */
const PRICE_SHAPES = {
  none: {},
  limitOnly: { limitPrice: '190.25' },
  referenceOnly: { referencePrice: '188.00' },
  both: { limitPrice: '190.25', referencePrice: '188.00' },
} as const;

type PriceShape = keyof typeof PRICE_SHAPES;

const PRICE_SHAPE_NAMES = Object.keys(PRICE_SHAPES) as readonly PriceShape[];

/** Which of the four price shapes trading-core's reservation gate accepts. */
const reservationPriceShapes = (type: ReservableType): readonly PriceShape[] =>
  PRICE_SHAPE_NAMES.filter(
    (shape) =>
      attempt(() =>
        planReservation(reservationOrder(type, PRICE_SHAPES[shape])),
      ) === undefined,
  );

/** What trading-core's reservation gate demands of `limitPrice` for a type. */
const reservationLimitPriceRule = (
  type: ReservableType,
): 'required' | 'forbidden' => {
  const accepted = reservationPriceShapes(type);

  if (accepted.length === 1 && accepted[0] === 'limitOnly') {
    return 'required';
  }

  if (accepted.length === 1 && accepted[0] === 'referenceOnly') {
    return 'forbidden';
  }

  throw new Error(
    `the reservation gate is ambiguous for ${type}: it accepts [${accepted.join(', ')}]`,
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

  // The whole gate table, for every reservable type: exactly one of the two
  // single-price shapes is accepted, and neither `none` nor `both` ever is. An
  // engine that loosens (learns stop-limit for any type) or tightens (stops
  // accepting the shape a type needs) moves this list and fails the suite,
  // rather than leaving the SDK to over- or under-tighten in silence.
  it.each(RESERVABLE_TYPES)(
    'pins the whole gate price table for %s',
    (type) => {
      expect(reservationPriceShapes(type)).toStrictEqual([
        PLACE_ORDER_PRICE_RULES[type].limitPrice === 'required'
          ? 'limitOnly'
          : 'referenceOnly',
      ]);
    },
  );

  it.each(RESERVABLE_TYPES)(
    'rejects a %s command carrying both prices',
    (type) => {
      expect(
        attempt(() =>
          assertPlaceOrderCommand(
            command(type, { triggerPrice: '188.00', limitPrice: '190.25' }),
          ),
        ),
      ).toBe('INVALID_ORDER');
    },
  );

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

// A published command type is an interface, so a class instance, a builder
// result, or an `Object.create` shape satisfies it just as a literal does. The
// validator and the wire body builder must therefore resolve a price field the
// same way; when they disagree, a command `tsc` blesses is refused here, or a
// forbidden price the validator never inspected reaches the transport.
class LimitBuyFromMid implements PlaceLimitOrderCommand {
  readonly type = 'LIMIT' as const;
  readonly market: Market = 'US';
  readonly side: Side = 'BUY';
  readonly sessionId: string = 'session-1';
  readonly idempotencyKey: string = 'getter-key';
  readonly symbol: string = 'AAPL';
  readonly quantity: Quantity = '3';

  constructor(private readonly mid: number) {}

  get limitPrice(): DecimalString {
    return this.mid.toFixed(2);
  }
}

const inheriting = (
  prototype: Record<string, unknown>,
  own: Record<string, unknown>,
): unknown => Object.assign(Object.create(prototype), own);

describe('assertPlaceOrderCommand prototype-supplied prices', () => {
  it('accepts a LIMIT command whose limitPrice comes from a getter', () => {
    expect(
      attempt(() => assertPlaceOrderCommand(new LimitBuyFromMid(190.25))),
    ).toBeUndefined();
  });

  it('validates the getter value rather than trusting it', () => {
    expect(attempt(() => assertPlaceOrderCommand(new LimitBuyFromMid(0)))).toBe(
      'INVALID_PRICE',
    );
  });

  it.each([
    ['MARKET', 'limitPrice'],
    ['MARKET', 'triggerPrice'],
    ['LIMIT', 'triggerPrice'],
    ['STOP', 'limitPrice'],
    ['TAKE_PROFIT', 'limitPrice'],
  ] as const)('rejects %s carrying an inherited %s', (type, field) => {
    const own: Record<string, unknown> = {
      ...base,
      type,
      ...(type === 'LIMIT' ? { limitPrice: '190.25' } : {}),
      ...(type === 'STOP' || type === 'TAKE_PROFIT'
        ? { triggerPrice: '188.00' }
        : {}),
    };

    expect(
      attempt(() =>
        assertPlaceOrderCommand(inheriting({ [field]: '190.25' }, own)),
      ),
    ).toBe('INVALID_ORDER');
  });

  it.each([
    ['LIMIT', 'limitPrice'],
    ['STOP', 'triggerPrice'],
    ['TAKE_PROFIT', 'triggerPrice'],
  ] as const)('accepts %s whose required %s is inherited', (type, field) => {
    const own: Record<string, unknown> = { ...base, type };

    expect(
      attempt(() =>
        assertPlaceOrderCommand(inheriting({ [field]: '190.25' }, own)),
      ),
    ).toBeUndefined();
  });

  // The deliberate consequence of counting an own `undefined` as supplied: the
  // value check fires, so a `LIMIT` whose limitPrice was written as `undefined`
  // fails on the price rather than on the shape. `tsc` rejects writing it at
  // all; the runtime refuses it either way.
  it('rejects a required price written as an own undefined', () => {
    expect(
      attempt(() =>
        assertPlaceOrderCommand(command('LIMIT', { limitPrice: undefined })),
      ),
    ).toBe('INVALID_PRICE');
  });

  it('still rejects a required price that is inherited as undefined', () => {
    expect(
      attempt(() =>
        assertPlaceOrderCommand(
          inheriting({ limitPrice: undefined }, { ...base, type: 'LIMIT' }),
        ),
      ),
    ).toBe('INVALID_ORDER');
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

// The mirror-image policy, and deliberately not the one above: a membership
// lookup is an untrusted *key* against a closed, trusted record, so it stays
// own-property-only. Reading `PLACE_ORDER_PRICE_RULES.__proto__` through the
// chain would turn an inherited `Object.prototype` member into a valid enum.
describe('assertPlaceOrderCommand membership lookups', () => {
  it.each([
    ['type', '__proto__'],
    ['type', 'constructor'],
    ['type', 'toString'],
    ['market', '__proto__'],
    ['market', 'constructor'],
    ['side', '__proto__'],
    ['side', 'constructor'],
  ])('rejects %s of %s as an unknown member', (field, value) => {
    expect(
      attempt(() =>
        assertPlaceOrderCommand({ ...base, type: 'MARKET', [field]: value }),
      ),
    ).toBe('INVALID_ORDER');
  });
});

// The lexical narrowing is a decision, not an accident: trading-core's money
// reader parses these, the SDK refuses them, and the pin fails if either side
// moves.
describe('the SDK requires the canonical plain form the money reader does not', () => {
  it.each([
    ['leading zero integer', '007'],
    ['leading zero fraction', '00.5'],
  ])('rejects a %s price trading-core would parse', (_label, price) => {
    expect(moneyDomainAdmitsPrice(price), 'trading-core still parses it').toBe(
      true,
    );
    expect(
      attempt(() =>
        assertPlaceOrderCommand(command('LIMIT', { limitPrice: price })),
      ),
    ).toBe('INVALID_PRICE');
  });

  it('accepts the canonical spelling of the same magnitudes', () => {
    for (const price of ['7', '0.5']) {
      expect(
        attempt(() =>
          assertPlaceOrderCommand(command('LIMIT', { limitPrice: price })),
        ),
        price,
      ).toBeUndefined();
    }
  });
});

// trading-core validates money through a private `Decimal.clone` snapshotted at
// module load, precisely so nothing can move its domain afterwards. The SDK's
// predicate has to be configured the same way, or the boundary drifts from the
// domain it fronts — in both directions, and silently.
describe('the money boundary does not move with the global Decimal', () => {
  // 81 decimal places: outside the money domain. Under `minE: -1` the global
  // constructor parses it to zero, which passes every magnitude check.
  const OUTSIDE_DOMAIN = `0.${'0'.repeat(80)}1`;
  // 31 integer digits: inside the money domain. Under `maxE: 5` the global
  // constructor parses it to Infinity.
  const INSIDE_DOMAIN = `1${'0'.repeat(30)}`;

  interface ConfigurableDecimal {
    set(config: { readonly minE?: number; readonly maxE?: number }): unknown;
    readonly minE: number;
    readonly maxE: number;
  }

  const globalDecimal = decimal(0)
    .constructor as unknown as ConfigurableDecimal;

  const underGlobalConfig = (
    config: { readonly minE?: number; readonly maxE?: number },
    act: () => void,
  ): void => {
    const { minE, maxE } = globalDecimal;

    try {
      globalDecimal.set(config);
      act();
    } finally {
      globalDecimal.set({ minE, maxE });
    }
  };

  const sdkAcceptsPrice = (price: string): boolean =>
    attempt(() =>
      assertPlaceOrderCommand(command('LIMIT', { limitPrice: price })),
    ) === undefined;

  it('still refuses an out-of-domain price when minE is narrowed', () => {
    underGlobalConfig({ minE: -1 }, () => {
      expect(moneyDomainAdmitsPrice(OUTSIDE_DOMAIN)).toBe(false);
      expect(sdkAcceptsPrice(OUTSIDE_DOMAIN)).toBe(false);
    });
  });

  it('still admits an in-domain price when maxE is narrowed', () => {
    underGlobalConfig({ maxE: 5 }, () => {
      expect(moneyDomainAdmitsPrice(INSIDE_DOMAIN)).toBe(true);
      expect(sdkAcceptsPrice(INSIDE_DOMAIN)).toBe(true);
    });
  });

  // The exponent bounds are part of that configuration: at decimal.js defaults
  // this renders as `1e-8`, which is not a plain decimal at all.
  it("renders money in plain form, as trading-core's money clone does", () => {
    expect(moneyDecimal('0.00000001').toString()).toBe('0.00000001');
    expect(moneyDecimal(`1${'0'.repeat(25)}`).toString()).toBe(
      `1${'0'.repeat(25)}`,
    );
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

// A class satisfying the interface is a legal command at the type level, which
// is why the runtime must accept it too.
accepts(new LimitBuyFromMid(190.25));
