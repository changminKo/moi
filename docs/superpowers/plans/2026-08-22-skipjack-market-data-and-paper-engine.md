# Skipjack Market Data and Paper Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the normalized trading domain to Toss REST/WebSocket data, implement deterministic paper matching, conditional/OCO execution, LOSSY-feed recovery, leader fencing, and fail-closed safety incidents.

**Architecture:** `packages/market-data` owns provider-neutral event contracts plus Toss adapters; `apps/paper-api/src/engine` owns the single-writer paper engine. PostgreSQL leases, epochs, gate locks, incidents, and ledger transactions prevent stale leaders or unsafe market data from committing fills.

**Tech Stack:** The Plan 1 stack plus Zod 4.4.3, ws 8.18.1, @types/ws 8.18.1, undici 8.10.0, Pino 10.3.1, and Vitest fake timers.

**Spec:** `docs/superpowers/specs/2026-08-21-skipjack-paper-trading-architecture-design.md`

## Global Constraints

- Complete `2026-08-22-skipjack-foundation-and-trading-core.md` first; do not duplicate its domain logic.
- Toss trade and order-book streams are LOSSY, have no provider sequence, and send no initial snapshot.
- Never infer a missing price path, synthesize historical liquidity, or retroactively fill a gap.
- Normal conditional triggers use observed trade events; recovery conditions use current REST price and execute against current REST order book.
- Recovery events carry `recoveryEpoch`, internal `marketDataVersion`, and `leaderFencingToken`; none is presented as a Toss sequence.
- One WebSocket connection per market subscribes to 40 symbols × trade/orderbook = 80 topics, leaving 20 topics of headroom.
- Each paper order evaluates against an independent copy of observed book depth; users do not consume one another's virtual liquidity and the MVP models no exchange queue position.
- `CANCEL_ONLY` blocks placement, amendment, matching, stop/take-profit trigger, and OCO trigger while allowing safe cancellation when DB/audit are healthy.
- All execution paths recheck database capability gates inside the fill transaction.
- PR tests use official pinned schemas and recorded/fake fixtures; they never call live Toss.
- Every task follows TDD and ends in a focused commit.

---

### Task 1: Define normalized market-data ports and conformance tests

**Files:**
- Create: `packages/market-data/package.json`
- Create: `packages/market-data/tsconfig.json`
- Create: `packages/market-data/src/types.ts`
- Create: `packages/market-data/src/ports.ts`
- Create: `packages/market-data/src/fake-market-data.ts`
- Create: `packages/market-data/src/adapter-conformance.ts`
- Create: `packages/market-data/src/fake-market-data.test.ts`
- Create: `packages/market-data/src/index.ts`

**Interfaces:**
- Consumes: `Market`, `DecimalString`, and `OrderBookSnapshot` from `@skipjack/trading-core`.
- Produces: `MarketTrade`, `MarketOrderBook`, `MarketEvent`, `SubscriptionDeclaration`, `MarketDataStream`, `MarketSnapshotSource`, `InstrumentCatalog`, `MarketCalendarSource`, `FxRateSource`, `TokenProvider`, `FakeMarketData`, and `runMarketDataConformance(factory)`.

- [ ] **Step 1: Write the adapter conformance test against a fake**

```ts
it('does not invent provider sequence or initial snapshot', async () => {
  const fake = new FakeMarketData();
  await fake.connect();
  await fake.declare([{ channel: 'trade', market: 'US', symbols: ['AAPL'] }]);
  expect(fake.receivedEvents()).toEqual([]);
  fake.emitTrade({ market: 'US', symbol: 'AAPL', price: '210.10', volume: '3', sourceTimestamp: null });
  expect(await fake.next()).toMatchObject({ kind: 'trade', symbol: 'AAPL' });
});
```

- [ ] **Step 2: Run and verify the missing adapter failure**

Run: `pnpm --filter @skipjack/market-data test -- fake-market-data.test.ts`

Expected: FAIL because the package and fake do not exist.

- [ ] **Step 3: Implement the provider-neutral contracts**

