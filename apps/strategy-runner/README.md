# @moi/strategy-runner

The trading bot's process: it reads the market through the paper API, asks each
configured strategy what to do, filters that through a risk gate, and places the
orders that survive. It is the runner of
[`docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md`](../../docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md),
at its **phase C** scope.

## What is here, and what is not

Phase B was the skeleton: configuration, session persistence, a REST market feed,
durable state, the risk gate, and the order gateway. Phase C adds the parts that
need a live connection — the stream subscription, its reconnection, the REST
re-baseline after an outage, and the account-event cursor that makes `onFill`
exactly-once — and, on top of that cursor, realised PnL and §6.4's two loss
limits.

The done-criteria are pinned in
[`apps/paper-api/src/runtime/strategy-runner.integration.test.ts`](../paper-api/src/runtime/strategy-runner.integration.test.ts)
(B: one order round-trips, restart idempotency) and
[`strategy-runner-stream.integration.test.ts`](../paper-api/src/runtime/strategy-runner-stream.integration.test.ts)
(C: a fill delivered once across a hard kill, and once across a reconnect).

Deliberately **not** here:

| Not in C | Where it belongs | Why it is not pulled forward |
|---|---|---|
| The kill-switch submission barrier, Discord, the compose service | D (§7.2, §8.1) | The `Reporter` seam and the state layout are here; the wiring is not |
| Escalating a tripped loss limit past "refuse new entries" | D | That escalation *is* the §7.2 barrier |
| Backtesting, a second strategy | E | — |
| Mid-price derivation and its tick-size rounding | nowhere — see below | §5.2's premise no longer holds |

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
    "maxQuoteAgeMs": 5000,
    "maxConsecutiveLosses": 3,
    "maxDailyLoss": "200000"
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

## What the state store holds after phase C

| File | Shape | Unit of atomicity |
|---|---|---|
| `decisions.ndjson` | append-only | one decision |
| `submissions.ndjson` | append-only | one outcome |
| `fills.ndjson` | append-only | **one account event** — see below |
| `session.json` (0600) | atomic replace | the current session |
| `runtime.json` | atomic replace | feed cursors and strategy snapshots |

There is no `cursor.json`, though §8.1 lists one. See "the transaction is the
line".

## The decisions phase C had to make

### The transaction is the line

§6.4 requires the event processing and the cursor advance to be recorded in one
transaction — that is what makes `onFill` exactly-once. There is no transaction
manager on an append-only substrate, so the transaction is **one record**:
`fills.ndjson` holds, per account event, the fills it announced, the position
each moved, what each realised, the ids of the decisions `onFill` returned, and
the new cursor. One `write`, one `fsync`, and a reader that discards a torn
trailing record.

Everything that could have been a second file is in that line for that reason. A
`cursor.json` beside the journal is a second copy of a fact the journal already
holds, and after a crash the two can disagree about whether an event was
processed. The positions are there rather than in `runtime.json` for the same
reason: a position one fill ahead of the cursor would have a replay apply a fill
the position already had.

What that buys, precisely:

- **A committed step never runs again.** Its `eventId` and every `fillId` are
  indexed, and the cursor has moved past it, so neither the stream's replay from
  `afterSequence` nor a restart re-delivers it.
- **An uncommitted step runs again and produces the same result**, because a
  decision `onFill` returns takes a `decisionId` derived from
  `(accountSequence, strategy, index)` rather than a fresh UUID. The replay
  recomputes the same id, `appendDecision` is idempotent by it, and the gateway
  submits under the same key — which the ledger replays.

So `onFill` is at most once per committed step and at least once per event, and
those coincide except across a crash inside one step, where the repeat is
invisible in the ledger. No fill produces two orders and no fill produces none,
which is what the phase's criterion asks.

### An event is the trigger; the portfolio is the detail

The outbox payload for a fill is
`{ orderId, status, filledQuantity, recoveryEpoch, recoveryFill }` — a cumulative
quantity, and no price, fee or fill id. `FillEvent` needs all three and realised
PnL needs price and fee, so the detail comes from `activeOrders[].fills`, which
the SDK already documents as the only path a client has to fill data.

That is not the cursorless fill path phase B refused. Nothing is emitted unless
an account event at a known `accountSequence` announced it, the walk stops at the
quantity that event announced, and every fill is committed with that sequence.
The portfolio is asked for fields, never for existence.

### Realised PnL is the ledger's own arithmetic

Every fill goes through `applyFillToPosition` from `@moi/trading-core` — the
function the ledger uses, with the same weighted-cost division and the same fee
treatment. There is no second accounting to reconcile.

The basis starts at zero at the first fill the runner commits, so realised PnL
measures **this bot's trading**, not the account's history — the same judgement
`dailyNotional` makes. When the ledger holds a position the runner never saw
itself acquire, a sell exceeds the basis; the fill is then recorded realising
nothing, the basis is re-read from the ledger, and it is reported at `error`,
because a limit computed over a series with a hole in it should not look
trustworthy.

### Reconnection, against two bugs that already happened

