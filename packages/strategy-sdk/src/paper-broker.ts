import {
  type Currency,
  type DecimalString,
  DomainError,
  type DomainErrorCode,
  type OrderSnapshot,
  type OrderStatus,
  type PositionSnapshot,
  type Quantity,
  type WalletSnapshot,
} from '@skipjack/trading-core';
import {
  type Broker,
  type CancelOrderCommand,
  type ExchangeCommand,
  type ExchangeReceipt,
  type PlaceOrderCommand,
  type PortfolioSnapshot,
  readCancelOrderCommand,
  readExchangeCommand,
  readPlaceOrderCommand,
} from './broker.js';
import {
  assertIdentifier,
  isIsoInstant,
  isMoneyAmount,
  isNonNegativeWholeQuantity,
  isWholeNumber,
  projectOptionalField,
} from './validation.js';

const ORDERS_PATH = '/api/v1/orders';
const CONVERSIONS_PATH = '/api/v1/fx/conversions';
const PORTFOLIO_PATH = '/api/v1/portfolio';

/**
 * The paths this adapter is allowed to reach. There is no configurable base
 * path, so a strategy written against `PaperBroker` cannot be pointed at a live
 * venue by changing configuration.
 */
export type PaperBrokerPath =
  | typeof ORDERS_PATH
  | `${typeof ORDERS_PATH}/${string}`
  | typeof CONVERSIONS_PATH
  | typeof PORTFOLIO_PATH;

export interface PaperBrokerRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: PaperBrokerPath;
  /** Present on every write, absent on reads, and forwarded unchanged. */
  readonly idempotencyKey?: string;
  readonly body?: unknown;
}

export interface PaperBrokerResponse {
  readonly status: number;
  /** The decoded JSON payload. The transport owns parsing. */
  readonly body: unknown;
}

/**
 * The authenticated seam. The transport owns cookies, CSRF tokens, retries, and
 * every other session mechanic, so the SDK stores no anonymous token and needs
 * no browser API.
 */
export interface PaperBrokerTransport {
  request(request: PaperBrokerRequest): Promise<PaperBrokerResponse>;
}

const DOMAIN_ERROR_CODES: Readonly<Record<DomainErrorCode, true>> = {
  ACCOUNT_READ_ONLY: true,
  CANCEL_ONLY: true,
  CAPACITY_REACHED: true,
  IDEMPOTENCY_CONFLICT: true,
  INSUFFICIENT_AVAILABLE_CASH: true,
  INSUFFICIENT_AVAILABLE_POSITION: true,
  INVALID_ORDER: true,
  INVALID_PRICE: true,
  INVALID_QUANTITY: true,
  INVARIANT_VIOLATION: true,
  MARKET_CLOSED: true,
  MARKET_DATA_DEGRADED: true,
  ORDER_STATE_CONFLICT: true,
  PRICE_PROTECTION: true,
  RATE_LIMITED: true,
  RECOVERY_IN_PROGRESS: true,
  SERVICE_UNAVAILABLE: true,
  SYMBOL_NOT_TRADABLE: true,
};

const ORDER_STATUSES: Readonly<Record<OrderStatus, true>> = {
  CANCELLED: true,
  EXPIRED: true,
  FILLED: true,
  OPEN: true,
  PARTIALLY_FILLED: true,
  PENDING_TRIGGER: true,
  RECEIVED: true,
  REJECTED: true,
  TRIGGERED: true,
};

const CURRENCIES: Readonly<Record<Currency, true>> = { KRW: true, USD: true };

const isDomainErrorCode = (code: string): code is DomainErrorCode =>
  Object.hasOwn(DOMAIN_ERROR_CODES, code);

const isOrderStatus = (status: string): status is OrderStatus =>
  Object.hasOwn(ORDER_STATUSES, status);

const isCurrency = (currency: string): currency is Currency =>
  Object.hasOwn(CURRENCIES, currency);

