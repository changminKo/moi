# Paper API error contract

Every error response is JSON with `code`, `message`, `retryable`, and `requestId`. Retryable responses may include `retryAfter` in seconds when the server can estimate a safe retry delay; only rate limits and temporary service/market recovery states are retryable.

| Code | HTTP status | Retryable | Retry-After |
| --- | ---: | :---: | :---: |
| `SYMBOL_NOT_TRADABLE` | 409 | no | no |
| `MARKET_CLOSED` | 409 | no | no |
| `MARKET_DATA_DEGRADED` | 503 | yes | when estimable |
| `RECOVERY_IN_PROGRESS` | 503 | yes | when estimable |
| `CANCEL_ONLY` | 409 | no | no |
| `ACCOUNT_READ_ONLY` | 409 | no | no |
| `SERVICE_UNAVAILABLE` | 503 | yes | when estimable |
| `INSUFFICIENT_AVAILABLE_CASH` | 409 | no | no |
| `INSUFFICIENT_AVAILABLE_POSITION` | 409 | no | no |
| `PRICE_PROTECTION` | 409 | no | no |
| `ORDER_STATE_CONFLICT` | 409 | no | no |
| `IDEMPOTENCY_CONFLICT` | 409 | no | no |
| `RATE_LIMITED` | 429 | yes | when estimable |
| `CAPACITY_REACHED` | 409 | no | no |
| `INVALID_QUANTITY` | 400 | no | no |
| `INVALID_PRICE` | 400 | no | no |
| `INVALID_ORDER` | 400 | no | no |
| `INVARIANT_VIOLATION` | 500 | no | no |
| `VALIDATION_ERROR` | 400 | no | no |
| `SESSION_EXPIRED` | 401 | no | no |
| `FORBIDDEN` | 403 | no | no |
| `NOT_FOUND` | 404 | no | no |
| `QUOTE_EXPIRED` | 409 | no | no |
| `QUOTE_CONSUMED` | 409 | no | no |
| `PAYLOAD_TOO_LARGE` | 413 | no | no |
| `INTERNAL_ERROR` | 500 | no | no |

Conflict responses (HTTP 409) cover domain and capability denials, including market closure, cancel-only, insufficient funds/position, price protection, order state, idempotency, and capacity conflicts. `retryAfter` is never emitted for non-retryable errors.