```ts
export type MarketEvent =
  | { kind: 'trade'; market: Market; symbol: string; price: DecimalString; volume: Quantity; sourceTimestamp: string | null; receivedAt: string }
  | { kind: 'orderBook'; market: Market; symbol: string; book: OrderBookSnapshot; sourceTimestamp: string | null; receivedAt: string }
  | { kind: 'transportClosed'; market: Market; reason: string; receivedAt: string };

export interface MarketDataStream {
  connect(signal: AbortSignal): Promise<void>;
  declare(subscriptions: readonly SubscriptionDeclaration[]): Promise<SubscriptionAck>;
  events(signal: AbortSignal): AsyncIterable<MarketEvent>;
  ping(): Promise<number>;
  close(): Promise<void>;
}
```

Make `FakeMarketData` support explicit emit, drop, reorder, close, ACK reject, PONG failure, and no-initial-snapshot modes. The conformance suite must be reusable by Toss recorded replay.

- [ ] **Step 4: Run package tests and type checks**

Run: `pnpm --filter @skipjack/market-data test && pnpm --filter @skipjack/market-data typecheck`

Expected: PASS with no provider-specific field in public normalized types.

- [ ] **Step 5: Commit the ports**

```bash
git add packages/market-data pnpm-lock.yaml
git commit -m "feat(market-data): define normalized feed ports"
```

---

### Task 2: Pin official Toss contracts and parse recorded frames

**Files:**
- Create: `packages/market-data/contracts/toss/asyncapi.json`
- Create: `packages/market-data/contracts/toss/openapi.json`
- Create: `packages/market-data/contracts/toss/provenance.json`
- Create: `packages/market-data/fixtures/toss/subscriptions.json`
- Create: `packages/market-data/fixtures/toss/trade-us-aapl.json`
- Create: `packages/market-data/fixtures/toss/orderbook-kr-005930.json`
- Create: `packages/market-data/fixtures/toss/error-server-shutdown.json`
- Create: `packages/market-data/src/toss/schemas.ts`
- Create: `packages/market-data/src/toss/parse-frame.ts`
- Create: `packages/market-data/src/toss/parse-frame.contract.test.ts`

**Interfaces:**
- Consumes: official Toss OpenAPI/AsyncAPI and normalized events.
- Produces: `parseTossFrame(raw, receivedAt): TossInboundFrame` and sanitized, versioned contract fixtures.

- [ ] **Step 1: Write failing contract parser tests**

```ts
it('accepts nullable order-book timestamps and unknown currency enums safely', () => {
  const frame = parseTossFrame(orderBookFixture({ timestamp: null, currency: 'UNKNOWN_FUTURE' }), now);
  expect(frame).toMatchObject({ kind: 'orderBook', sourceTimestamp: null, currency: 'UNKNOWN_FUTURE' });
});

it('rejects malformed decimal fields without coercing number', () => {
  expect(() => parseTossFrame(tradeFixture({ price: 210.1 }), now)).toThrow();
});
```

- [ ] **Step 2: Verify tests fail before schemas exist**

Run: `pnpm --filter @skipjack/market-data test -- parse-frame.contract.test.ts`

Expected: FAIL with missing parser/schema modules.

- [ ] **Step 3: Download and record canonical contract provenance**

Run:

```bash
curl --fail --silent --show-error https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json --output packages/market-data/contracts/toss/asyncapi.json
curl --fail --silent --show-error https://openapi.tossinvest.com/openapi-docs/latest/openapi.json --output packages/market-data/contracts/toss/openapi.json
shasum -a 256 packages/market-data/contracts/toss/asyncapi.json packages/market-data/contracts/toss/openapi.json
```

Store URL, retrieved-at UTC timestamp, advertised API versions, and SHA-256 values in `provenance.json`. Build Zod schemas for subscription ACK, trade, order book, error, and pong frames from the pinned contract. Unknown enum values stay opaque strings internally and are mapped to an unsupported-data incident instead of crashing the process.

- [ ] **Step 4: Run schema and conformance tests**

Run: `pnpm --filter @skipjack/market-data test`

Expected: PASS for recorded frames, missing sequence, null timestamp, unknown fields, and malformed payload rejection.

- [ ] **Step 5: Commit contracts and parser**

```bash
git add packages/market-data/contracts packages/market-data/fixtures packages/market-data/src/toss pnpm-lock.yaml
git commit -m "feat(market-data): parse pinned Toss contracts"
```

---

### Task 3: Implement Toss WebSocket and REST adapters