/**
 * A response the paper API should never produce is a broken contract, not a
 * transient fault, so it is reported as a non-retryable invariant violation.
 */
function malformed(description: string): never {
  throw new DomainError(
    'INVARIANT_VIOLATION',
    `the paper API returned a malformed ${description}`,
  );
}

function readObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(description);
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    malformed(description);
  }

  return value;
}

/**
 * A money field is the whole reason this decoder exists. An unchecked balance
 * decodes fine and then detonates as a raw `DecimalError` deep inside strategy
 * arithmetic, far from the response that caused it, so every decimal the paper
 * API sends is held to trading-core's money domain right here.
 */
function readMoneyAmount(value: unknown, description: string): DecimalString {
  if (!isMoneyAmount(value)) {
    malformed(description);
  }

  return value;
}

function readWholeNumber(value: unknown, description: string): DecimalString {
  if (!isWholeNumber(value)) {
    malformed(description);
  }

  return value;
}

function readQuantity(value: unknown, description: string): Quantity {
  if (!isNonNegativeWholeQuantity(value)) {
    malformed(description);
  }

  return value;
}

function readInstant(value: unknown, description: string): string {
  if (!isIsoInstant(value)) {
    malformed(description);
  }

  return value;
}

function readVersion(value: unknown, description: string): bigint {
  return BigInt(readWholeNumber(value, description));
}

function readArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    malformed(description);
  }

  return value;
}

function decodeOrderSnapshot(payload: unknown): OrderSnapshot {
  const body = readObject(payload, 'order snapshot');
  const status = readString(body.status, 'order status');

  if (!isOrderStatus(status)) {
    malformed('order status');
  }

  const base: OrderSnapshot = {
    id: readString(body.id, 'order id'),
    status,
    version: readVersion(body.version, 'order version'),
  };
  // One read per optional field, for the same reason the command side reads each
  // caller field once: a response body is an object too, so its fields may be
  // accessors that answer differently twice. `terminalReason` is the sharp case,
  // because what the snapshot carries is a literal this decoder writes — a
  // second read would let it validate absence and emit a terminal reason the
  // paper API never reported, on an order it also reports as `OPEN`.
  const suppliedFilledQuantity = body.filledQuantity;
  const suppliedTerminalReason = body.terminalReason;
  const filledQuantity =
    suppliedFilledQuantity === undefined
      ? undefined
      : readQuantity(suppliedFilledQuantity, 'filled quantity');

  if (
    suppliedTerminalReason !== undefined &&
    suppliedTerminalReason !== 'IOC_REMAINDER'
  ) {
    malformed('order terminal reason');
  }

  return {
    ...base,
    ...(filledQuantity === undefined ? {} : { filledQuantity }),
    ...(suppliedTerminalReason === undefined
      ? {}
      : { terminalReason: 'IOC_REMAINDER' as const }),
  };
}

function decodeCurrency(payload: unknown, description: string): Currency {
  const currency = readString(payload, description);

  if (!isCurrency(currency)) {
    malformed(description);
  }

  return currency;
}

function decodeWallet(payload: unknown): WalletSnapshot {
  const body = readObject(payload, 'wallet snapshot');

  return {
    currency: decodeCurrency(body.currency, 'wallet currency'),
    total: readMoneyAmount(body.total, 'wallet total'),
    available: readMoneyAmount(body.available, 'wallet available'),
    reserved: readMoneyAmount(body.reserved, 'wallet reserved'),
    version: readVersion(body.version, 'wallet version'),
  };
}

function decodePosition(payload: unknown): PositionSnapshot {
  const body = readObject(payload, 'position snapshot');

  return {
    symbol: readString(body.symbol, 'position symbol'),
    total: readQuantity(body.total, 'position total'),
    available: readQuantity(body.available, 'position available'),
    reserved: readQuantity(body.reserved, 'position reserved'),
    version: readVersion(body.version, 'position version'),
  };
}

