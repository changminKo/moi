# @moi/strategy-runner

The trading bot's process: it reads the market through the paper API, asks each
configured strategy what to do, filters that through a risk gate, and places the
orders that survive. It is the runner of
[`docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md`](../../docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md),
at its **phase C** scope, plus **phase D** (the kill switch in
`src/runner/kill-switch.ts`, the image in `Dockerfile`, the Discord channel in
`src/runner/reporter-wiring.ts`) and **phase E**'s backtest harness in
`src/backtest`.

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
| The kill-switch submission barrier | **here since phase D** — see "The kill switch" | |
| Discord embeds, the image, the host lifecycle | **here since phase D** — `runner/reporter-wiring.ts`, `Dockerfile`, `COMPOSE_PROFILES=bot` (docs/operations/deployment.md) | |
| Escalating a tripped loss limit past "refuse new entries" | **here since phase D** | `RiskGate.lossLimitBreach` feeds the kill switch |
| Mid-price derivation and its tick-size rounding | nowhere — see below | §5.2's premise no longer holds |

Phase E added the backtest harness (`src/backtest`) and registered the SDK's
second strategy, `grid`. Neither pulls anything out of D: the replay drives the
runner's own `RiskGate` and `StrategyHost` as they stand, and it reports the
places where that means it cannot answer a question (see the table at the end).
Note what C's arrival changed for it — the gate now has §6.4's realised-PnL and
loss limits, so a replay *can* show one tripping, which the phase-E deviation
table below records as no longer being a gap.

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
| `BOT_TICK_LOG` | Optional. An NDJSON path to record every tick to, for a later backtest (§8.2). Off by default: the log does not rotate, and §8.4 makes a recorded series the *only* backtest input there is, so recording is a decision taken before the period you want to replay |
| `DISCORD_WEBHOOK_TRADE_URL` | Optional. The bot's **own** Discord channel (§7.4). Absent: reports go to stdout only. Present: every report is fanned out to stdout and the channel, with the session cookie and CSRF token masked by value. Malformed, or equal to `DISCORD_WEBHOOK_URL`: the runner refuses to start |

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

## What the state store holds after phase D

| File | Shape | Unit of atomicity |
|---|---|---|
| `decisions.ndjson` | append-only | one decision |
| `submissions.ndjson` | append-only | one outcome |
| `fills.ndjson` | append-only | **one account event** — see below |
| `session.json` (0600) | atomic replace | the current session |
| `runtime.json` | atomic replace | feed cursors and strategy snapshots |
| `kill-switch.json` | atomic replace | the kill switch's latch — present means engaged (phase D) |

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
`dailyEntryNotional` makes. When the ledger holds a position the runner never
saw itself acquire, a sell exceeds the basis; the fill is then recorded realising
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
more decisions and nothing else. It is held in memory and re-derived after a
restart, because a quarantine on disk would mean a bot that cannot restart itself
out of a transient fault without someone deleting a file. The two differ on every
axis that matters:

| | quarantine | kill switch |
|---|---|---|
| unit | one strategy | the whole runner |
| persisted | no — a restart lifts it | `kill-switch.json` — a person lifts it |
| resting orders | untouched | cancelled by the sweep |
| tripped by | three consecutive throws | a loss limit, ten failed submission attempts in a row, an unexplainable fill, or an operator |

A quarantine does not trip the kill switch (one strategy's fault does not stop the
others — phase B's call), and the kill switch does not consult quarantine (once
engaged, no host receives a tick anyway).

## The kill switch

Design §6's "킬 스위치가 걸리면", in phase D. The in-memory barrier closes, the
latch is written to `kill-switch.json` (a write the disk refuses is reported and
retried every cycle — the runner holds engaged in memory meanwhile), it is
reported once at `error`, every resting order is
cancelled through the ordinary gateway path (`decisionId`
`kill:{engagedAt}:{orderId}`, so a re-sweep records nothing twice and a failed
cancel is a pending decision the next start resubmits), and from then on the
gateway settles every `place` as `halted` while a `cancel` still goes out. The
runner stays up — fills keep reaching the journal, the cursors keep moving — and
says `the kill switch is still engaged` every 30 minutes.

Four things trip it: `maxConsecutiveLosses` or `maxDailyLoss` (design §6 calls
both "킬 스위치"; the BUY refusal stays too), ten failed submission attempts in a
row across decisions (design §7.2), an unexplainable fill (§16.46 — the wedge now
brings the barrier down with it), and an operator. The gateway asks the barrier
before every attempt **and after every failed one**, so a latch that comes down
while a request is in flight still settles that place as halted rather than
leaving it pending for a cleared restart to resubmit; backoffs are capped at
five minutes (§7.2) and the sweep waits at most five seconds for in-flight
submissions before it reads the portfolio.

