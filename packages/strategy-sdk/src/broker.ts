import {
  assertPositiveWholeQuantity,
  type Currency,
  type DecimalString,
  DomainError,
  type Market,
  type OrderSnapshot,
  type OrderType,
  type PositionSnapshot,
  type Quantity,
  type Side,
  type WalletSnapshot,
} from '@skipjack/trading-core';

import {
  assertCommandObject,
  assertIdentifier,
  isPositiveMoneyAmount,
  isPositiveWholeQuantity,
  type OptionalFieldRead,
  projectOptionalField,
  readOptionalField,
} from './validation.js';

// Keyed by the domain union rather than listed, so adding a `Market`, a `Side`,
// or an `OrderType` in trading-core breaks this build until the new member is
// given a rule here.
const MARKETS: Readonly<Record<Market, true>> = { KR: true, US: true };
const SIDES: Readonly<Record<Side, true>> = { BUY: true, SELL: true };

interface PlaceOrderCommandBase {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: Quantity;
}

/** A market order executes at the book, so it never carries a price. */
export interface PlaceMarketOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'MARKET';
  readonly limitPrice?: never;
  readonly triggerPrice?: never;
}

/** A limit order is defined by its limit price, so the price is required. */
export interface PlaceLimitOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'LIMIT';
  readonly limitPrice: DecimalString;
  readonly triggerPrice?: never;
}

/**
 * A stop order is defined by its trigger and carries no limit price. That is
 * trading-core's executable rule, not a preference: `planReservation` requires
 * `limitPrice` to be absent for every non-`LIMIT` type and rejects the order
 * outright otherwise, so a stop-limit is not a shape the domain can represent
 * today. `broker.test.ts` pins this against that gate.
 */
export interface PlaceStopOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'STOP';
  readonly triggerPrice: DecimalString;
  readonly limitPrice?: never;
}

/** Take-profit mirrors stop: a trigger, and no limit price, for the same reason. */
export interface PlaceTakeProfitOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'TAKE_PROFIT';
  readonly triggerPrice: DecimalString;
  readonly limitPrice?: never;
}

/**
 * OCO pairs a limit leg with a triggered leg, so both prices are required.
 *
 * This is a single-command *request* shape that the server desugars into the
 * two-leg group trading-core models: `limitPrice` becomes the `LIMIT` leg's
 * limit price and `triggerPrice` becomes the triggered leg's reference price,
 * which is exactly what `planOcoReservation` accepts. trading-core excludes
 * `'OCO'` from single-order reservation (`Exclude<OrderType, 'OCO'>`), so an
 * OCO placement is only ever the group.
 *
 * Known limitation: `Broker.placeOrder` returns one `OrderSnapshot`, so an OCO
 * placement cannot name its sibling leg or its group id, and
 * `CancelOrderCommand` cannot address the group. A strategy that needs to track
 * or cancel both legs individually must place two separate orders — a `LIMIT`
 * and a `STOP`/`TAKE_PROFIT` — and manage the either-or itself.
 */
export interface PlaceOcoOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'OCO';
  readonly limitPrice: DecimalString;
  readonly triggerPrice: DecimalString;
}

/**
 * Discriminated on `type` so an impossible order is a compile error rather than
 * a server rejection: a market order cannot carry a limit price and a limit
 * order cannot omit one.
 */
export type PlaceOrderCommand =
  | PlaceMarketOrderCommand
  | PlaceLimitOrderCommand
  | PlaceStopOrderCommand
  | PlaceTakeProfitOrderCommand
  | PlaceOcoOrderCommand;

export interface CancelOrderCommand {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly orderId: string;
}

export interface ExchangeCommand {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly quoteId: string;
}

export interface ExchangeReceipt {
  readonly id: string;
  readonly quoteId: string;
  readonly sessionId: string;
  readonly from: Currency;
  readonly to: Currency;
  readonly sourceAmount: DecimalString;
  readonly rate: DecimalString;
  readonly fee: DecimalString;
  readonly targetAmount: DecimalString;
  readonly executedAt: string;
}

/**
 * One committed view of an account. Balances stay per-currency wallets: there is
 * no aggregate total, so no cross-currency sum can leak between them.
 */
export interface PortfolioSnapshot {
  readonly sessionId: string;
  readonly wallets: readonly WalletSnapshot[];
  readonly positions: readonly PositionSnapshot[];
  readonly activeOrders: readonly OrderSnapshot[];
  readonly accountSequence: DecimalString;
}

