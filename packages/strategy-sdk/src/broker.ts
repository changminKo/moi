import type {
  Currency,
  DecimalString,
  Market,
  OrderStatus,
  OrderType,
  Quantity,
  Side,
} from '@moi/trading-core';

import {
  assertOrderIntentFields,
  ORDER_INTENT_PRICE_RULES,
  snapshotOrderIntentFields,
} from './order-intent.js';
import { assertCommandObject, assertIdentifier } from './validation.js';

export type { PriceRule, PriceRules } from './order-intent.js';

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
  readonly stopPrice?: never;
}

/** A limit order is defined by its limit price, so the price is required. */
export interface PlaceLimitOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'LIMIT';
  readonly limitPrice: DecimalString;
  readonly stopPrice?: never;
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
  readonly stopPrice: DecimalString;
  readonly limitPrice?: never;
}

/** Take-profit mirrors stop: a trigger, and no limit price, for the same reason. */
export interface PlaceTakeProfitOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'TAKE_PROFIT';
  readonly stopPrice: DecimalString;
  readonly limitPrice?: never;
}

/**
 * OCO pairs a limit leg with a triggered leg, so both prices are required.
 *
 * This is a single-command *request* shape. The server does **not** desugar it:
 * `POST /api/v1/orders` requires an explicit two-element `legs` array for an
 * OCO (`placeOrderSchema`, and the schema is `.strict()`), so `PaperBroker`
 * expands the pair on the wire — `limitPrice` becomes the `LIMIT` leg's limit
 * price and `stopPrice` becomes the `STOP` leg's stop price, which is exactly
 * what `planOcoReservation` accepts. trading-core excludes `'OCO'` from
 * single-order reservation (`Exclude<OrderType, 'OCO'>`), so an OCO placement
 * is only ever the group.
 *
 * Known limitation: `Broker.placeOrder` returns one `BrokerOrder`, so an OCO
 * placement cannot name its sibling leg or its group id, and
 * `CancelOrderCommand` cannot address the group. A strategy that needs to track
 * or cancel both legs individually must place two separate orders — a `LIMIT`
 * and a `STOP`/`TAKE_PROFIT` — and manage the either-or itself.
 */
export interface PlaceOcoOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'OCO';
  readonly limitPrice: DecimalString;
  readonly stopPrice: DecimalString;
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
 * The wire shapes below describe *what the paper API returns*, which is not the
 * same thing as trading-core's `OrderSnapshot` / `WalletSnapshot` /
 * `PositionSnapshot`. Those are the ledger's own rows and carry `version`, the
 * optimistic-concurrency token every internal mutation compares. The public API
 * accepts no client-supplied version on any write — concurrency is controlled by
 * the `Idempotency-Key` header, and ordering a client can observe is
 * `accountSequence` — so a version is neither sent nor useful to a strategy.
 *
 * Reusing the ledger types here is what let the SDK drift: it demanded a
 * `version` no response carries (so every accepted order decoded as malformed)
 * while dropping `market` and `averageCost`, which the API does return and a
 * strategy needs to size and value a position. These types are therefore owned
 * by this package and mirror the payload, field for field.
 */
/**
 * A write's answer. `POST /api/v1/orders` replies with the order it created
 * (`{ id, status, filledQuantity, quantity }`) and `DELETE` replies with just
 * `{ id, status }` — the runtime narrows its cancellation result to those two
 * fields (`production-runtime.ts`), so an OCO cancel does not name the sibling
 * leg it also closed. Publishing that list would be a change to the API, not to
 * this decoder, and is out of scope here.
 *
 * The read shape is `BrokerPortfolioOrder`: it is a different payload, so it is
 * a different type rather than one type half-covering both.
 */
export interface BrokerOrder {
  readonly id: string;
  readonly status: OrderStatus;
  readonly quantity?: Quantity;
  readonly filledQuantity?: Quantity;
  readonly terminalReason?: 'IOC_REMAINDER';
}

