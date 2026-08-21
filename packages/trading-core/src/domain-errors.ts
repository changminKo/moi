export type DomainErrorCode =
  | 'SYMBOL_NOT_TRADABLE'
  | 'MARKET_CLOSED'
  | 'MARKET_DATA_DEGRADED'
  | 'RECOVERY_IN_PROGRESS'
  | 'CANCEL_ONLY'
  | 'ACCOUNT_READ_ONLY'
  | 'SERVICE_UNAVAILABLE'
  | 'INSUFFICIENT_AVAILABLE_CASH'
  | 'INSUFFICIENT_AVAILABLE_POSITION'
  | 'PRICE_PROTECTION'
  | 'ORDER_STATE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'CAPACITY_REACHED'
  | 'INVALID_QUANTITY'
  | 'INVALID_PRICE'
  | 'INVALID_ORDER'
  | 'INVARIANT_VIOLATION';

const retryableCodes: ReadonlySet<DomainErrorCode> = new Set([
  'MARKET_DATA_DEGRADED',
  'RECOVERY_IN_PROGRESS',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
]);

export interface DomainErrorOptions {
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    code: DomainErrorCode,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = options.retryable ?? retryableCodes.has(code);

    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}
