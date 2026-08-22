import {
  type DecimalString,
  DomainError,
  decimal,
  type Quantity,
} from '@skipjack/trading-core';

/**
 * Boundary predicates shared by the command validator and the response decoder.
 * Both sides face untrusted input — a JavaScript caller on one, the paper API on
 * the other — so they hold values to one rule instead of two near-copies.
 */

export const MAX_IDENTIFIER_LENGTH = 200;

// An identifier reaches an HTTP header or a URL path segment, so a control
// character in one is a request-splitting shape rather than a name.
const CONTROL_CHARACTER = /\p{Cc}/u;

// The *canonical* plain form, deliberately narrower than trading-core's own
// `-?[0-9]+(?:\.[0-9]+)?`: no sign, and no leading zero. Every value that
// crosses this boundary is either emitted by `Decimal.toString()` or forwarded
// to a non-negative field, and canonical output never carries either, so `'007'`
// and `'-5'` are malformed here even though the money reader would parse them.
const PLAIN_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const ZERO_DECIMAL = /^0(?:\.0+)?$/u;
const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/u;
const POSITIVE_WHOLE_NUMBER = /^[1-9][0-9]*$/u;
const ISO_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;

// The exact money domain trading-core enforces in `decimal.ts`
// (`MONEY_PRECISION`, `MONEY_MAX_INTEGER_DIGITS`, `MONEY_MAX_DECIMAL_PLACES`).
// Those constants are not exported, so `broker.test.ts` pins these three
// against trading-core's own money reader: drift fails the build rather than
// silently letting the SDK accept a price the domain will refuse.
const MONEY_MAX_SIGNIFICANT_DIGITS = 80;
const MONEY_MAX_INTEGER_DIGITS = 80;
const MONEY_MAX_DECIMAL_PLACES = 80;

// A plain decimal inside that domain cannot be longer than its widest form:
// every integer digit, the point, and every decimal place.
const MAX_DECIMAL_LENGTH =
  MONEY_MAX_INTEGER_DIGITS + MONEY_MAX_DECIMAL_PLACES + 1;

// Only the smallest structural slice of `decimal.js` this module needs, declared
// here rather than imported: `decimal.js` is trading-core's dependency, not the
// SDK's, and the SDK reaches it solely through trading-core's own export.
interface MoneyDecimal {
  readonly e: number;
  isFinite(): boolean;
  isZero(): boolean;
  precision(): number;
  decimalPlaces(): number;
  toString(): string;
}

interface MoneyDecimalConstructor {
  new (value: string): MoneyDecimal;
}

interface CloneableDecimalConstructor {
  clone(config: {
    readonly precision: number;
    readonly toExpNeg: number;
    readonly toExpPos: number;
    readonly minE: number;
    readonly maxE: number;
  }): MoneyDecimalConstructor;
}

/**
 * The money domain is a property of the values, not of whoever configured
 * `decimal.js` last. trading-core validates money through a private
 * `Decimal.clone` for exactly that reason: a clone snapshots `minE`/`maxE` when
 * it is made, so a later `Decimal.set` cannot move what the constructor
 * produces. Parsing with the shared global instead would let any same-realm
 * code shift this boundary in either direction — accepting an out-of-domain
 * value that clamps to zero, or refusing an in-domain one that clamps to
 * infinity — while trading-core, the domain this fronts, keeps rejecting or
 * accepting it.
 *
 * So the SDK takes its own clone from the same constructor trading-core cloned,
 * with the same configuration: identical settings mean identical verdicts,
 * whatever the ambient global becomes. `precision` bounds arithmetic rather than
 * construction, so it is inert for a predicate that only inspects — it is
 * matched anyway so the two constructors cannot quietly differ.
 *
 * `minE`/`maxE` are stated rather than inherited, at `decimal.js`'s own default
 * magnitudes — which is exactly what an untampered clone captures. A clone only
 * snapshots the bounds live *when it is made*, and this module is made whenever
 * the consumer first imports it, which after a lazy `await import` is
 * arbitrarily late. Inheriting them would make the SDK's money domain a
 * function of load order; stating them makes it a property of the values, which
 * is what the boundary claims to be. (A tamper that precedes trading-core's own
 * load still moves trading-core's clone; pinning that one is a trading-core
 * change.)
 */
const MONEY_OPERATION_PRECISION = MONEY_MAX_SIGNIFICANT_DIGITS * 2 + 1;
const PLAIN_EXPONENT_LIMIT = 9e15;

const MoneyDecimalCtor = (
  decimal(0).constructor as unknown as CloneableDecimalConstructor
).clone({
  precision: MONEY_OPERATION_PRECISION,
  toExpNeg: -PLAIN_EXPONENT_LIMIT,
  toExpPos: PLAIN_EXPONENT_LIMIT,
  minE: -PLAIN_EXPONENT_LIMIT,
  maxE: PLAIN_EXPONENT_LIMIT,
});

/**
 * Parses a money string under that configuration. Exported so a test can pin
 * the configuration itself: at `decimal.js` defaults these render in exponent
 * notation, which is not a plain decimal at all.
 */
