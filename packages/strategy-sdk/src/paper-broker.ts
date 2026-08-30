import {
  type Currency,
  type DecimalString,
  DomainError,
  type DomainErrorCode,
  type Market,
  type OrderStatus,
  type Quantity,
} from '@moi/trading-core';
import {
  type Broker,
  type BrokerOrder,
  type BrokerPortfolio,
  type BrokerPosition,
  type BrokerWallet,
  type CancelOrderCommand,
  type ExchangeCommand,
  type ExchangeReceipt,
  type PlaceOrderCommand,
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
 * path, so a strategy cannot make this adapter request an endpoint the paper
 * API does not serve.
 *
 * What this does **not** do is pin the host: `PaperBrokerTransport` builds the
 * URL, so the origin is the transport's to choose and a misconfigured one
 * reaches whatever it names. Keeping a strategy off a live venue is therefore
 * the transport's obligation — pin the origin there against an allow-list — and
 * an earlier version of this comment claimed the path union alone achieved it,
 * which it never did.
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
  SESSION_EXPIRED: true,
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

const MARKETS: Readonly<Record<Market, true>> = { KR: true, US: true };

const isDomainErrorCode = (code: string): code is DomainErrorCode =>
  Object.hasOwn(DOMAIN_ERROR_CODES, code);

const isOrderStatus = (status: string): status is OrderStatus =>
  Object.hasOwn(ORDER_STATUSES, status);

const isCurrency = (currency: string): currency is Currency =>
  Object.hasOwn(CURRENCIES, currency);

const isMarket = (market: string): market is Market =>
  Object.hasOwn(MARKETS, market);

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

function readArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    malformed(description);
  }

  return value;
}