function decodeExchangeReceipt(
  payload: unknown,
  expectedSessionId: string,
): ExchangeReceipt {
  const body = readObject(payload, 'exchange receipt');

  return {
    id: readString(body.id, 'exchange id'),
    quoteId: readString(body.quoteId, 'exchange quote id'),
    sessionId: readSessionId(
      body.sessionId,
      expectedSessionId,
      'a conversion receipt',
    ),
    from: decodeCurrency(body.from, 'exchange source currency'),
    to: decodeCurrency(body.to, 'exchange target currency'),
    sourceAmount: readMoneyAmount(body.sourceAmount, 'exchange source amount'),
    rate: readMoneyAmount(body.rate, 'exchange rate'),
    fee: readMoneyAmount(body.fee, 'exchange fee'),
    targetAmount: readMoneyAmount(body.targetAmount, 'exchange target amount'),
    executedAt: readInstant(body.executedAt, 'exchange execution time'),
  };
}

/**
 * Every session-scoped response is checked back against the session the caller
 * named, so a transport wired to a different account cannot be mistaken for the
 * requested one on a read or on a write receipt.
 */
function readSessionId(
  value: unknown,
  expectedSessionId: string,
  description: string,
): string {
  const sessionId = readString(value, `${description} session id`);

  if (sessionId !== expectedSessionId) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `the paper API returned ${description} for session ${sessionId}`,
    );
  }

  return sessionId;
}

function decodePortfolioSnapshot(
  payload: unknown,
  expectedSessionId: string,
): PortfolioSnapshot {
  const body = readObject(payload, 'portfolio snapshot');
  const sessionId = readSessionId(
    body.sessionId,
    expectedSessionId,
    'a portfolio',
  );
  const wallets = readArray(body.wallets, 'portfolio wallets').map(
    decodeWallet,
  );
  const currencies = new Set(wallets.map((wallet) => wallet.currency));

  // Wallets are the only place a balance lives, so a duplicated currency would
  // be the one way two balances of the same currency could be conflated.
  if (currencies.size !== wallets.length) {
    malformed('portfolio wallet set');
  }

  const positions = readArray(body.positions, 'portfolio positions').map(
    decodePosition,
  );
  const symbols = new Set(positions.map((position) => position.symbol));

  // The same guard for positions: trading-core's own account invariant allows
  // at most one position per symbol, so a duplicate double-counts an exposure.
  if (symbols.size !== positions.length) {
    malformed('portfolio position set');
  }

  return {
    sessionId,
    wallets,
    positions,
    activeOrders: readArray(body.activeOrders, 'portfolio orders').map(
      decodeOrderSnapshot,
    ),
    // A sequence counts durable effects, so it is a whole number, not a rate.
    accountSequence: readWholeNumber(
      body.accountSequence,
      'portfolio account sequence',
    ),
  };
}

/**
 * Classifies a status the paper API did not pair with a code this SDK knows.
 * Every branch names the honest failure: telling a strategy its order was
 * invalid when the session expired or the key is already in flight invites the
 * one recovery that must not happen — reformulate and resend under a new key.
 */
function fallbackCode(status: number): DomainErrorCode {
  // 3xx is not an error envelope at all. The transport owns redirects, so a
  // redirect reaching the adapter is a broken contract, not a bad order.
  if (status < 400) {
    return 'INVARIANT_VIOLATION';
  }

  if (status === 401 || status === 403) {
    return 'ACCOUNT_READ_ONLY';
  }

  // 408 and 425 are transient by definition, and every write carries an
  // unchanged idempotency key, so a retry replays rather than duplicates.
  if (status === 408 || status === 425) {
    return 'SERVICE_UNAVAILABLE';
  }

  if (status === 409) {
    return 'ORDER_STATE_CONFLICT';
  }

  if (status === 429) {
    return 'RATE_LIMITED';
  }

  return status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INVALID_ORDER';
}

