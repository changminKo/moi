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
  assertPlaceOrderCommand,
  type Broker,
  type CancelOrderCommand,
  type ExchangeCommand,
  type ExchangeReceipt,
  type PlaceOrderCommand,
  type PortfolioSnapshot,
} from './broker.js';

const ORDERS_PATH = '/api/v1/orders';
const CONVERSIONS_PATH = '/api/v1/fx/conversions';
const PORTFOLIO_PATH = '/api/v1/portfolio';

const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/u;

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

function readDecimalString(value: unknown, description: string): DecimalString {
  return readString(value, description);
}

function readVersion(value: unknown, description: string): bigint {
  const raw = readString(value, description);

  if (!WHOLE_NUMBER.test(raw)) {
    malformed(description);
  }

  return BigInt(raw);
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
  const filledQuantity =
    body.filledQuantity === undefined
      ? undefined
      : (readDecimalString(body.filledQuantity, 'filled quantity') as Quantity);

  if (
    body.terminalReason !== undefined &&
    body.terminalReason !== 'IOC_REMAINDER'
  ) {
    malformed('order terminal reason');
  }

  return {
    ...base,
    ...(filledQuantity === undefined ? {} : { filledQuantity }),
    ...(body.terminalReason === undefined
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
    total: readDecimalString(body.total, 'wallet total'),
    available: readDecimalString(body.available, 'wallet available'),
    reserved: readDecimalString(body.reserved, 'wallet reserved'),
    version: readVersion(body.version, 'wallet version'),
  };
}

function decodePosition(payload: unknown): PositionSnapshot {
  const body = readObject(payload, 'position snapshot');

  return {
    symbol: readString(body.symbol, 'position symbol'),
    total: readDecimalString(body.total, 'position total'),
    available: readDecimalString(body.available, 'position available'),
    reserved: readDecimalString(body.reserved, 'position reserved'),
    version: readVersion(body.version, 'position version'),
  };
}

function decodeExchangeReceipt(payload: unknown): ExchangeReceipt {
  const body = readObject(payload, 'exchange receipt');

  return {
    id: readString(body.id, 'exchange id'),
    quoteId: readString(body.quoteId, 'exchange quote id'),
    sessionId: readString(body.sessionId, 'exchange session id'),
    from: decodeCurrency(body.from, 'exchange source currency'),
    to: decodeCurrency(body.to, 'exchange target currency'),
    sourceAmount: readDecimalString(
      body.sourceAmount,
      'exchange source amount',
    ),
    rate: readDecimalString(body.rate, 'exchange rate'),
    fee: readDecimalString(body.fee, 'exchange fee'),
    targetAmount: readDecimalString(
      body.targetAmount,
      'exchange target amount',
    ),
    executedAt: readString(body.executedAt, 'exchange execution time'),
  };
}

function decodePortfolioSnapshot(
  payload: unknown,
  expectedSessionId: string,
): PortfolioSnapshot {
  const body = readObject(payload, 'portfolio snapshot');
  const sessionId = readString(body.sessionId, 'portfolio session id');

  if (sessionId !== expectedSessionId) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `the paper API returned a portfolio for session ${sessionId}`,
    );
  }

  const wallets = readArray(body.wallets, 'portfolio wallets').map(
    decodeWallet,
  );
  const currencies = new Set(wallets.map((wallet) => wallet.currency));

  // Wallets are the only place a balance lives, so a duplicated currency would
  // be the one way two balances of the same currency could be conflated.
  if (currencies.size !== wallets.length) {
    malformed('portfolio wallet set');
  }

  return {
    sessionId,
    wallets,
    positions: readArray(body.positions, 'portfolio positions').map(
      decodePosition,
    ),
    activeOrders: readArray(body.activeOrders, 'portfolio orders').map(
      decodeOrderSnapshot,
    ),
    accountSequence: readDecimalString(
      body.accountSequence,
      'portfolio account sequence',
    ),
  };
}

function fallbackCode(status: number): DomainErrorCode {
  if (status === 429) {
    return 'RATE_LIMITED';
  }

  return status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INVALID_ORDER';
}

/**
 * Decodes a stable paper-API error envelope. A code trading-core already knows
 * is preserved exactly; anything else is classified by status so an unknown
 * server code never becomes a silently retried order.
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
    assertPlaceOrderCommand(command);

    const body = {
      market: command.market,
      symbol: command.symbol,
      side: command.side,
      type: command.type,
      quantity: command.quantity,
      ...(command.limitPrice === undefined
        ? {}
        : { limitPrice: command.limitPrice }),
      ...(command.triggerPrice === undefined
        ? {}
        : { triggerPrice: command.triggerPrice }),
    };

    return decodeOrderSnapshot(
      await this.#send({
        method: 'POST',
        path: ORDERS_PATH,
        idempotencyKey: command.idempotencyKey,
        body,
      }),
    );
  }

  async cancelOrder(command: CancelOrderCommand): Promise<OrderSnapshot> {
    assertCommandIdentifiers(command.sessionId, command.idempotencyKey);
    assertIdentifier(command.orderId, 'orderId');

    return decodeOrderSnapshot(
      await this.#send({
        method: 'DELETE',
        path: `${ORDERS_PATH}/${encodeURIComponent(command.orderId)}`,
        idempotencyKey: command.idempotencyKey,
      }),
    );
  }

  async exchange(command: ExchangeCommand): Promise<ExchangeReceipt> {
    assertCommandIdentifiers(command.sessionId, command.idempotencyKey);
    assertIdentifier(command.quoteId, 'quoteId');

    return decodeExchangeReceipt(
      await this.#send({
        method: 'POST',
        path: CONVERSIONS_PATH,
        idempotencyKey: command.idempotencyKey,
        body: { quoteId: command.quoteId },
      }),
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

const MAX_IDENTIFIER_LENGTH = 200;

function assertIdentifier(value: string, field: string): void {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new DomainError(
      'INVALID_ORDER',
      `${field} must be a non-empty identifier of at most ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
}

function assertCommandIdentifiers(
  sessionId: string,
  idempotencyKey: string,
): void {
  assertIdentifier(sessionId, 'sessionId');
  assertIdentifier(idempotencyKey, 'idempotencyKey');
}
