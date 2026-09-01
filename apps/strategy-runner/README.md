# @moi/strategy-runner

The trading bot's process: it reads the market through the paper API, asks each
configured strategy what to do, filters that through a risk gate, and places the
orders that survive. It is the runner of
[`docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md`](../../docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md),
at its **phase B** scope.

## What is here, and what is not

Phase B is the skeleton: configuration, session persistence, a REST market feed,
durable state, the risk gate, and the order gateway. Its done-criterion is one
order round-tripping in an integration test and restart idempotency, and both
are pinned in
[`apps/paper-api/src/runtime/strategy-runner.integration.test.ts`](../paper-api/src/runtime/strategy-runner.integration.test.ts).

Deliberately **not** here:

| Not in B | Where it belongs | Why it is not pulled forward |
|---|---|---|
| WS quote subscription, reconnection, gap backfill, the fill cursor | C (§11) | The REST feed round-trips an order on its own, so nothing in B needs them |
| Mid-price derivation and its tick-size rounding | C | `projectQuote` already decides the price; see below |
| Realised PnL, consecutive-loss and daily-loss limits | C (§6.4) | They need fills, which need the account-event cursor |
| The kill-switch submission barrier, Discord, the compose service | D (§7.2, §8.1) | The `Reporter` seam and the state layout are here; the wiring is not |
| Backtesting, a second strategy | E | — |

## The boundary

The runner depends on `@moi/strategy-sdk` and `@moi/trading-core` and nothing
else (design §3). It never imports `@moi/paper-api` or `@moi/market-data` and
never touches the database. `src/package-surface.test.ts` pins both halves: the
manifest, which is what actually makes the import unresolvable under pnpm's
isolated `node_modules`, and a scan of the source, which is what states the rule
where a reader will find it.

The integration test that needs a real paper API therefore lives in
`apps/paper-api`, which takes this package as a devDependency — the same
direction `paper-broker-contract.integration.test.ts` already points.

## Configuration

| Variable | Meaning |
|---|---|
| `BOT_API_ORIGIN` | Where the runner connects. Checked against a **code constant** allow-list; an unrecognised host refuses to start (§4.1) |
| `BOT_PUBLIC_ORIGIN` | The `Origin` header value, which must equal the paper API's own `PUBLIC_ORIGIN` (§4.2). Defaults to `BOT_API_ORIGIN`, which is right only when the two are the same host |
| `BOT_CONFIG_PATH` | The JSON configuration file |
| `BOT_STATE_DIR` | Where the state store lives. A compose volume in deployment (§8.1) |

The two origins are separate because in compose the bot reaches
`http://paper-api:3000` while the public origin is the browser app's — sending
the connect target as the header is answered 403 on every mutation.

Nothing in the configuration file defaults. A risk limit that quietly defaults is
exactly the value an operator should have had to write down, which is the
judgement `defineParameterSchema` already makes for strategy parameters.

```json
{
  "pollIntervalMs": 1000,
  "gapAfterMs": 5000,
  "risk": {
    "symbolAllowList": [{ "market": "KR", "symbol": "005930" }],
    "maxOrderNotional": "1000000",
    "maxDailyNotional": "5000000",
    "maxPositionQuantity": "100",
    "maxOpenOrders": 4,
    "tradingHoursOnly": true,
    "maxQuoteAgeMs": 5000
  },
  "strategies": [
    {
      "name": "samsung",
      "strategyId": "sma-crossover",
      "params": {
        "market": "KR",
        "symbol": "005930",
        "fastPeriod": 5,
        "slowPeriod": 20,
        "quantity": "1"
      }
    }
  ]
}
```

Startup refuses: an origin off the allow-list, two strategies claiming one
instrument (§6.3), more than four subscriptions (§5.3), a strategy subscribed to
an instrument the gate would refuse every order for, a money limit outside the
exact money domain, and anything the strategy's own parameter schema rejects.

## The four decisions phase B had to make

### The state store is two things, not one