**Files:**
- Create: `packages/market-data/src/toss/toss-websocket.ts`
- Create: `packages/market-data/src/toss/toss-websocket.test.ts`
- Create: `packages/market-data/src/toss/toss-rest.ts`
- Create: `packages/market-data/src/toss/toss-rest.test.ts`
- Create: `packages/market-data/src/toss/subscription-plan.ts`
- Create: `packages/market-data/src/toss/subscription-plan.test.ts`
- Modify: `packages/market-data/src/index.ts`

**Interfaces:**
- Consumes: `TokenProvider`, normalized ports, parsed Toss frames, fixed whitelist.
- Produces: `TossWebSocketMarketData`, `TossRestClient` implementing recovery snapshots, full instrument search, market calendars, and FX rates, plus `buildSubscriptionPlan(market, symbols)`.

- [ ] **Step 1: Write subscription and keepalive tests with a local fake server**

```ts
it('declares exactly 80 topics for 40 symbols and replaces the full set', async () => {
  const plan = buildSubscriptionPlan('US', fortyUsSymbols);
  expect(plan.topicCount).toBe(80);
  expect(plan.declaration).toEqual([
    { type: 'trade:us', codes: fortyUsSymbols },
    { type: 'orderbook:us', codes: fortyUsSymbols },
  ]);
});
```

Also assert Authorization is sent only in the handshake, PING is sent every 60 seconds, two consecutive PONG failures close the adapter, and partial ACK rejection is surfaced with exact topic keys.

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `pnpm --filter @skipjack/market-data test -- toss-websocket.test.ts toss-rest.test.ts subscription-plan.test.ts`

Expected: FAIL because clients do not exist.

- [ ] **Step 3: Implement adapters behind injectable network ports**

```ts
export class TossRestClient implements MarketSnapshotSource, InstrumentCatalog, MarketCalendarSource, FxRateSource {
  constructor(private readonly baseUrl: URL, private readonly tokenProvider: TokenProvider, private readonly fetch: typeof globalThis.fetch) {}

  async getRecoverySnapshot(market: Market, symbol: string, signal: AbortSignal): Promise<RecoverySnapshot> {
    const [price, book] = await Promise.all([
      this.getPrice(market, symbol, signal),
      this.getOrderBook(market, symbol, signal),
    ]);
    return { market, symbol, price, book, fetchedAt: new Date().toISOString() };
  }
}
```

Implement the four REST ports with independent response schemas, timeouts, abort signals, and bounded retries. Use full-replace WebSocket declarations, exponential backoff with jitter, explicit abort signals, response schema validation, and no automatic trading-state transition inside either adapter.

- [ ] **Step 4: Run tests without external network**

Run: `pnpm --filter @skipjack/market-data test`

Expected: PASS using local WebSocket and fetch fakes; test output contains no access token.

- [ ] **Step 5: Commit Toss adapters**

```bash
git add packages/market-data/src/toss packages/market-data/src/index.ts
git commit -m "feat(market-data): add Toss REST and WebSocket adapters"
```

---

### Task 4: Implement leader lease, fencing, and versioned market state

**Files:**
- Create: `apps/paper-api/src/market-data/leader-lease.ts`
- Create: `apps/paper-api/src/market-data/leader-lease.integration.test.ts`
- Create: `apps/paper-api/src/market-data/market-state-repository.ts`
- Create: `apps/paper-api/src/market-data/market-state-store.ts`
- Create: `apps/paper-api/src/market-data/market-state-store.test.ts`

**Interfaces:**
- Consumes: Plan 1 DB, market events, and markets.
- Produces: `LeaderLease.acquire(market)`, `LeaderLease.release()`, `MarketEnvelope<T>`, `MarketStateStore.beginEpoch()`, `applyEvent()`, and `replaceBaseline()`.

- [ ] **Step 1: Write split-brain and stale-epoch tests**

```ts
it('rejects a stale leader after the advisory-lock connection closes', async () => {
  const first = await LeaderLease.acquire(db1, 'US');
  await first.connection.end();
  const second = await LeaderLease.acquire(db2, 'US');
  expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  await expect(commitFillWithToken(db2, first.fencingToken)).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });
});
```

- [ ] **Step 2: Run the integration test and verify failure**

Run: `pnpm --filter @skipjack/paper-api test -- leader-lease.integration.test.ts market-state-store.test.ts`

Expected: FAIL because no lease/store exists.

- [ ] **Step 3: Implement dedicated-connection advisory leases**