**To engage it by hand**, write `{"reason": "…"}` to `kill-switch.json` in
`BOT_STATE_DIR`; the runner notices on its next cycle. **To clear it**, delete the
file and restart the container. It does not lift itself, and deleting the file
while the runner is up does not lift it either — a half-cleared switch would be a
half-trading bot.

A decision the barrier catches is settled as `halted`, not left pending: an
operator who clears the latch must not have yesterday's entry resubmitted at
them. The position is not closed; that is a person's decision. The design is
`docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md`
and the deviation row is §16.48.

## Where the risk gate stops

Two rules apply to every order — the instrument must be allow-listed, and the
market must be open if `tradingHoursOnly` is set. Every *limit* applies to a
`BUY` only, and the daily budget is read through `dailyEntryNotional`, whose name
carries that policy: counting exits too would charge a round trip twice against a
budget only one side of it can spend, locking out re-entry for the rest of the
day. The `notional` on a decision record stays a fact about the order on both
sides — record the fact, filter in the query — so phase C's loss limits can read
the same records instead of needing a second field written a second way.

A limit exists to cap exposure, and refusing an exit does not cap exposure, it
traps it: a bot at its open-order cap that cannot place the closing order holds
the position until a person notices. §6.3 already words quote
freshness as refusing an *entry*; this is that reading applied to the rest.

§6.4's two loss limits joined it in phase C. Both are folds over `fills.ndjson`,
which is to say over the same durable records that hold the cursor, so unlike §1
row 7's memory counter there is nothing for a restart to reset. A tripped loss
limit refuses new entries and leaves exits open **and**, since phase D, engages
the kill switch through `RiskGate.lossLimitBreach()`, which the supervisor asks
once a cycle.