/**
 * The only surface a strategy needs. Every command carries its own key.
 *
 * Session semantics: the implementation owns the session — a `PaperBroker`'s
 * transport holds the cookie — so a command's `sessionId` is a scoping
 * assertion, not routing information. It is validated on every command and
 * checked back against every response that names a session: `getPortfolio`
 * compares the returned portfolio's session and `exchange` compares the
 * receipt's, both failing with `INVARIANT_VIOLATION` on a mismatch.
 * `placeOrder` and `cancelOrder` return an `OrderSnapshot`, which carries no
 * session, so there is nothing to compare — a write is only ever applied to the
 * session the implementation is bound to. Do not treat `sessionId` as a way to
 * multiplex accounts over one broker instance; use one broker per session.
 */
export interface Broker {
  placeOrder(command: PlaceOrderCommand): Promise<OrderSnapshot>;
  cancelOrder(command: CancelOrderCommand): Promise<OrderSnapshot>;
  exchange(command: ExchangeCommand): Promise<ExchangeReceipt>;
  getPortfolio(sessionId: string): Promise<PortfolioSnapshot>;
}

export type PriceRule = 'required' | 'optional' | 'forbidden';

export interface PriceRules {
  readonly limitPrice: PriceRule;
  readonly triggerPrice: PriceRule;
}

/**
 * The runtime mirror of the discriminated union above, so a JavaScript caller
 * or a decoded payload is held to the same rule as a TypeScript caller. It is
 * exported so a test can pin it against trading-core's own executable gates
 * instead of restating them: no type may carry an `optional` limit price,
 * because `planReservation` has no such rule for any type.
 */
export const PLACE_ORDER_PRICE_RULES: Readonly<Record<OrderType, PriceRules>> =
  {
    MARKET: { limitPrice: 'forbidden', triggerPrice: 'forbidden' },
    LIMIT: { limitPrice: 'required', triggerPrice: 'forbidden' },
    STOP: { limitPrice: 'forbidden', triggerPrice: 'required' },
    TAKE_PROFIT: { limitPrice: 'forbidden', triggerPrice: 'required' },
    OCO: { limitPrice: 'required', triggerPrice: 'required' },
  };

function assertMember<T extends string>(
  value: unknown,
  allowed: Readonly<Record<T, unknown>>,
  field: string,
): asserts value is T {
  // `Object.hasOwn` rather than a property read, so `__proto__` and
  // `constructor` are rejected like any other unknown member.
  if (typeof value !== 'string' || !Object.hasOwn(allowed, value)) {
    throw new DomainError(
      'INVALID_ORDER',
      `${field} must be one of ${Object.keys(allowed).join(', ')}`,
    );
  }
}

function assertPositivePrice(value: unknown, field: string): void {
  if (!isPositiveMoneyAmount(value)) {
    throw new DomainError(
      'INVALID_PRICE',
      `${field} must be a positive plain decimal string inside the money domain`,
    );
  }
}