Use a market-specific PostgreSQL advisory lock held on a dedicated connection. In the same acquisition transaction increment `leader_epoch.fencing_token`; close a local matching latch when the lease connection emits error/end. `MarketStateStore` rejects any envelope whose epoch or token differs from current state and increments internal `marketDataVersion` only after an accepted event.

```ts
export interface MarketEnvelope<T> {
  readonly recoveryEpoch: bigint;
  readonly leaderFencingToken: bigint;
  readonly marketDataVersion: bigint;
  readonly payload: T;
}
```

- [ ] **Step 4: Run lease, epoch, and out-of-order rejection tests**

Run: `pnpm --filter @skipjack/paper-api test -- leader-lease.integration.test.ts market-state-store.test.ts`

Expected: PASS for lease handoff, stale token, stale epoch, and per-symbol version monotonicity.

- [ ] **Step 5: Commit market ownership**

```bash
git add apps/paper-api/src/market-data
git commit -m "feat(engine): fence market-data leaders"
```

---

### Task 5: Implement health detection and deterministic recovery

**Files:**
- Create: `apps/paper-api/src/market-data/health-machine.ts`
- Create: `apps/paper-api/src/market-data/health-machine.test.ts`
- Create: `apps/paper-api/src/market-data/recovery-coordinator.ts`
- Create: `apps/paper-api/src/market-data/recovery-coordinator.test.ts`
- Create: `apps/paper-api/src/market-data/snapshot-rate-limiter.ts`
- Create: `apps/paper-api/src/lifecycle/startup-coordinator.ts`
- Create: `apps/paper-api/src/lifecycle/startup-coordinator.integration.test.ts`
- Create: `apps/paper-api/src/lifecycle/shutdown-coordinator.ts`
- Create: `apps/paper-api/src/lifecycle/shutdown-coordinator.integration.test.ts`

**Interfaces:**
- Consumes: Toss ports, leader lease, market state store, clock, incident service from Task 8 via an interface declared here.
- Produces: `MarketHealthMachine`, `RecoveryCoordinator.recover(market, signal)`, `StartupCoordinator.open()`, `ShutdownCoordinator.drain()`, `RecoveryOutcome`, and `IncidentPort`.

- [ ] **Step 1: Write recovery semantics tests**

```ts
it('does not trigger a stop crossed and recovered entirely inside an outage', async () => {
  fakeRest.setSnapshot('US', 'AAPL', { lastPrice: '101', book: bookAt('101') });
  const outcome = await coordinator.recover('US', signal);
  expect(outcome.recoveryTriggers).toEqual([]);
});

it('triggers against current REST price and fills only from current REST book', async () => {
  fakeRest.setSnapshot('US', 'AAPL', { lastPrice: '89', book: bookAt('88.50') });
  const outcome = await coordinator.recover('US', signal);
  expect(outcome.recoveryTriggers[0]).toMatchObject({ symbol: 'AAPL', recoveryFill: true, referencePrice: '89' });
});
```

Also write startup/shutdown tests that prove local latches start closed, terminal orders never reload, active incidents survive restart, invariant failure prevents opening, shutdown rejects new placement before draining, committed outbox events drain before lease release, and both provider sockets are closed before a replacement process connects.

- [ ] **Step 2: Run tests and verify missing recovery coordinator**