function decodeOrder(payload: unknown): BrokerOrder {
  const body = readObject(payload, 'order snapshot');
  const status = readString(body.status, 'order status');

  if (!isOrderStatus(status)) {
    malformed('order status');
  }

  const base: BrokerOrder = {
    id: readString(body.id, 'order id'),
    status,
  };
  // One read per optional field, for the same reason the command side reads each
  // caller field once: a response body is an object too, so its fields may be
  // accessors that answer differently twice. `terminalReason` is the sharp case,
  // because what the snapshot carries is a literal this decoder writes — a
  // second read would let it validate absence and emit a terminal reason the
  // paper API never reported, on an order it also reports as `OPEN`.
  const suppliedFilledQuantity = body.filledQuantity;
  const suppliedTerminalReason = body.terminalReason;
  // The paper API spells an absent optional field `null` — its order rows come
  // straight from nullable ledger columns — while a placement response omits
  // the key entirely. Both mean the same thing, and treating only `undefined`
  // as absence made every portfolio read fail on the first order that had no
  // terminal reason. A *wrong* value is still malformed.
  const filledQuantity =
    suppliedFilledQuantity === undefined || suppliedFilledQuantity === null
      ? undefined
      : readQuantity(suppliedFilledQuantity, 'filled quantity');
  const terminalReason =
    suppliedTerminalReason === null ? undefined : suppliedTerminalReason;

  if (terminalReason !== undefined && terminalReason !== 'IOC_REMAINDER') {
    malformed('order terminal reason');
  }

  return {
    ...base,
    ...(filledQuantity === undefined ? {} : { filledQuantity }),
    ...(terminalReason === undefined
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

function decodeMarket(payload: unknown, description: string): Market {
  const market = readString(payload, description);

  if (!isMarket(market)) {
    malformed(description);
  }

  return market;
}

function decodeWallet(payload: unknown): BrokerWallet {
  const body = readObject(payload, 'wallet snapshot');

  return {
    currency: decodeCurrency(body.currency, 'wallet currency'),
    total: readMoneyAmount(body.total, 'wallet total'),
    available: readMoneyAmount(body.available, 'wallet available'),
    reserved: readMoneyAmount(body.reserved, 'wallet reserved'),
  };
}

function decodePosition(payload: unknown): BrokerPosition {
  const body = readObject(payload, 'position snapshot');

  return {
    market: decodeMarket(body.market, 'position market'),
    symbol: readString(body.symbol, 'position symbol'),
    total: readQuantity(body.total, 'position total'),
    available: readQuantity(body.available, 'position available'),
    reserved: readQuantity(body.reserved, 'position reserved'),
    // A position values what it holds, so its average cost is money the
    // strategy sizes and marks against — never a JS number.
    averageCost: readMoneyAmount(body.averageCost, 'position average cost'),
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

function decodePortfolio(
  payload: unknown,
  expectedSessionId: string,
): BrokerPortfolio {
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
      decodeOrder,
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

  // 401 and 403 are different recoveries and must not be collapsed. An expired
  // session is re-established and the write retried under its unchanged key;
  // a forbidden request is the account itself refusing, and retrying it is
  // exactly the loop that must not happen. The paper API names both
  // (`SESSION_EXPIRED` 401, `FORBIDDEN` 403 in the error contract), so this
  // fallback only decides when the envelope carried no code at all.
  if (status === 401) {
    return 'SESSION_EXPIRED';
  }

  if (status === 403) {
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
function decodeError(status: number, payload: unknown): DomainError {
  const body =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  // One read per field, bound before it is inspected, for the same reason the
  // command side snapshots its argument: an envelope is an object too, so its
  // fields may be accessors, and the value that reaches the `DomainError` has to
  // be the value that was type-checked. `code` is the sharp one — a strategy
  // compares it against `'RATE_LIMITED'` before deciding to retry, and
  // `Object.hasOwn` coerces its key, so an object whose `toString` names a
  // retryable code would pass the check on read one and land in the error on
  // read two.
  const suppliedCode = body.code;
  const suppliedMessage = body.message;
  const suppliedRequestId = body.requestId;
  const retryAfter = body.retryAfter;
  const serverCode =
    typeof suppliedCode === 'string' ? suppliedCode : undefined;
  const code =
    serverCode !== undefined && isDomainErrorCode(serverCode)
      ? serverCode
      : fallbackCode(status);
  const parts = [
    typeof suppliedMessage === 'string' && suppliedMessage.length > 0
      ? suppliedMessage
      : `the paper API responded with status ${status}`,
  ];

  if (serverCode !== undefined && serverCode !== code) {
    parts.push(`[${serverCode}]`);
  }

  if (typeof suppliedRequestId === 'string' && suppliedRequestId.length > 0) {
    parts.push(`(requestId ${suppliedRequestId})`);
  }

  const message = parts.join(' ');
  const error = new DomainError(code, message);

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

  async placeOrder(command: PlaceOrderCommand): Promise<BrokerOrder> {
    // The snapshot the price rules were applied to, not the caller's object: a
    // command's fields may be accessors, and a second read of an accessor is a
    // second call into caller code that need not answer the same way.
    const validated = readPlaceOrderCommand(command);

    const common = {
      market: validated.market,
      symbol: validated.symbol,
      side: validated.side,
      quantity: validated.quantity,
    };
    // `placeOrderSchema` is `.strict()`, so the body carries the fields that
    // type accepts and no others. An OCO is the one type whose request shape
    // differs from the command's: the API takes two explicit legs, so the pair
    // the command expresses flatly is expanded here rather than on the server.
    const body =
      validated.type === 'OCO'
        ? {
            ...common,
            type: 'OCO' as const,
            legs: [
              {
                ...common,
                type: 'LIMIT' as const,
                limitPrice: validated.limitPrice as DecimalString,
              },
              {
                ...common,
                type: 'STOP' as const,
                stopPrice: validated.stopPrice as DecimalString,
              },
            ],
          }
        : {
            ...common,
            type: validated.type,
            // The snapshot is plain own data with no prototype, so this is the
            // same policy over the same values the validator saw: the wire
            // carries exactly the price fields it inspected — never one more,
            // and never one fewer.
            ...projectOptionalField(validated, 'limitPrice'),
            ...projectOptionalField(validated, 'stopPrice'),
          };

    return decodeOrder(
      await this.#send({
        method: 'POST',
        path: ORDERS_PATH,
        idempotencyKey: validated.idempotencyKey,
        body,
      }),
    );
  }

  async cancelOrder(command: CancelOrderCommand): Promise<BrokerOrder> {
    const { idempotencyKey, orderId } = readCancelOrderCommand(command);

    return decodeOrder(
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

  async getPortfolio(sessionId: string): Promise<BrokerPortfolio> {
    assertIdentifier(sessionId, 'sessionId');

    return decodePortfolio(
      await this.#send({ method: 'GET', path: PORTFOLIO_PATH }),
      sessionId,
    );
  }

  async #send(request: PaperBrokerRequest): Promise<unknown> {
    // The transport is caller code as well, so its answer crosses a runtime
    // boundary like a command does: it is narrowed before it is destructured,
    // then `status` and `body` are read once each and the decoders downstream
    // work from that one read. A transport that resolves to something that is
    // not a response is breaking its own declared `Promise<PaperBrokerResponse>`
    // — a broken contract on this seam, not a bad order — so it fails as a
    // `DomainError` rather than as a raw `TypeError` from the destructuring.
    const response: unknown = await this.#transport.request(request);

    if (
      typeof response !== 'object' ||
      response === null ||
      Array.isArray(response)
    ) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'the paper API transport returned a malformed response',
      );
    }

    const { status, body } = response as PaperBrokerResponse;

    // A whole number, not merely a `number`: `status < 200 || status >= 300` is
    // `false` in both halves for `NaN`, so a status that never was one would
    // otherwise take the success path and have its body decoded as a snapshot.
    if (!Number.isInteger(status)) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'the paper API returned a malformed response status',
      );
    }

    if (status < 200 || status >= 300) {
      throw decodeError(status, body);
    }

    return body;
  }
}
