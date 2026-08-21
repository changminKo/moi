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

const MARKETS: readonly Market[] = ['KR', 'US'];
const SIDES: readonly Side[] = ['BUY', 'SELL'];
const ORDER_TYPES: readonly OrderType[] = [
  'MARKET',
  'LIMIT',
  'STOP',
  'TAKE_PROFIT',
  'OCO',
];

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_PRICE_LENGTH = 82;
const PLAIN_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const ZERO_DECIMAL = /^0(?:\.0+)?$/u;

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

/** A stop order needs a trigger; the limit price makes it a stop-limit. */
export interface PlaceStopOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'STOP';
  readonly triggerPrice: DecimalString;
  readonly limitPrice?: DecimalString;
}

/** Take-profit mirrors stop: a trigger, optionally capped by a limit price. */
export interface PlaceTakeProfitOrderCommand extends PlaceOrderCommandBase {
  readonly type: 'TAKE_PROFIT';
  readonly triggerPrice: DecimalString;
  readonly limitPrice?: DecimalString;
}

/** OCO pairs a limit leg with a triggered leg, so both prices are required. */
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

/** The only surface a strategy needs. Every command carries its own key. */
export interface Broker {
  placeOrder(command: PlaceOrderCommand): Promise<OrderSnapshot>;
  cancelOrder(command: CancelOrderCommand): Promise<OrderSnapshot>;
  exchange(command: ExchangeCommand): Promise<ExchangeReceipt>;
  getPortfolio(sessionId: string): Promise<PortfolioSnapshot>;
}

type PriceRule = 'required' | 'optional' | 'forbidden';

interface PriceRules {
  readonly limitPrice: PriceRule;
  readonly triggerPrice: PriceRule;
}

// The runtime mirror of the discriminated union above, so a JavaScript caller
// or a decoded payload is held to the same rule as a TypeScript caller.
const PRICE_RULES: Readonly<Record<OrderType, PriceRules>> = {
  MARKET: { limitPrice: 'forbidden', triggerPrice: 'forbidden' },
  LIMIT: { limitPrice: 'required', triggerPrice: 'forbidden' },
  STOP: { limitPrice: 'optional', triggerPrice: 'required' },
  TAKE_PROFIT: { limitPrice: 'optional', triggerPrice: 'required' },
  OCO: { limitPrice: 'required', triggerPrice: 'required' },
};

function assertIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new DomainError(
      'INVALID_ORDER',
      `${field} must be a non-empty identifier of at most ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
}

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DomainError(
      'INVALID_ORDER',
      `${field} must be one of ${allowed.join(', ')}`,
    );
  }
}

function assertPositivePrice(value: unknown, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PRICE_LENGTH ||
    !PLAIN_DECIMAL.test(value) ||
    ZERO_DECIMAL.test(value)
  ) {
    throw new DomainError(
      'INVALID_PRICE',
      `${field} must be a positive plain decimal string`,
    );
  }
}

function assertPriceField(
  value: unknown,
  field: 'limitPrice' | 'triggerPrice',
  rule: PriceRule,
  type: OrderType,
): void {
  if (value === undefined) {
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
 * Validates a command that crossed a runtime boundary. The type-level union
 * already rejects impossible shapes, but decoded JSON and JavaScript callers
 * bypass it, so every implementation validates before acting.
 */
export function assertPlaceOrderCommand(
  command: unknown,
): asserts command is PlaceOrderCommand {
  if (typeof command !== 'object' || command === null) {
    throw new DomainError(
      'INVALID_ORDER',
      'a place order command must be an object',
    );
  }

  const candidate = command as Record<string, unknown>;

  assertIdentifier(candidate.sessionId, 'sessionId');
  assertIdentifier(candidate.idempotencyKey, 'idempotencyKey');
  assertIdentifier(candidate.symbol, 'symbol');
  assertMember(candidate.market, MARKETS, 'market');
  assertMember(candidate.side, SIDES, 'side');
  assertMember(candidate.type, ORDER_TYPES, 'type');

  if (typeof candidate.quantity !== 'string') {
    throw new DomainError(
      'INVALID_QUANTITY',
      'quantity must be a positive whole number',
    );
  }

  assertPositiveWholeQuantity(candidate.quantity);

  const rules = PRICE_RULES[candidate.type];

  assertPriceField(
    candidate.limitPrice,
    'limitPrice',
    rules.limitPrice,
    candidate.type,
  );
  assertPriceField(
    candidate.triggerPrice,
    'triggerPrice',
    rules.triggerPrice,
    candidate.type,
  );
}
