import { ApiError } from '../../lib/api-client';
import type { MessageKey } from '../../lib/i18n';

/**
 * The public error codes `POST /api/v1/orders` can answer this ticket with,
 * each with its own message. Kept as its own catalogue rather than folded into
 * the `reason.*` codes the capability banner uses: those say why trading is
 * degraded, these say why one order was refused, and the two contracts are
 * free to word the same situation differently.
 *
 * Taken from `docs/api/error-contract.md`, minus the codes only other routes
 * emit (`NOT_FOUND`, `QUOTE_EXPIRED`, `QUOTE_CONSUMED`,
 * `ORDER_STATE_CONFLICT` — that one belongs to amend and cancel). A code
 * missing from here is not a crash: `describePlacementFailure` falls back to a
 * sentence that still carries the code.
 */
const FAILURE_KEYS = {
  SYMBOL_NOT_TRADABLE: 'orderError.SYMBOL_NOT_TRADABLE',
  MARKET_CLOSED: 'orderError.MARKET_CLOSED',
  MARKET_DATA_DEGRADED: 'orderError.MARKET_DATA_DEGRADED',
  RECOVERY_IN_PROGRESS: 'orderError.RECOVERY_IN_PROGRESS',
  CANCEL_ONLY: 'orderError.CANCEL_ONLY',
  ACCOUNT_READ_ONLY: 'orderError.ACCOUNT_READ_ONLY',
  SERVICE_UNAVAILABLE: 'orderError.SERVICE_UNAVAILABLE',
  INSUFFICIENT_AVAILABLE_CASH: 'orderError.INSUFFICIENT_AVAILABLE_CASH',
  INSUFFICIENT_AVAILABLE_POSITION: 'orderError.INSUFFICIENT_AVAILABLE_POSITION',
  PRICE_PROTECTION: 'orderError.PRICE_PROTECTION',
  IDEMPOTENCY_CONFLICT: 'orderError.IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'orderError.RATE_LIMITED',
  CAPACITY_REACHED: 'orderError.CAPACITY_REACHED',
  INVALID_QUANTITY: 'orderError.INVALID_QUANTITY',
  INVALID_PRICE: 'orderError.INVALID_PRICE',
  INVALID_ORDER: 'orderError.INVALID_ORDER',
  VALIDATION_ERROR: 'orderError.VALIDATION_ERROR',
  SESSION_EXPIRED: 'orderError.SESSION_EXPIRED',
  FORBIDDEN: 'orderError.FORBIDDEN',
  PAYLOAD_TOO_LARGE: 'orderError.PAYLOAD_TOO_LARGE',
  INVARIANT_VIOLATION: 'orderError.INVARIANT_VIOLATION',
  INTERNAL_ERROR: 'orderError.INTERNAL_ERROR',
} as const satisfies Readonly<Record<string, MessageKey>>;

/** What the ticket needs to word a rejection; never the error object itself. */
export type PlacementFailure = Readonly<{
  key: MessageKey;
  /** Only for a code with no message of its own, so the sentence can name it. */
  code?: string;
  /** The support handle, when the server stated one. */
  requestId?: string;
}>;

/**
 * How the ticket words a successful placement.
 *
 * The endpoint answers `{ id, status, filledQuantity: "0", quantity }` — a
 * MARKET order comes back `OPEN` with nothing filled and is filled moments
 * later over the stream, so the message says *accepted*, not *filled*. It says
 * no more than that: the fill announces itself now
 * (`features/notifications/fill-toasts.tsx`), which is what let this sentence
 * lose the clause that used to promise it.
 *
 * A STOP or TAKE_PROFIT (and an OCO's legs) come back `PENDING_TRIGGER` and
 * keep the longer wording. They may wait indefinitely and emit nothing at all
 * until the trigger is hit, so no toast will ever speak for them; the clause
 * is the only thing standing between a resting order and a reader who thinks
 * nothing happened.
 *
 * The response body is not validated on the wire, so anything unrecognisable
 * degrades to plain acceptance: the request did succeed, and inventing a
 * status the server never sent would be the only dishonest option here.
 */
export function placementMessageKey(response: unknown): MessageKey {
  const status =
    typeof response === 'object' &&
    response !== null &&
    typeof (response as { status?: unknown }).status === 'string'
      ? (response as { status: string }).status
      : undefined;
  return status === 'PENDING_TRIGGER'
    ? 'ticket.placedPendingTrigger'
    : 'ticket.placedOpen';
}

export function describePlacementFailure(error: unknown): PlacementFailure {
  if (!(error instanceof ApiError)) return { key: 'ticket.rejected' };
  // `api-client.ts` writes 'unknown' when the body states no request id;
  // showing that string would read as an id rather than as its absence.
  const requestId =
    error.requestId && error.requestId !== 'unknown'
      ? { requestId: error.requestId }
      : {};
  const known = (FAILURE_KEYS as Readonly<Record<string, MessageKey>>)[
    error.code
  ];
  return known === undefined
    ? { key: 'ticket.rejectedWithCode', code: error.code, ...requestId }
    : { key: known, ...requestId };
}