function assertPriceField(
  read: OptionalFieldRead,
  field: 'limitPrice' | 'triggerPrice',
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
 * Snapshots a command that crossed a runtime boundary: every field is read
 * exactly once, into plain own data with no prototype, and the snapshot is what
 * gets validated and what every caller works from afterwards.
 *
 * A published command type is an `interface`, so a caller may satisfy it with a
 * class, a builder result, an `Object.create` shape, or a `Proxy` — all of which
 * this boundary supports deliberately. That makes a property read a call into
 * caller code, and caller code need not answer twice the same way. A validator
 * that reads a field and a request builder that reads it again therefore inspect
 * and forward *different* values: a `LIMIT` order validates clean and is POSTed
 * as a `MARKET` order carrying a limit price. Reading once, here, is what makes
 * the validated value and the forwarded value the same value.
 *
 * What makes the price rules and the request body agree is narrower than the
 * snapshot's prototype: both read this one object through the same
 * `readOptionalField` policy, which holds whatever prototype it has. The null
 * prototype buys something else, and only for one input — a caller command that
 * is itself prototype-free cannot see a polluted `Object.prototype`, so a
 * snapshot taken from it must not see one either, or an ordinary `MARKET` order
 * is refused over ambient state nothing on this call path touched.
 * `paper-broker.test.ts` pins exactly that input.
 *
 * This is the discipline trading-core already applies to untrusted fee-model
 * input (`snapshotFeeSchedule`, `snapshotFeeCalculationInput`). It differs in
 * one respect on purpose: a throw out of a caller's accessor is not wrapped
 * here, because that throw is caller code failing rather than the boundary
 * rejecting a value, and the README documents it as passing through.
 *
 * Taking the whole snapshot before validating any of it has one visible
 * consequence: every field's accessor runs, in the order listed below, even when
 * an earlier field is already invalid. Each field is still read exactly once, so
 * nothing is amplified, but a command whose accessors have side effects sees all
 * of them fire on a command that is then refused, and a throw from a late
 * accessor surfaces in place of the `DomainError` an earlier field had earned.
 */
function snapshotPlaceOrderCommand(command: unknown): Record<string, unknown> {
  assertCommandObject(command, 'place order command');

  const source: Record<string, unknown> = command;

  return Object.assign(Object.create(null) as Record<string, unknown>, {
    sessionId: source.sessionId,
    idempotencyKey: source.idempotencyKey,
    market: source.market,
    symbol: source.symbol,
    side: source.side,
    type: source.type,
    quantity: source.quantity,
    ...projectOptionalField(source, 'limitPrice'),
    ...projectOptionalField(source, 'triggerPrice'),
  });
}

function assertPlaceOrderFields(
  snapshot: unknown,
): asserts snapshot is PlaceOrderCommand {
  const candidate = snapshot as Record<string, unknown>;
  const { sessionId, idempotencyKey, symbol, market, side, type, quantity } =
    candidate;

  assertIdentifier(sessionId, 'sessionId');
  assertIdentifier(idempotencyKey, 'idempotencyKey');
  assertIdentifier(symbol, 'symbol');
  assertMember(market, MARKETS, 'market');
  assertMember(side, SIDES, 'side');
  assertMember(type, PLACE_ORDER_PRICE_RULES, 'type');

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

  const rules = PLACE_ORDER_PRICE_RULES[type];

  assertPriceField(
    readOptionalField(candidate, 'limitPrice'),
    'limitPrice',
    rules.limitPrice,
    type,
  );
  assertPriceField(
    readOptionalField(candidate, 'triggerPrice'),
    'triggerPrice',
    rules.triggerPrice,
    type,
  );
}

/**
 * Snapshots and validates a place-order command, returning the snapshot that
 * was validated. Every implementation of `Broker` builds its request from the
 * returned object rather than from the caller's, so the value on the wire is
 * provably the value the rules were applied to.
 */
export function readPlaceOrderCommand(command: unknown): PlaceOrderCommand {
  const snapshot = snapshotPlaceOrderCommand(command);

  assertPlaceOrderFields(snapshot);

  return snapshot;
}

/**
 * Validates a command that crossed a runtime boundary. The type-level union
 * already rejects impossible shapes, but decoded JSON and JavaScript callers
 * bypass it, so every implementation validates before acting.
 *
 * Note what this narrowing can and cannot promise: it says the command's fields
 * *were* valid when read. It cannot say a later read of the same
 * accessor-backed object returns the same values, which is why an
 * implementation acts on a snapshot instead of re-reading its argument — and
 * why `readPlaceOrderCommand`, which returns the snapshot it validated, is
 * published beside this assertion rather than kept internal. An implementation
 * that only asserts has nothing to act on but the caller's object.
 */
export function assertPlaceOrderCommand(
  command: unknown,
): asserts command is PlaceOrderCommand {
  readPlaceOrderCommand(command);
}

/**
 * The same snapshot-then-validate discipline for the two identifier-only
 * commands: an `orderId` reaches a URL path segment and an `idempotencyKey`
 * reaches a header, so the one that was checked has to be the one that is sent.
 */
export function readCancelOrderCommand(command: unknown): CancelOrderCommand {
  assertCommandObject(command, 'cancel order command');

  const source: Record<string, unknown> = command;
  // One destructuring read per field, so the identifier that is checked below
  // is the identifier that is returned.
  const { sessionId, idempotencyKey, orderId } = source;

  assertIdentifier(sessionId, 'sessionId');
  assertIdentifier(idempotencyKey, 'idempotencyKey');
  assertIdentifier(orderId, 'orderId');

  return { sessionId, idempotencyKey, orderId };
}

export function readExchangeCommand(command: unknown): ExchangeCommand {
  assertCommandObject(command, 'exchange command');

  const source: Record<string, unknown> = command;
  const { sessionId, idempotencyKey, quoteId } = source;

  assertIdentifier(sessionId, 'sessionId');
  assertIdentifier(idempotencyKey, 'idempotencyKey');
  assertIdentifier(quoteId, 'quoteId');

  return { sessionId, idempotencyKey, quoteId };
}
