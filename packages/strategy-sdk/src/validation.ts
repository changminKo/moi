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

/** Whether a plain decimal string sits inside trading-core's money domain. */
function isWithinMoneyDomain(value: string): boolean {
  if (value.length > MAX_DECIMAL_LENGTH || !PLAIN_DECIMAL.test(value)) {
    return false;
  }

  const parsed = decimal(value);
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

export const isIsoInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_INSTANT.test(value) &&
  !Number.isNaN(Date.parse(value));

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
