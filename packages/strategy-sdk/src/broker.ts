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
  candidate: Record<string, unknown>,
  field: 'limitPrice' | 'triggerPrice',
  rule: PriceRule,
  type: OrderType,
): void {
  // `exactOptionalPropertyTypes` makes an explicit `undefined` a compile error,
  // so presence of the key — not its value — is what the runtime mirror checks.
  // Otherwise `{ ...marketOrder, limitPrice: undefined }` would be rejected by
  // `tsc` and accepted here.
  if (!Object.hasOwn(candidate, field)) {
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

  assertPositivePrice(candidate[field], field);
}

/**
 * Validates a command that crossed a runtime boundary. The type-level union
 * already rejects impossible shapes, but decoded JSON and JavaScript callers
 * bypass it, so every implementation validates before acting.
 */
export function assertPlaceOrderCommand(
  command: unknown,
): asserts command is PlaceOrderCommand {
  assertCommandObject(command, 'place order command');

  const candidate: Record<string, unknown> = command;

  assertIdentifier(candidate.sessionId, 'sessionId');
  assertIdentifier(candidate.idempotencyKey, 'idempotencyKey');
  assertIdentifier(candidate.symbol, 'symbol');
  assertMember(candidate.market, MARKETS, 'market');
  assertMember(candidate.side, SIDES, 'side');
  assertMember(candidate.type, PLACE_ORDER_PRICE_RULES, 'type');

  // trading-core parses quantities with decimal.js, which reads `'1e3'`,
  // `'0x10'`, and `'+1'` as positive whole numbers. The wire carries the string
  // verbatim, so the plain form is settled here before delegating.
  if (!isPositiveWholeQuantity(candidate.quantity)) {
    throw new DomainError(
      'INVALID_QUANTITY',
      'quantity must be a positive whole number in plain decimal form',
    );
  }

  assertPositiveWholeQuantity(candidate.quantity);

  const rules = PLACE_ORDER_PRICE_RULES[candidate.type];

  assertPriceField(candidate, 'limitPrice', rules.limitPrice, candidate.type);
  assertPriceField(
    candidate,
    'triggerPrice',
    rules.triggerPrice,
    candidate.type,
  );
}