`activeOrders` carries terminal orders too (#33), so the runner filters by status
itself, as §1 row 12 says to until that lands.

## Backtesting (phase E)

Design §8.2: replay a recorded tick series through the *same* `Strategy`, the
*same* `StrategyHost` and the *same* `RiskGate`, against a `SimulatedExchange`
instead of the paper API. The point is that a strategy's behaviour is checkable
without a live session, an order gateway, or the ledger.

Record a series, then replay it:

```bash
BOT_TICK_LOG=/var/lib/moi-bot/ticks.ndjson  # on the runner process
pnpm --filter @moi/strategy-runner backtest --plan plan.json --ticks ticks.ndjson
```

A plan is the runner's own `strategies` and `risk` blocks — read by the runner's
own readers, so a plan cannot describe a bot the runner would refuse to be —
plus the three things a replay has to state because it has no API to ask:

```json
{
  "strategies": [
    {
      "name": "grid-samsung",
      "strategyId": "grid",
      "params": {
        "market": "KR",
        "symbol": "005930",
        "lowerPrice": "70000",
        "step": "250",
        "levels": 5,
        "quantity": "10"
      }
    }
  ],
  "risk": {
    "symbolAllowList": [{ "market": "KR", "symbol": "005930" }],
    "maxOrderNotional": "5000000",
    "maxDailyNotional": "20000000",
    "maxPositionQuantity": "100",
    "maxOpenOrders": 5,
    "tradingHoursOnly": true,
    "maxQuoteAgeMs": 60000
  },
  "marketPhase": "REGULAR",
  "cash": [{ "currency": "KRW", "amount": "10000000" }],
  "fees": [
    {
      "version": "backtest-1",
      "market": "KR",
      "currency": "KRW",
      "commissionRate": "0.001",
      "sellTaxRate": "0.002",
      "roundingDecimals": 0,
      "roundingMode": "HALF_UP"
    }
  ]
}
```

### The worked example the tests pin

`src/backtest/engine.test.ts` replays five ticks through that plan. The grid's
levels are `70000 70250 70500 70750 71000` and every quote carries a ±10 spread,
so a market order pays the touch rather than the quote:

| tick | rung | what the grid does | fill | fee |
|---|---|---|---|---|
| 70800 | 4 | primes, no order | — | — |
| 70600 | 3 | crosses 70750 down, buys slot 3 | BUY 10 @ 70610 | 706 |
| 70300 | 2 | crosses 70500 down, buys slot 2 | BUY 10 @ 70310 | 703 |
| 70900 | 4 | re-enters rung 4, releases slot 2 | SELL 10 @ 70890 | 2127 |
| 71200 | 5 | leaves the band, releases slot 3 | SELL 10 @ 71190 | 2136 |

Gross 11,600, fees 5,672, realised PnL **5,928**, and the closing wallet is
`10,000,000 + 5,928 = 10,005,928` to the won — the position is flat, so the two
have to agree exactly, and a rounding error anywhere in the chain would show up
as a discrepancy between them.

### What a backtest here cannot tell you

Every one of these is a place the harness's answer is knowably different from a
real one, and each is stated in the module that causes it:

- **No depth and no queue.** A resting order fills whole, at one price, the
  instant the touch reaches it. A large order looks free; an order that lives on
  being filled at the touch looks better than it is.
- **Fees are the plan's, not the ledger's** (§1 row 13, §8.3). The report says so
  in its header and names the schedule versions it used.
- **Loss limits do apply, on the replay's own fills.** §6.4's limits arrived with
  phase C, and the replay's `fills` source is the simulated exchange — a
  replay's own fills are the only realised PnL it has, so this is the honest
  source rather than a stub. What a replay still cannot show is a limit tripping
  on a fill the recorded series never contained.
- **One market phase for the whole replay.** A recorded tick carries no calendar.
- **The clock is the tick's.** Quote freshness therefore always measures zero: a
  replay cannot reproduce a tick that was already stale when the runner saw it,
  because the log has no second timestamp to say so.

What it *does* guarantee, because the report is worthless without it: **a
simulated wallet never goes negative.** A resting buy reserves what the fill
will cost — notional *plus* the fee that fill charges, which a resting limit
determines exactly at submit time — so an order the account cannot pay for is
refused when it is placed rather than discovered when it fills. Reserving the
notional alone was a real defect, found by a reviewer who ran the code: the
wallet went to `-690` with no refusal and no flag. `#settle` asserts the
invariant independently and fails closed if anything ever reaches it again.

`src/backtest/boundary.test.ts` pins the rule that makes the harness safe to
point at anything: **no module under `src/backtest` may reach the network.** The
package manifest cannot express that — `PaperApiClient` is legitimately in the
same package — so the rule is checked over the source, and the list of runner
modules a replay may share is pinned so a fourth one is a decision somebody makes.

## Deviations from the design

Phase B's are recorded in the module documentation above. These are phase E's.
The four that are genuine departures from the design carry a numbered row in the
production-runtime spec's §16 table — **§16.41 to §16.44** — as AGENTS.md
requires; the rest are consequences of phase B's own design and are recorded
here only.

| # | Design | What the code does, and why |
|---|---|---|
| E1 (§16.41) | §8.2 replays *"the NDJSON ticks left by `--record`"* | There is no `--record` flag. The runner's entry point takes no arguments at all — it is configured entirely by environment — so recording is turned on with `BOT_TICK_LOG`. The artefact is the one §8.2 describes |
| E2 (§16.42) | §8.2 specifies `SimulatedExchange` as two fill rules | It also models cash, position, fees and resting orders, because a report that cannot say whether the strategy had the money is not a report. It **refuses** `STOP`, `TAKE_PROFIT` and `OCO` rather than leaving them unfilled: an order that silently never fills reports a strategy whose protective exit did nothing as one that never needed it |
| E3 (§16.43) | §6.3 decides trading hours from `GET /markets/:m/session` | A recorded tick carries no calendar, so a plan states `marketPhase` and it applies to every market for the whole replay |
| E4 | §6.4's loss limits | **No longer a gap.** They were phase C when this was written and phase C has landed, so the gate applies them here too: the replay's `RiskLedgerSource.fills` is the `SimulatedExchange`, whose fills are the only realised PnL a replay has. `engine.test.ts` pins a losing round trip tripping the daily-loss limit and the next entry being refused |
| E5 (§16.43) | §8.2 requires the replay to use the same `RiskGate` | `RiskGateOptions.sessions` and `.state` were narrowed from `MarketSessionCache` and `StateStore` to the `MarketPhaseSource` and `DailyNotionalSource` interfaces they already satisfy. A class with `#private` fields cannot be substituted structurally, so without this the replay would need a second gate — which is the one thing §8.2 rules out. No behaviour changed |
| E6 (§16.44) | §5.3 caps subscriptions at four | A backtest plan is **not** capped: a replay subscribes to nothing, and replaying a recorded five-symbol series is a legitimate question even though the live runner would refuse that configuration. The live cap is unchanged |
| E7 | §11 phase E asks for a `grid` strategy | It places `MARKET` orders on a level crossing rather than resting limits at each level, because `StrategyContext` shows a strategy its position and not its open orders, and a strategy that guessed at its resting orders would accumulate phantoms until `maxOpenOrders` refused everything. The cost — the realised price is the tick's, not the level's — is stated in the strategy and visible in the report |
| E8 | §6.3's limits | A grid emits both sides continuously, and the gate is BUY-only by design. Its sells are bounded by the strategy itself (only recorded lots, at most `quantity` each, capped at `position.available`), not by any configured limit. `engine.test.ts` pins both halves |
