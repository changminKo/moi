# @skipjack/strategy-sdk

The strategy-facing contract: the `Broker` interface a trading strategy is
written against, the `PaperBroker` adapter that speaks to the paper API, and the
executable contract suite every `Broker` implementation must pass.

```ts
import { PaperBroker, type Broker } from '@skipjack/strategy-sdk';
```

## Order commands

`PlaceOrderCommand` is a discriminated union on `type`, so an impossible order is
a compile error rather than a server rejection. The price rules are not a
preference — they mirror trading-core's executable gates, and
`src/broker.test.ts` pins them against those gates so drift fails CI:

| `type` | `limitPrice` | `triggerPrice` |
| --- | --- | --- |
| `MARKET` | forbidden | forbidden |
| `LIMIT` | required | forbidden |
| `STOP` | forbidden | required |
| `TAKE_PROFIT` | forbidden | required |
| `OCO` | required | required |

`STOP` and `TAKE_PROFIT` carry **no** limit price. `planReservation` — the
Task 4 gate every order passes before it can be accepted — requires
`limitPrice` to be absent for every non-`LIMIT` type and rejects the order with
`INVALID_ORDER` otherwise, so a stop-limit is not a shape the domain can
represent today. If stop-limit becomes a requirement, `reservation.ts` has to
model it first; widening this union alone would only move the failure from
compile time to runtime.

## OCO is a request shape, not a reservable order

`PlaceOcoOrderCommand` is a single command that the server desugars into the
two-leg group trading-core actually models: `limitPrice` becomes the `LIMIT`
leg's limit price and `triggerPrice` becomes the triggered leg's reference
price, which is exactly the pair `planOcoReservation` accepts. trading-core
excludes `'OCO'` from single-order reservation
(`ReservationOrder.type: Exclude<OrderType, 'OCO'>`), so an OCO placement is
only ever the group.

**Known limitation.** `Broker.placeOrder` returns one `OrderSnapshot`, so an OCO
placement cannot name its sibling leg or its group id, and `CancelOrderCommand`
addresses a single `orderId` rather than a group. A strategy that needs to track
or cancel both legs individually should place two separate orders — a `LIMIT`
and a `STOP` or `TAKE_PROFIT` — and manage the either-or itself.

## Sessions

The implementation owns the session: a `PaperBroker`'s transport holds the
cookie, and no command's `sessionId` is ever put on the wire. `sessionId` is a
scoping assertion, checked back against every response that names a session —
`getPortfolio` against the returned portfolio and `exchange` against the
receipt, both failing with `INVARIANT_VIOLATION` on a mismatch. `placeOrder` and
`cancelOrder` return an `OrderSnapshot`, which carries no session, so there is
nothing to compare. Use one broker per session rather than multiplexing
accounts over one instance.

## Errors

Every failure the SDK itself raises is a trading-core `DomainError`: no raw
`TypeError` or `DecimalError` escapes a public method, whether the input came
from a JavaScript caller or from the wire. The one thing that passes through
unwrapped is an error thrown by the caller's own code — an accessor or a `Proxy`
trap on a command object surfaces its own throw from the first property read,
because that read *is* caller code. A code the domain already knows is
preserved exactly and its retryability comes from trading-core's own table, not
from the wire. Anything else is classified by status:

| Status | Code | Retryable |
| --- | --- | --- |
| `3xx` | `INVARIANT_VIOLATION` | no |
| `401`, `403` | `ACCOUNT_READ_ONLY` | no |
| `408`, `425` | `SERVICE_UNAVAILABLE` | yes |
| `409` | `ORDER_STATE_CONFLICT` | no |
| `429` | `RATE_LIMITED` | yes |
| `5xx` | `SERVICE_UNAVAILABLE` | yes |
| other `4xx` | `INVALID_ORDER` | no |

A transient status stays retryable because every write forwards its idempotency
key unchanged, so a retry replays rather than duplicates. Conversely a `409`
must never read as `INVALID_ORDER`, whose natural recovery — reformulate and
resend under a new key — is exactly what a key already in flight forbids.

## Value formats on the boundary