The paper API solved this exact problem after a 34-hour outage (spec §16.34), and
§3 forbids importing its solution. So the lessons crossed the boundary and the
code did not, and both are tests here:

- **A replaced socket's late `onclose` must not tear down its successor.** Every
  handler closes over the generation it was installed for; `#detach` unwires a
  socket *and* closes it, because one left open is a second connection against
  the session's own rate limit.
- **There is no permanent exhaustion latch.** A window of failures makes the
  retry band slow — half-jitter from 30 s to a 5 min ceiling, never the full
  jitter whose floor at zero would hot-loop the hold — and never closed. A
  service can wait for on-call; a bot in a container cannot.

Added beside them: a **liveness watchdog**. A half-open connection produces no
`onclose` at all, so silence past three of the server's advertised heartbeat
intervals is treated as a close the client declares itself.

### A gap cannot be backfilled, only re-baselined

§5.3 asks for gap backfill after a reconnect. There is nothing to backfill with:
there is no historical-quote endpoint (§8.4), so the prices the market traded
through while the socket was down are not available to anyone, and interpolating
them would put fabricated observations into an average a strategy trades on.

So the REST read on every established connection restores the **level**, not the
series. If the outage was long enough to be a gap, the stitched tick carries
`gapBefore`, phase A discards the ring, and entries are withheld for
`slowPeriod + 1` ticks while a real series rebuilds. What the read buys is that
those ticks start arriving immediately rather than whenever the book next moves —
which on a quiet instrument can be minutes.

A reconnect is **not** unconditionally a gap. The elapsed-time rule below already
covers it, and a socket replaced in 200 ms did not miss enough to be worth
discarding a window over.

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

Both of those assume a record reaches the file whole, and `fs.writeSync` does not
promise that — it returns a short count on a full disk rather than throwing. So
every record is written to completion (`write-all.ts`), and a record that cannot
be completed closes the log to further appends: `O_APPEND` would put the next
write straight after the fragment and splice two records into one line, and a
spliced line that lands last is indistinguishable from an ordinary torn tail.

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

Both market-data paths feed one `QuoteTicker`, which owns the cursor, the
ordering rule and this judgement. That is what makes the reconnect re-baseline
safe to run unconditionally: an observation the stream already delivered does not
become a second tick because REST also saw it.

`priceSource` says which path a tick came down — `stream-quote` or
`rest-snapshot`. Neither is `book-mid`, and phase C decided not to build it.
§5.2 asks for a mid because at the time it was written a `quote` frame carried a
bare order book and no price (§1 row 3). §16.36 removed that premise: the frame
now states `price` under the same `projectQuote` the REST answer uses, and under
the same rule the ledger prices against. Deriving a second price from the book in
the same payload would put the runner and the ledger into disagreement about what
an instrument costs, and buy nothing.

### A strategy that throws is contained, then quarantined

A throw from `onTick` or `onFill` does not reach the loop: the tick is abandoned,
nothing is submitted, the failure is reported, and the other strategies carry on.
After **three consecutive** throws the strategy is quarantined and stops
receiving ticks.

Consecutive rather than cumulative, because phase A's remaining throwing case — a
malformed price — recovers on the next valid tick, and a cumulative counter would
eventually quarantine a strategy behaving exactly as designed. One good tick
clears the count.

`onTick` and `onFill` are counted **separately**. A strategy whose `onFill` is
broken while its `onTick` works would never reach three consecutive failures on a
shared counter, so the one path that authorises orders off the back of an
execution would be the one path that could never be quarantined.

Quarantine is not a kill switch. It stops a broken decision path from producing
more decisions; it does **not** cancel resting orders or close a position — that
is the barrier of §7.2, in phase D. It is held in memory and re-derived after a
restart, because a quarantine on disk would mean a bot that cannot restart itself
out of a transient fault without someone deleting a file.

## Where the risk gate stops

Two rules apply to every order — the instrument must be allow-listed, and the
market must be open if `tradingHoursOnly` is set. Every *limit* applies to a
`BUY` only, and the daily budget is read through `dailyEntryNotional`, whose name
carries that policy: counting exits too would charge a round trip twice against a
budget only one side of it can spend, locking out re-entry for the rest of the
day. The `notional` on a decision record stays a fact about the order on both
sides — record the fact, filter in the query — so phase C's loss limits can read
the same records instead of needing a second field written a second way. A limit exists to cap exposure, and refusing an exit does not cap
exposure, it traps it: a bot at its open-order cap that cannot place the closing
order holds the position until a person notices. §6.3 already words quote
freshness as refusing an *entry*; this is that reading applied to the rest.

§6.4's two loss limits joined it in phase C. Both are folds over `fills.ndjson`,
which is to say over the same durable records that hold the cursor, so unlike §1
row 7's memory counter there is nothing for a restart to reset. A tripped loss
limit refuses new entries and leaves exits open; escalating it to cancelling
resting orders is the §7.2 barrier, in phase D.

`activeOrders` carries terminal orders too (#33), so the runner filters by status
itself, as §1 row 12 says to until that lands.