/**
 * Decodes a stable paper-API error envelope. A code trading-core already knows
 * is preserved exactly — deliberately in both directions, so a server that
 * reports `SERVICE_UNAVAILABLE` on a 4xx is believed over the status; that is
 * safe because retries replay under the same idempotency key. Anything else is
 * classified by status, and retryability always comes from trading-core's own
 * table rather than the wire.
 */
function decodeError(response: PaperBrokerResponse): DomainError {
  const body =
    typeof response.body === 'object' && response.body !== null
      ? (response.body as Record<string, unknown>)
      : {};
  const serverCode = typeof body.code === 'string' ? body.code : undefined;
  const code =
    serverCode !== undefined && isDomainErrorCode(serverCode)
      ? serverCode
      : fallbackCode(response.status);
  const parts = [
    typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : `the paper API responded with status ${response.status}`,
  ];

  if (serverCode !== undefined && serverCode !== code) {
    parts.push(`[${serverCode}]`);
  }

  if (typeof body.requestId === 'string' && body.requestId.length > 0) {
    parts.push(`(requestId ${body.requestId})`);
  }

  const message = parts.join(' ');
  const error = new DomainError(code, message);
  const retryAfter = body.retryAfter;

  if (
    typeof retryAfter === 'number' &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0 &&
    error.retryable
  ) {
    return new DomainError(code, message, { retryAfterSeconds: retryAfter });
  }

  return error;
}

/**
 * A thin adapter over an authenticated paper-API transport. It owns nothing but
 * request mapping, key forwarding, and response decoding.
 */
export class PaperBroker implements Broker {
  readonly #transport: PaperBrokerTransport;

  constructor(transport: PaperBrokerTransport) {
    this.#transport = transport;
  }

  async placeOrder(command: PlaceOrderCommand): Promise<OrderSnapshot> {
    // The snapshot the price rules were applied to, not the caller's object: a
    // command's fields may be accessors, and a second read of an accessor is a
    // second call into caller code that need not answer the same way.
    const validated = readPlaceOrderCommand(command);

    const body = {
      market: validated.market,
      symbol: validated.symbol,
      side: validated.side,
      type: validated.type,
      quantity: validated.quantity,
      // The snapshot is plain own data with no prototype, so this is the same
      // policy over the same values the validator saw: the wire carries exactly
      // the price fields it inspected — never one more, and never one fewer.
      ...projectOptionalField(validated, 'limitPrice'),
      ...projectOptionalField(validated, 'triggerPrice'),
    };

    return decodeOrderSnapshot(
      await this.#send({
        method: 'POST',
        path: ORDERS_PATH,
        idempotencyKey: validated.idempotencyKey,
        body,
      }),
    );
  }

  async cancelOrder(command: CancelOrderCommand): Promise<OrderSnapshot> {
    const { idempotencyKey, orderId } = readCancelOrderCommand(command);

    return decodeOrderSnapshot(
      await this.#send({
        method: 'DELETE',
        path: `${ORDERS_PATH}/${encodeURIComponent(orderId)}`,
        idempotencyKey,
      }),
    );
  }

  async exchange(command: ExchangeCommand): Promise<ExchangeReceipt> {
    const { sessionId, idempotencyKey, quoteId } = readExchangeCommand(command);

    return decodeExchangeReceipt(
      await this.#send({
        method: 'POST',
        path: CONVERSIONS_PATH,
        idempotencyKey,
        body: { quoteId },
      }),
      sessionId,
    );
  }

  async getPortfolio(sessionId: string): Promise<PortfolioSnapshot> {
    assertIdentifier(sessionId, 'sessionId');

    return decodePortfolioSnapshot(
      await this.#send({ method: 'GET', path: PORTFOLIO_PATH }),
      sessionId,
    );
  }

  async #send(request: PaperBrokerRequest): Promise<unknown> {
    const response = await this.#transport.request(request);

    if (response.status < 200 || response.status >= 300) {
      throw decodeError(response);
    }

    return response.body;
  }
}