Design §8.1 names append-only NDJSON. That is right for **events** — a decision
was taken, a submission had an outcome — and wrong for **current values** — the
session, the feed cursors, each strategy's window. So:

- `decisions.ndjson` and `submissions.ndjson` are append-only through one
  descriptor. A crash can only truncate the end, so a torn trailing record is
  discarded and a damaged record anywhere else fails closed.
- `session.json` (0600) and `runtime.json` are replaced atomically —
  create, fsync, rename, fsync the directory.

The fsync is **on demand**: a decision that authorises an order is fsynced before
the order is submitted, and a `noop` is not. Losing the tail of "why the strategy
stood still" across a power cut costs audit detail and no correctness, and paying
an fsync per tick would put the cost where the argument does not need it.

The index is in memory, rebuilt from the logs at startup — which is what §8.1
already asks for. An on-disk index would be a second copy of a fact the log
already holds, and a second copy is a thing that can disagree after a crash.

Not solved: the logs do not rotate. Roughly 17 MB a day at one decision per
second, all of it read at startup. Rotation needs a retention rule an operator
agrees to, and belongs with the deployment work.

### Restart idempotency is an ordering, not a cache

`OrderGateway` follows §6.2 exactly: append the decision durably, derive the key
from the recorded `decisionId`, promote the intent, submit. The runner never
remembers a key — it remembers a decision, and
`sha256('moi-strategy-runner:idempotency:v1:' + decisionId)` follows. Because the
append is fsynced first, there is no instant at which an order exists that the
state does not know about; because the ledger scopes idempotency by
`(session_id, key)`, resubmitting a recovered decision replays the original
order.

The reverse ordering is the failure this prevents: submit, then record, and a
crash between leaves an order the runner will never recognise as its own, so the
next tick decides again under a new key and the position doubles.

### A gap is time not observing

Phase A discards a strategy's whole window on a `gapBefore` tick, so deciding
when it is true matters. The obvious rule — "the first tick after a restart" — is
wrong both ways: it discards the window `snapshot()` exists to restore on every
two-second container replacement, and says nothing about a runner that stayed up
while every poll failed.

So `gapBefore` is true when more than `gapAfterMs` has passed since the last poll
that **saw** the instrument. One rule covers a first run, a restart, a poll
outage and an API that was down, because all four are the same fact. A
`recoveryEpoch` advance is a gap regardless of elapsed time. A quiet market is
not a gap: the clock is advanced by every poll that saw a price, not by every
tick emitted.

Every price in B is `priceSource: 'rest-snapshot'`. `projectQuote` has already
decided what the instrument costs, so deriving a second answer from the book in
the same payload would make the runner and the API disagree — and would mean
inventing a rounding mode that phase C then rewrites.

### A strategy that throws is contained, then quarantined

A throw from `onTick` does not reach the poll loop: the tick is abandoned,
nothing is submitted, the failure is reported, and the other strategies carry on.
After **three consecutive** throws the strategy is quarantined and stops
receiving ticks.

Consecutive rather than cumulative, because phase A's remaining throwing case — a
malformed price — recovers on the next valid tick, and a cumulative counter would
eventually quarantine a strategy behaving exactly as designed. One good tick
clears the count.

Quarantine is not a kill switch. It stops a broken decision path from producing
more decisions; it does **not** cancel resting orders or close a position — that
is the barrier of §7.2, in phase D. It is held in memory and re-derived after a
restart, because a quarantine on disk would mean a bot that cannot restart itself
out of a transient fault without someone deleting a file.

## Where the risk gate stops

Two rules apply to every order — the instrument must be allow-listed, and the
market must be open if `tradingHoursOnly` is set. Every *limit* applies to a
`BUY` only. A limit exists to cap exposure, and refusing an exit does not cap
exposure, it traps it: a bot at its open-order cap that cannot place the closing
order holds the position until a person notices. §6.3 already words quote
freshness as refusing an *entry*; this is that reading applied to the rest.

`activeOrders` carries terminal orders too (#33), so the runner filters by status
itself, as §1 row 12 says to until that lands.