export const moneyDecimal = (value: string): MoneyDecimal =>
  new MoneyDecimalCtor(value);

/** Whether a plain decimal string sits inside trading-core's money domain. */
function isWithinMoneyDomain(value: string): boolean {
  if (value.length > MAX_DECIMAL_LENGTH || !PLAIN_DECIMAL.test(value)) {
    return false;
  }

  const parsed = moneyDecimal(value);
  const integerDigits = parsed.isZero() ? 1 : Math.max(parsed.e + 1, 1);

  return (
    parsed.isFinite() &&
    parsed.precision() <= MONEY_MAX_SIGNIFICANT_DIGITS &&
    integerDigits <= MONEY_MAX_INTEGER_DIGITS &&
    parsed.decimalPlaces() <= MONEY_MAX_DECIMAL_PLACES
  );
}

export const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= MAX_IDENTIFIER_LENGTH &&
  !CONTROL_CHARACTER.test(value);

/** A non-negative money amount, as the paper API reports balances and fees. */
export const isMoneyAmount = (value: unknown): value is DecimalString =>
  typeof value === 'string' && isWithinMoneyDomain(value);

/** A strictly positive money amount, as an order price must be. */
export const isPositiveMoneyAmount = (value: unknown): value is DecimalString =>
  isMoneyAmount(value) && !ZERO_DECIMAL.test(value);

export const isWholeNumber = (value: unknown): value is DecimalString =>
  typeof value === 'string' &&
  value.length <= MONEY_MAX_INTEGER_DIGITS &&
  WHOLE_NUMBER.test(value);

export const isNonNegativeWholeQuantity = (value: unknown): value is Quantity =>
  isWholeNumber(value);

export const isPositiveWholeQuantity = (value: unknown): value is Quantity =>
  typeof value === 'string' &&
  value.length <= MONEY_MAX_INTEGER_DIGITS &&
  POSITIVE_WHOLE_NUMBER.test(value);

// UTC with a trailing `Z`, to at most nanosecond precision. A numeric offset is
// rejected; `Date.parse` still rolls a calendar-impossible date over, which is
// tolerable because no instant on this boundary feeds arithmetic.
export const isIsoInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_INSTANT.test(value) &&
  !Number.isNaN(Date.parse(value));

export interface OptionalFieldRead {
  readonly supplied: boolean;
  readonly value: unknown;
}

/**
 * The one presence-and-value policy for an optional field on an object that
 * crossed the boundary. It performs a *single* property read, and the boundary
 * snapshot that calls it carries that one read forward to both the price rules
 * and the request body, so the value that was validated is the value that
 * reaches the wire.
 *
 * A published command type is an interface, so a caller may satisfy it with a
 * class, a builder result, an `Object.create` shape, or a `Proxy`. Presence
 * therefore means what ordinary property access means — prototype-inclusive —
 * because that is how every other field on the command is read and how the
 * outbound payload is built. The one addition is an *own* key holding
 * `undefined`: `exactOptionalPropertyTypes` makes writing that a compile error,
 * so the runtime mirror counts it as supplied and refuses it rather than
 * silently treating it as absent.
 *
 * The cost of a prototype-inclusive read is that a polluted `Object.prototype`
 * is indistinguishable from a caller's own accessor, so a polluted
 * `Object.prototype.limitPrice` supplies one — and makes a `MARKET` order fail
 * closed as `INVALID_ORDER`. That is a deliberate trade, pinned by test:
 * own-property-only presence would have this boundary reject the class and
 * builder shapes its own published interfaces bless, and descriptor-walking to
 * exclude `Object.prototype` specifically would reject a `Proxy` whose price
 * exists only behind a `get` trap.
 */
export function readOptionalField(
  source: object,
  field: string,
): OptionalFieldRead {
  const value = (source as Record<string, unknown>)[field];

  return {
    supplied: value !== undefined || Object.hasOwn(source, field),
    value,
  };
}

/**
 * The same policy, projected onto an object being built: `{}` when the field is
 * not supplied, `{ [field]: value }` when it is. Spread into the boundary
 * snapshot, and then into the request body built from that snapshot, so the
 * wire carries exactly the fields the price rules were applied to.
 */
export function projectOptionalField(
  source: object,
  field: string,
): Record<string, unknown> {
  const { supplied, value } = readOptionalField(source, field);

  return supplied ? { [field]: value } : {};
}

export function assertIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (!isIdentifier(value)) {
    throw new DomainError(
      'INVALID_ORDER',
      `${field} must be a non-empty identifier of at most ${MAX_IDENTIFIER_LENGTH} printable characters`,
    );
  }
}

/**
 * Narrows a value that crossed a runtime boundary to an object. Every public
 * method funnels through this so a `null` or a number fails as a `DomainError`
 * instead of leaking a `TypeError` from the first property read.
 */
export function assertCommandObject(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    // The article comes from the description rather than being hard-coded, so
    // `an exchange command` does not read as `a exchange command`.
    const article = /^[aeiou]/iu.test(description) ? 'an' : 'a';

    throw new DomainError(
      'INVALID_ORDER',
      `${article} ${description} must be an object`,
    );
  }
}