Both directions — a command in, a payload out — are held to the *canonical*
plain form, which is narrower than what trading-core's own readers parse:

- **Money and prices** are non-negative plain decimals with no sign, no
  exponent, and no leading zero: `190.25`, `0.50`, `0`. trading-core's money
  reader also accepts `007` and `-5`; the SDK does not, because every value it
  emits or forwards is canonical `Decimal.toString()` output, which never has
  either. The magnitude bounds are trading-core's exact money domain, parsed
  through a private `Decimal` clone configured identically to trading-core's,
  with its exponent bounds stated rather than inherited — a clone captures them
  when it is made, and this module is made whenever a consumer first imports it,
  so a `Decimal.set` anywhere in the realm moves neither this boundary nor the
  order in which it was loaded.
- **Quantities** are plain positive whole numbers: `3`, not `1e3` or `0x10`,
  both of which `decimal.js` would read as `3000` and `16`. The wire carries the
  string verbatim, so the plain form is settled before the request is built.
- **Instants** (`ExchangeReceipt.executedAt`) are ISO-8601 in UTC with a
  trailing `Z` and at most nanosecond precision. A numeric offset form
  (`+09:00`) is rejected; a calendar-impossible date (`2026-02-30T00:00:00Z`) is
  accepted, because `Date.parse` rolls it over. `executedAt` feeds no
  arithmetic, so the exposure is a misleading timestamp rather than a bad
  computation.
- **A `retryAfter` hint** is kept only when it is a finite, non-negative number
  on an error that trading-core's own table calls retryable; it has no upper
  bound, because the ceiling belongs to whatever retry policy the caller runs.

## The boundary snapshot

A command type is an `interface`, so a class instance, a builder result, an
`Object.create` shape, and a `Proxy` all satisfy it — and a strategy that
computes its price from a live quote is the ordinary reason to use one. That
makes a property read a call into your code, and your code need not answer twice
the same way.

So every public method reads each field of its command **exactly once**, into a
plain snapshot with no prototype, then validates that snapshot and builds its
request from it. The value the price rules were applied to is therefore the
value on the wire, the `orderId` that was checked is the one in the path, and the
`idempotencyKey` that cleared the control-character guard is the one in the
header. `assertPlaceOrderCommand` reports whether a command's fields *were*
valid when read; it cannot promise a later read of the same object agrees, which
is why an implementation must act on a snapshot rather than re-read its
argument.

Presence is what ordinary property access means — prototype-inclusive — because
that is the only reading that accepts every shape the published types bless. One
consequence follows and is pinned by test: a polluted `Object.prototype.limitPrice`
is indistinguishable from a caller's own accessor, so it supplies a `LIMIT`
order's price, and it makes an ordinary `MARKET` order fail closed with
`INVALID_ORDER` at this boundary rather than at the engine. Own-property-only
presence would instead refuse the class and builder shapes the types bless, and
excluding `Object.prototype` by walking descriptors would refuse a `Proxy` whose
price exists only behind a `get` trap.

## The contract suite

`runBrokerContract(factory)` is the executable `Broker` contract. It is
published as a subpath so an implementation outside this package can run it:

```ts
import { describe } from 'vitest';
import {
  createFakeBroker,
  createPaperAccountFake,
  runBrokerContract,
  CONTRACT_SESSION_ID,
  CONTRACT_TERMINAL_ORDER_ID,
  CONTRACT_OPEN_ORDER_ID,
  CONTRACT_QUOTE_ID,
} from '@skipjack/strategy-sdk/testing';

describe('my broker', () => {
  runBrokerContract(() => ({
    broker: myBroker(),
    sessionId: CONTRACT_SESSION_ID,
    terminalOrderId: CONTRACT_TERMINAL_ORDER_ID,
    openOrderId: CONTRACT_OPEN_ORDER_ID,
    exchangeQuoteId: CONTRACT_QUOTE_ID,
  }));
});
```

The factory must build a harness over real state transitions; a forwarding mock
proves nothing about replay. The suite drives `vitest`, which is why it lives
behind `./testing` and not on the main entry point — the main entry's runtime
graph is `@skipjack/trading-core` and nothing else.