export interface BrokerFill {
  readonly id: string;
  readonly symbol: string;
  readonly quantity: Quantity;
  readonly price: DecimalString;
  readonly fee: DecimalString;
  readonly recoveryFill: boolean;
}

/**
 * An order as the portfolio reports it. This carries what a strategy needs to
 * recognise its own orders — which market, which symbol, which side, at what
 * price — none of which a write response repeats.
 */
export interface BrokerPortfolioOrder {
  readonly id: string;
  readonly market: Market;
  readonly symbol: string;
  readonly type: OrderType;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly filledQuantity: Quantity;
  readonly status: OrderStatus;
  readonly limitPrice?: DecimalString;
  readonly stopPrice?: DecimalString;
  readonly terminalReason?: 'IOC_REMAINDER';
  readonly fills: readonly BrokerFill[];
  readonly siblingOrderIds: readonly string[];
}

export interface BrokerWallet {
  readonly currency: Currency;
  readonly total: DecimalString;
  readonly available: DecimalString;
  readonly reserved: DecimalString;
}

export interface BrokerPosition {
  readonly market: Market;
  readonly symbol: string;
  readonly total: Quantity;
  readonly available: Quantity;
  readonly reserved: Quantity;
  readonly averageCost: DecimalString;
}

/**
 * One committed view of an account. Balances stay per-currency wallets: there is
 * no aggregate total, so no cross-currency sum can leak between them.
 */
export interface BrokerPortfolio {
  readonly sessionId: string;
  readonly wallets: readonly BrokerWallet[];
  readonly positions: readonly BrokerPosition[];
  /**
   * Named `activeOrders` by the API, but the query behind it has no status
   * filter, so terminal orders appear here too (#33). Do not assume these are
   * open — filter on `status`. The field cannot simply be narrowed server-side:
   * these rows are currently the only path by which a client can reach fill
   * data, so #33 is sequenced after #37.
   */
  readonly activeOrders: readonly BrokerPortfolioOrder[];
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
 * `placeOrder` and `cancelOrder` return a `BrokerOrder`, which carries no
 * session, so there is nothing to compare — a write is only ever applied to the
 * session the implementation is bound to. Do not treat `sessionId` as a way to
 * multiplex accounts over one broker instance; use one broker per session.
 */
export interface Broker {
  placeOrder(command: PlaceOrderCommand): Promise<BrokerOrder>;
  cancelOrder(command: CancelOrderCommand): Promise<BrokerOrder>;
  exchange(command: ExchangeCommand): Promise<ExchangeReceipt>;
  getPortfolio(sessionId: string): Promise<BrokerPortfolio>;
}

/**
 * The price rules a place-order command is held to. They live with the
 * instruction shape in `order-intent.ts`, because a strategy's `OrderIntent`
 * and a gateway's `PlaceOrderCommand` are the same instruction and must be held
 * to one rule rather than two near-copies. Re-exported under this name because
 * `broker-contract.ts` and `broker.test.ts` pin it against trading-core's own
 * executable gates through this entry.
 */
export const PLACE_ORDER_PRICE_RULES = ORDER_INTENT_PRICE_RULES;

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
    ...snapshotOrderIntentFields(source),
  });
}

function assertPlaceOrderFields(
  snapshot: unknown,
): asserts snapshot is PlaceOrderCommand {
  const candidate = snapshot as Record<string, unknown>;
  const { sessionId, idempotencyKey } = candidate;

  // The two fields the gateway owns come first, then the instruction half —
  // which is the same field list, in the same order, that `readOrderIntent`
  // validates. The first invalid field is the one reported, so that order is
  // observable behaviour rather than an implementation detail.
  assertIdentifier(sessionId, 'sessionId');
  assertIdentifier(idempotencyKey, 'idempotencyKey');
  assertOrderIntentFields(candidate);
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
