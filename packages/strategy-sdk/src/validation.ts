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
 */
const MONEY_OPERATION_PRECISION = MONEY_MAX_SIGNIFICANT_DIGITS * 2 + 1;
const PLAIN_EXPONENT_LIMIT = 9e15;

const MoneyDecimalCtor = (
  decimal(0).constructor as unknown as CloneableDecimalConstructor
).clone({
  precision: MONEY_OPERATION_PRECISION,
  toExpNeg: -PLAIN_EXPONENT_LIMIT,
  toExpPos: PLAIN_EXPONENT_LIMIT,
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

/**
 * The one presence-and-value policy for an optional field on an object that
 * crossed the boundary. Both the command validator and the paper adapter's
 * request-body builder go through this, so the value that was validated is the
 * value that reaches the wire.
 *
 * A published command type is an interface, so a caller may satisfy it with a
 * class, a builder result, or an `Object.create` shape. Presence therefore
 * means what ordinary property access means — prototype-inclusive — because
 * that is how every other field on the command is read and how the outbound
 * payload is built. The one addition is an *own* key holding `undefined`:
 * `exactOptionalPropertyTypes` makes writing that a compile error, so the
 * runtime mirror counts it as supplied and refuses it rather than silently
 * treating it as absent.
 */
export function readOptionalField(
  source: object,
  field: string,
): { readonly supplied: boolean; readonly value: unknown } {
  const value = (source as Record<string, unknown>)[field];

  return {
    supplied: value !== undefined || Object.hasOwn(source, field),
    value,
  };
}

/**
 * The same policy, projected onto an outbound payload: `{}` when the field is
 * not supplied, `{ [field]: value }` when it is. Spread into a request body so
 * the wire carries exactly the fields the validator inspected.
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
    throw new DomainError(
      'INVALID_ORDER',
      `a ${description} must be an object`,
    );
  }
}
