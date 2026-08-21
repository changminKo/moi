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

const retryabilityByCode: Record<DomainErrorCode, boolean> = {
  SYMBOL_NOT_TRADABLE: false,
  MARKET_CLOSED: false,
  MARKET_DATA_DEGRADED: true,
  RECOVERY_IN_PROGRESS: true,
  CANCEL_ONLY: false,
  ACCOUNT_READ_ONLY: false,
  SERVICE_UNAVAILABLE: true,
  INSUFFICIENT_AVAILABLE_CASH: false,
  INSUFFICIENT_AVAILABLE_POSITION: false,
  PRICE_PROTECTION: false,
  ORDER_STATE_CONFLICT: false,
  IDEMPOTENCY_CONFLICT: false,
  RATE_LIMITED: true,
  CAPACITY_REACHED: false,
  INVALID_QUANTITY: false,
  INVALID_PRICE: false,
  INVALID_ORDER: false,
  INVARIANT_VIOLATION: false,
};

export interface DomainErrorOptions {
  readonly retryAfterSeconds?: number;
}

// Identity-only brand. `WeakSet.prototype.has` compares by SameValue, so
// classification never reads a property or triggers a proxy trap on a value
// thrown by untrusted code.
const domainErrorBrand = new WeakSet<object>();

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
    this.retryable = retryabilityByCode[code];

    if (options.retryAfterSeconds !== undefined) {
      if (!this.retryable) {
        throw new RangeError(
          'retryAfterSeconds is only valid for retryable domain errors',
        );
      }

      this.retryAfterSeconds = options.retryAfterSeconds;
    }

    domainErrorBrand.add(this);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return (
    typeof value === 'object' && value !== null && domainErrorBrand.has(value)
  );
}
