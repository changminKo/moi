import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * Public error codes from `docs/api/error-contract.md`. Only these may reach a
 * client verbatim; any other 4xx/5xx collapses to INTERNAL_ERROR so driver or
 * framework codes never leak. `error-handler.test.ts` keeps this list equal to
 * the contract table.
 */
export const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  'ACCOUNT_READ_ONLY',
  'CANCEL_ONLY',
  'CAPACITY_REACHED',
  'FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'INSUFFICIENT_AVAILABLE_CASH',
  'INSUFFICIENT_AVAILABLE_POSITION',
  'INTERNAL_ERROR',
  'INVALID_ORDER',
  'INVALID_PRICE',
  'INVALID_QUANTITY',
  'INVARIANT_VIOLATION',
  'MARKET_CLOSED',
  'MARKET_DATA_DEGRADED',
  'NOT_FOUND',
  'ORDER_STATE_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'PRICE_PROTECTION',
  'QUOTE_CONSUMED',
  'QUOTE_EXPIRED',
  'RATE_LIMITED',
  'RECOVERY_IN_PROGRESS',
  'SERVICE_UNAVAILABLE',
  'SESSION_EXPIRED',
  'SYMBOL_NOT_TRADABLE',
  'VALIDATION_ERROR',
]);

const CONFLICT_CODES = new Set([
  'SYMBOL_NOT_TRADABLE',
  'MARKET_CLOSED',
  'CANCEL_ONLY',
  'ACCOUNT_READ_ONLY',
  'INSUFFICIENT_AVAILABLE_CASH',
  'INSUFFICIENT_AVAILABLE_POSITION',
  'PRICE_PROTECTION',
  'ORDER_STATE_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'CAPACITY_REACHED',
  'QUOTE_EXPIRED',
  'QUOTE_CONSUMED',
]);
const UNAVAILABLE_CODES = new Set([
  'MARKET_DATA_DEGRADED',
  'RECOVERY_IN_PROGRESS',
  'SERVICE_UNAVAILABLE',
]);

/** HTTP status the error contract assigns to a domain error code. */
export function httpStatusFor(code: string): number {
  if (CONFLICT_CODES.has(code)) return 409;
  if (UNAVAILABLE_CODES.has(code)) return 503;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'SESSION_EXPIRED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'INVARIANT_VIOLATION' || code === 'INTERNAL_ERROR') return 500;
  return 400;
}

interface StableError {
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
  readonly requestId: string;
}

function stableError(
  error: FastifyError,
  requestId: string,
): { status: number; body: StableError } {
  const status = error.statusCode ?? 500;
  if (status === 404) {
    return {
      status,
      body: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        retryable: false,
        requestId,
      },
    };
  }
  if (status === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      status: 413,
      body: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
        retryable: false,
        requestId,
      },
    };
  }
  if (status === 400 || error.validation) {
    return {
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        retryable: false,
        requestId,
      },
    };
  }
  // Domain and route errors that carry a contract code (for example
  // `CANCEL_ONLY` with 409) keep it; anything outside the whitelist collapses
  // to INTERNAL_ERROR so nothing internal leaks.
  if (
    status >= 400 &&
    status < 500 &&
    typeof error.code === 'string' &&
    PUBLIC_ERROR_CODES.has(error.code)
  ) {
    return {
      status,
      body: {
        code: error.code,
        message: error.message,
        retryable: false,
        requestId,
      },
    };
  }
  if (status === 403) {
    return {
      status,
      body: {
        code: 'FORBIDDEN',
        message: 'Request origin is not allowed',
        retryable: false,
        requestId,
      },
    };
  }
  return {
    status: status >= 400 && status < 600 ? status : 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: false,
      requestId,
    },
  };
}

export async function registerErrorHandler(
  app: FastifyInstance,
): Promise<void> {
  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(stableError({ statusCode: 404 } as FastifyError, request.id).body);
  });
  app.setErrorHandler((error, request, reply) => {
    const result = stableError(error as FastifyError, request.id);
    reply.code(result.status).send(result.body);
  });
}