Run: `pnpm --filter @skipjack/paper-api test -- health-machine.test.ts recovery-coordinator.test.ts startup-coordinator.integration.test.ts shutdown-coordinator.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `HEALTHY -> DEGRADED -> RECOVERING`**

On close, two missed PONGs, or required subscription rejection, create a market `CANCEL_ONLY` incident. During recovery: acquire lease, increment epoch, discard old queues, declare exact subscriptions, verify ACK, fetch price+book through a token bucket, replace each symbol baseline, keep failed symbols in symbol incidents, wait on an injected five-second stability clock, and CAS-resolve only the incident/version being recovered. After three failures in five minutes require operator acknowledgment.

Startup begins with local admission/matching latches closed and state `RECOVERING/CANCEL_ONLY`; it restores active incidents, open orders, reservations, wallets, and positions, verifies all account invariants, acquires the two market leases without exceeding two provider connections, and opens capabilities only after both markets finish recovery. Graceful shutdown first activates/retains `CANCEL_ONLY`, closes admission, drains in-flight transactions and committed outbox events up to the configured deadline, closes both WebSockets, and releases leases. A startup invariant or audit failure leaves the local latch closed and never self-releases a manual incident.

```ts
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'RECOVERING';
export interface RecoveryOutcome {
  readonly market: Market;
  readonly epoch: bigint;
  readonly recoveredSymbols: readonly string[];
  readonly blockedSymbols: readonly string[];
  readonly recoveryTriggers: readonly RecoveryTrigger[];
}
```

- [ ] **Step 4: Run virtual-clock recovery and flapping tests**

Run: `pnpm --filter @skipjack/paper-api test -- health-machine.test.ts recovery-coordinator.test.ts startup-coordinator.integration.test.ts shutdown-coordinator.integration.test.ts`

Expected: PASS without real sleep; snapshot calls remain within configured token-bucket capacity.

- [ ] **Step 5: Commit recovery**

```bash
git add apps/paper-api/src/market-data apps/paper-api/src/lifecycle
git commit -m "feat(engine): recover lossy market feeds"
```

---

### Task 6: Implement normal market and limit matching

**Files:**
- Create: `apps/paper-api/src/engine/paper-engine.ts`
- Create: `apps/paper-api/src/engine/paper-engine.test.ts`
- Create: `apps/paper-api/src/engine/match-orders.ts`
- Create: `apps/paper-api/src/engine/match-orders.integration.test.ts`
- Create: `apps/paper-api/src/engine/pricing-context.ts`

**Interfaces:**
- Consumes: core execution/reservation/state functions, MarketEnvelope, cached market calendar, UnitOfWork, and SafetyGate interface.
- Produces: `PaperEngine.onTrade()`, `PaperEngine.onOrderBook()`, `PaperEngine.placeImmediateOrder()`, and auditable `PricingContext`.

- [ ] **Step 1: Write a failing partial-fill ledger test**

```ts
it('commits fills, balances, reservations, audit, and outbox once', async () => {
  await engine.onOrderBook(envelope(bookEvent({ asks: [{ price: '100', volume: '2' }] })));
  const order = await engine.placeImmediateOrder(marketBuyCommand({ quantity: '3' }));
  expect(order).toMatchObject({ status: 'CANCELLED', filledQuantity: '2', terminalReason: 'IOC_REMAINDER' });
  expect(await ledgerOracle(db, order.id)).toMatchObject({ balanced: true, fillCount: 1, auditCount: 1 });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @skipjack/paper-api test -- paper-engine.test.ts match-orders.integration.test.ts`

Expected: FAIL because the engine is missing.

- [ ] **Step 3: Implement single-writer matching with transaction-time guards**

For every event, reject stale envelope metadata before querying orders and do not match outside the cached regular session. For every candidate order, begin the Plan 1 unit of work, acquire shared gates in `global -> market -> symbol -> account -> OCO group/order -> wallet/position` order, recheck effective capabilities, lock order/OCO/account rows, calculate fills with the exact `PricingContext`, update ledger and reservation, append transactional audit/outbox, verify current fencing token, and commit. Evaluate every account against the original immutable book snapshot so one paper user's fill never reduces another user's virtual depth.

```ts
export interface PricingContext {
  readonly source: 'WEBSOCKET' | 'RECOVERY_REST';
  readonly recoveryEpoch: bigint;
  readonly marketDataVersion: bigint;
  readonly leaderFencingToken: bigint;
  readonly referencePrice: DecimalString;
  readonly referenceTimestamp: string | null;
  readonly book: OrderBookSnapshot;
  readonly pricingModelVersion: string;
  readonly feeModelVersion: string;
}
```

Each `FILL_CREATED`/`TRIGGERED` audit payload stores the reference price/timestamp, every consumed book level with price and volume, fill quantity, fee, slippage, epoch, internal version, fencing token, price/fee model versions, `recoveryFill`, and incident ID when applicable.

- [ ] **Step 4: Run IOC, resting-limit, version-race, and independent-oracle tests**

Run: `pnpm --filter @skipjack/paper-api test -- paper-engine.test.ts match-orders.integration.test.ts ledger.contract.integration.test.ts`

Expected: PASS with a deterministic two-connection fill-versus-cancel barrier, no fill after a gate becomes exclusive, independent book depth per account, and no matching outside the regular market session.

- [ ] **Step 5: Commit matching**

```bash
git add apps/paper-api/src/engine
git commit -m "feat(engine): match protected paper orders"
```

---

### Task 7: Implement stop, take-profit, and OCO execution

**Files:**
- Create: `apps/paper-api/src/engine/conditional-trigger.ts`
- Create: `apps/paper-api/src/engine/conditional-trigger.test.ts`
- Create: `apps/paper-api/src/engine/oco-executor.ts`
- Create: `apps/paper-api/src/engine/oco-executor.integration.test.ts`
- Modify: `apps/paper-api/src/engine/paper-engine.ts`

**Interfaces:**
- Consumes: observed trades, recovery triggers, OCO/state/reservation rules, UnitOfWork.
- Produces: `evaluateConditional(order, referencePrice)`, `OcoExecutor.trigger(groupId, legId, pricingContext)`, and deterministic stop-first recovery tie-break.

- [ ] **Step 1: Write dual-trigger and cancel-race tests**

```ts
it('allows exactly one OCO leg under concurrent triggers', async () => {
  await Promise.allSettled([
    executor.trigger(groupId, stopLegId, stopContext),
    executor.trigger(groupId, takeProfitLegId, takeProfitContext),
  ]);
  const group = await readOcoGroup(db, groupId);
  expect(group.status).toBe('RESOLVED');
  expect(await countFilledLegs(db, groupId)).toBe(1);
  expect(await countCancelledSiblings(db, groupId)).toBe(1);
});
```

- [ ] **Step 2: Run condition/OCO tests and verify failure**

Run: `pnpm --filter @skipjack/paper-api test -- conditional-trigger.test.ts oco-executor.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement trigger and atomic sibling cancellation**

Normal triggers consume only observed trade events from the current epoch during the cached regular session. Recovery triggers consume the current REST price prepared by the coordinator and remain deferred when the market is closed. Acquire the OCO parent row before either leg; transition winner, cancel sibling, release shared reservation once, create fill/audit/outbox, and commit in one transaction. If both recovery conditions are true, choose the loss-limiting stop leg before opening the transaction.

- [ ] **Step 4: Run deterministic two-connection race tests**

Run: `pnpm --filter @skipjack/paper-api test -- conditional-trigger.test.ts oco-executor.integration.test.ts`

Expected: PASS with a transaction barrier forcing both workers to observe the pre-trigger state before one wins.

- [ ] **Step 5: Commit conditional execution**

```bash
git add apps/paper-api/src/engine
git commit -m "feat(engine): execute conditional and OCO orders"
```

---

### Task 8: Implement incidents, capability gates, and emergency latches

**Files:**
- Create: `apps/paper-api/src/safety/capabilities.ts`
- Create: `apps/paper-api/src/safety/capabilities.test.ts`
- Create: `apps/paper-api/src/safety/incident-repository.ts`
- Create: `apps/paper-api/src/safety/incident-service.ts`
- Create: `apps/paper-api/src/safety/gate-locks.ts`
- Create: `apps/paper-api/src/safety/gate-locks.integration.test.ts`
- Create: `apps/paper-api/src/safety/emergency-latch.ts`
- Create: `apps/paper-api/src/safety/emergency-latch.test.ts`

**Interfaces:**
- Consumes: Plan 1 schema/UnitOfWork and Task 4 leader metadata.
- Produces: `Capability`, `SafetyIncident`, `EffectiveCapabilities`, `IncidentService.activate()`, `resolveCas()`, `GateLocks.acquireShared()`, `acquireExclusive()`, and `EmergencyLatch`.

- [ ] **Step 1: Write capability-intersection and activation-race tests**

```ts
it('intersects independent incidents without one cause clearing another', () => {
  const effective = intersectCapabilities([
    incident({ scope: 'MARKET', denied: ['PLACE', 'AMEND', 'MATCH', 'TRIGGER'] }),
    incident({ scope: 'ACCOUNT', denied: ['CANCEL'] }),
  ]);
  expect(effective.allowed).not.toContain('PLACE');
  expect(effective.allowed).not.toContain('CANCEL');
});
```

The integration test must pause an order after shared gate acquisition, start exclusive incident activation, prove activation waits, then prove a later order is denied after incident commit.

- [ ] **Step 2: Run safety tests and verify failure**

Run: `pnpm --filter @skipjack/paper-api test -- capabilities.test.ts gate-locks.integration.test.ts emergency-latch.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement cause-specific incidents and ordered advisory gates**

```ts
export type Capability = 'PLACE' | 'AMEND' | 'CANCEL' | 'MATCH' | 'TRIGGER' | 'RECOVER';

export interface SafetyIncident {
  readonly incidentId: string;
  readonly scope: { type: 'GLOBAL' | 'MARKET' | 'SYMBOL' | 'ACCOUNT'; id: string };
  readonly denied: ReadonlySet<Capability>;
  readonly causeCode: string;
  readonly recoveryEpoch: bigint | null;
  readonly version: bigint;
  readonly status: 'ACTIVE' | 'RESOLVED';
}
```

Use deterministic advisory-lock keys and fixed acquisition order. Resolution must update only the target active incident with matching version/epoch and append an audit event. On DB/audit/invariant fatal errors, close the process-local atomic admission and matching latches before attempting DB incident persistence.

- [ ] **Step 4: Run safety and engine interlock tests**

Run: `pnpm --filter @skipjack/paper-api test -- capabilities.test.ts gate-locks.integration.test.ts emergency-latch.test.ts paper-engine.test.ts conditional-trigger.test.ts`

Expected: PASS: `CANCEL_ONLY` allows cancel but blocks matching/trigger; `READ_ONLY` blocks user mutations; DB unavailable returns `SERVICE_UNAVAILABLE` and never promises cancellation.

- [ ] **Step 5: Commit safety gates**

```bash
git add apps/paper-api/src/safety apps/paper-api/src/engine apps/paper-api/src/market-data
git commit -m "feat(safety): enforce fail-closed trading gates"
```

---

### Task 9: Lock Plan-2 fault semantics

**Files:**
- Create: `apps/paper-api/src/engine/paper-engine.fault.integration.test.ts`
- Create: `packages/market-data/fixtures/scenarios/lossy-recovery.json`
- Create: `docs/testing/market-recovery-scenarios.md`

**Interfaces:**
- Consumes: every Plan 2 component.
- Produces: deterministic fault suite reused by API and E2E plans.

- [ ] **Step 1: Encode the complete failure scenario**

The JSON scenario must contain ordered actions for healthy trade, resting stop, transport close, dropped unseen crossing trade, recovered REST price/book, stale old-epoch frame, leader handoff, and current-epoch trade. The expected results must state no historical fill, one optional current recovery fill, stale-frame rejection, balanced ledger, and one active/resolved incident chain. Re-run generated event permutations before and after a simulated process restart with fixed seed `220826`; persist any failing seed/path as a new scenario fixture and assert terminal orders never rearm.

```json
{
  "seed": 220826,
  "market": "US",
  "symbol": "AAPL",
  "actions": [
    { "atMs": 0, "type": "trade", "price": "100" },
    { "atMs": 10, "type": "disconnect" },
    { "atMs": 20, "type": "dropTrade", "price": "89" },
    { "atMs": 30, "type": "restSnapshot", "price": "101", "bestBid": "100.9", "bestAsk": "101.1" },
    { "atMs": 40, "type": "staleEpochTrade", "price": "88" }
  ]
}
```

- [ ] **Step 2: Run the fault suite and verify all assertions**

Run: `pnpm --filter @skipjack/paper-api test -- paper-engine.fault.integration.test.ts --reporter=verbose`

Expected: PASS with virtual time and no external network.

- [ ] **Step 3: Run all Plan 1 and Plan 2 gates**

Run: `pnpm check && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS. Contract fixtures remain unchanged and `git diff --exit-code packages/market-data/contracts/toss` succeeds after tests.

- [ ] **Step 4: Verify no live-order dependency entered public packages**

Run: `rg -n "accountSeq|createOrder|personal:order" packages/trading-core packages/strategy-sdk`

Expected: no matches. `personal:order` may exist only in pinned provider contracts, not public trading/strategy packages.

- [ ] **Step 5: Commit the fault suite**

```bash
git add apps/paper-api/src/engine/paper-engine.fault.integration.test.ts packages/market-data/fixtures/scenarios docs/testing/market-recovery-scenarios.md
git commit -m "test: lock paper-engine recovery semantics"
```

Plan 2 is complete when fake and recorded feeds drive the same engine, all fills are fenced and auditable, and every LOSSY-feed recovery case is deterministic without reconstructing missing market history.
