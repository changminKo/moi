import {
  assertPositiveWholeQuantity,
  DomainError,
  type OrderType,
} from '@moi/trading-core';

import type { PlaceOrderCommand } from './broker.js';
import {
  assertCommandObject,
  assertIdentifier,
  assertMember,
  assertPositivePrice,
  isPositiveWholeQuantity,
  MARKETS,
  type OptionalFieldRead,
  projectOptionalField,
  readOptionalField,
  SIDES,
} from './validation.js';

/**
 * An order as a *strategy* expresses it: what to trade, which way, how much, at
 * what price — and nothing about who is trading or how the write is made
 * idempotent.
 *
 * This is the shape the design's §6.2 requires. A strategy returns an
 * `OrderIntent`; the `OrderGateway` appends the decision to state, derives an
 * idempotency key from the stored `decisionId`, and only then promotes the
 * intent to a `PlaceOrderCommand` by adding the session and that key. So a
 * strategy that invents either field has misunderstood the contract: a
 * self-chosen key is not recomputable after a crash, which is the one property
 * the derivation exists to provide.
 *
 * The type is `PlaceOrderCommand` with those two fields removed, distributed
 * over the union so the discrimination survives — a `MARKET` intent still
 * cannot carry a limit price at compile time. Deriving it rather than restating
 * it means the two shapes cannot drift; the direction of the derivation is
 * inverted from how the concepts read (the intent is the primitive and the
 * command is the intent plus two fields), and it points this way only because
 * `PlaceMarketOrderCommand` and its siblings are already published names.
 */
type WithoutGatewayFields<T> = T extends unknown
  ? Omit<T, 'sessionId' | 'idempotencyKey'>
  : never;

export type OrderIntent = WithoutGatewayFields<PlaceOrderCommand>;

/** The two fields the gateway owns, and a strategy must not supply. */
export const GATEWAY_FIELDS = Object.freeze([
  'sessionId',
  'idempotencyKey',
] as const);

export type PriceRule = 'required' | 'optional' | 'forbidden';

export interface PriceRules {
  readonly limitPrice: PriceRule;
  readonly stopPrice: PriceRule;
}

/**
 * The runtime mirror of the discriminated union, so a JavaScript caller or a
 * decoded payload is held to the same rule as a TypeScript caller. It is
 * exported so a test can pin it against trading-core's own executable gates
 * instead of restating them: no type may carry an `optional` limit price,
 * because `planReservation` has no such rule for any type.
 */
export const ORDER_INTENT_PRICE_RULES: Readonly<Record<OrderType, PriceRules>> =
  {
    MARKET: { limitPrice: 'forbidden', stopPrice: 'forbidden' },
    LIMIT: { limitPrice: 'required', stopPrice: 'forbidden' },
    STOP: { limitPrice: 'forbidden', stopPrice: 'required' },
    TAKE_PROFIT: { limitPrice: 'forbidden', stopPrice: 'required' },
    OCO: { limitPrice: 'required', stopPrice: 'required' },
  };

function assertPriceField(
  read: OptionalFieldRead,
  field: 'limitPrice' | 'stopPrice',
  rule: PriceRule,
  type: OrderType,
): void {
  // The read handed in is the one the boundary snapshot already performed, so
  // the price inspected here is the price the request body carries. Reading the
  // field again would let the two disagree, and a disagreement in either
  // direction re-opens the hole the price rules exist to close.
  const { supplied, value } = read;

  if (!supplied) {
    if (rule === 'required') {
      throw new DomainError(
        'INVALID_ORDER',
        `a ${type} order requires ${field}`,
      );
    }

    return;
  }

  if (rule === 'forbidden') {
    throw new DomainError(
      'INVALID_ORDER',
      `a ${type} order cannot carry ${field}`,
    );
  }

  assertPositivePrice(value, field);
}

/**
 * The instruction half of a boundary snapshot: every field read exactly once,
 * in this order, into plain own data. `broker.ts` spreads it after the two
 * gateway fields and `readOrderIntent` uses it alone, so both boundaries read
 * one field list under one policy.
 */
export function snapshotOrderIntentFields(
  source: Record<string, unknown>,
): Record<string, unknown> {
  return {
    market: source.market,
    symbol: source.symbol,
    side: source.side,
    type: source.type,
    quantity: source.quantity,
    ...projectOptionalField(source, 'limitPrice'),
    ...projectOptionalField(source, 'stopPrice'),
  };
}

/**
 * Validates the instruction half of an already-taken snapshot. The assertion
 * order is part of the observable behaviour — the first invalid field is the one
 * reported — so it is fixed here rather than left to the caller.
 */
export function assertOrderIntentFields(
  candidate: Record<string, unknown>,
): void {
  const { symbol, market, side, type, quantity } = candidate;

  assertIdentifier(symbol, 'symbol');
  assertMember(market, MARKETS, 'market');
  assertMember(side, SIDES, 'side');
  assertMember(type, ORDER_INTENT_PRICE_RULES, 'type');

  // trading-core parses quantities with decimal.js, which reads `'1e3'`,
  // `'0x10'`, and `'+1'` as positive whole numbers. The wire carries the string
  // verbatim, so the plain form is settled here before delegating.
  //
  // The delegate parses on the shared global `Decimal`, so a same-realm
  // `Decimal.set({ maxE })` can make it refuse a quantity this boundary
  // accepts. That fails closed, and the delegate lives in trading-core, so
  // hardening it the way the money predicate is hardened is a trading-core
  // change rather than one available here.
  if (!isPositiveWholeQuantity(quantity)) {
    throw new DomainError(
      'INVALID_QUANTITY',
      'quantity must be a positive whole number in plain decimal form',
    );
  }

  assertPositiveWholeQuantity(quantity);

  const rules = ORDER_INTENT_PRICE_RULES[type];

  assertPriceField(
    readOptionalField(candidate, 'limitPrice'),
    'limitPrice',
    rules.limitPrice,
    type,
  );
  assertPriceField(
    readOptionalField(candidate, 'stopPrice'),
    'stopPrice',
    rules.stopPrice,
    type,
  );
}

/**
 * Snapshots and validates an intent returned by strategy code, returning the
 * snapshot that was validated. The gateway promotes *this* object, so the
 * instruction that reaches the wire is provably the instruction the rules were
 * applied to — the same discipline, and for the same reason, as
 * `readPlaceOrderCommand`.
 *
 * A supplied `sessionId` or `idempotencyKey` is refused. Note what does the
 * work there: the rejection is a *diagnostic*, not the defence. The defence is
 * that `snapshotOrderIntentFields` copies a fixed list of fields, so no field
 * outside that list can reach the wire however it was supplied. The check is
 * therefore own-key — a field the strategy actually wrote — because that is the
 * mistake worth naming, and because a prototype-inclusive check would let a
 * single polluted `Object.prototype.sessionId` refuse every intent the bot ever
 * forms.
 */
export function readOrderIntent(intent: unknown): OrderIntent {
  assertCommandObject(intent, 'order intent');

  const source: Record<string, unknown> = intent;

  for (const field of GATEWAY_FIELDS) {
    if (Object.hasOwn(source, field)) {
      throw new DomainError(
        'INVALID_ORDER',
        `an order intent cannot carry ${field}: the gateway derives it from the recorded decision`,
      );
    }
  }

  const snapshot = Object.assign(
    Object.create(null) as Record<string, unknown>,
    snapshotOrderIntentFields(source),
  );

  assertOrderIntentFields(snapshot);

  return snapshot as OrderIntent;
}
