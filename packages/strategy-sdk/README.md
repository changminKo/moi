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

Every failure is a trading-core `DomainError`; no raw `TypeError` or
`DecimalError` escapes a public method. A code the domain already knows is
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
