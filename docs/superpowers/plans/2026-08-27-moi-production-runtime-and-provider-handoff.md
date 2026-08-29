# Moi Production Runtime and Provider Handoff Implementation Plan (Task 10 A → B → C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble the existing lifecycle, lease, recovery, engine, outbox, and stream parts into one `ProductionRuntime` behind `apps/paper-api/src/main.ts`, add the Toss OAuth/REST/WS adapters verified only against loopback fake servers, and prove the `CANCEL_ONLY → old leader disconnect → new leader recovery → NORMAL` handoff with two real API processes.

**Architecture:** One `paper-api` process owns HTTP, the KR+US leader-lease *bundle* (PostgreSQL advisory locks, sequential KR→US, cancellable 250 ms polling), one provider WebSocket per market, the `PaperEngine`, the single-owner `OutboxPublisherLoop` (periodic scheduling only while `SERVING`), and the user-stream upgrade bridge (`ws` noServer). Every abnormal path is fail-closed: the process stays alive in `CANCEL_ONLY`; only config/DB/invariant failures exit. Stage A is provider-neutral (fake bundle), Stage B adds the `toss` bundle + fake Toss servers, Stage C runs the two-process drill.

**Tech Stack:** Node 24.19.0, pnpm 11.22.0, TypeScript 7.0.2, Fastify 5.12.1, Kysely 0.29.5 + pg 8.23.0, zod 4.4.3, vitest 4.1.11, Testcontainers 12.1.0, `ws` 8.18.1 + `@types/ws` 8.18.1 (new, both packages), Biome 2.5.9.

**Spec:** `docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md` — **the spec is the contract.** Every test ID below (A1…A18, B1…B10, C1…C3, G1…G7, U1…U13, H1…H3, W1…W3, lease tests 1…13, drill steps 1…11) refers to that document; assertions are enumerated there and are not repeated in full here. When this plan and the spec disagree, the spec wins and this plan is fixed first.

## Global Constraints

- Node `24.19.0`, pnpm `11.22.0`; `ws` `8.18.1`, `@types/ws` `8.18.1` are the only new dependencies. No `@fastify/websocket`.
- Automated provider tests use only the in-memory `fake` bundle or loopback fake servers (`127.0.0.1`). No test, CI job, script, or drill contacts `openapi.tossinvest.com` / `openapi-ws.tossinvest.com`. Vitest global setup enforces `LIVE_PROVIDER_FORBIDDEN` (§9.5).
- Secrets (`TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, access tokens, `DATABASE_URL`, `SESSION_HASH_KEYS`, `CSRF_SECRET`, `ADMIN_API_KEY`) never appear in logs, audits, browser, CI, or test assertions (§5.6, B8).
- `MARKET_DATA_ADAPTER` has no implicit default in production; compose declares the literal `toss`; production `fake` is a start failure (§5.1).
- Lease acquisition is only the KR→US sequential bundle (`LeaseRegistry.acquireAll(signal)`); there is no public per-market `acquire`. `pg_advisory_lock` (blocking) is never used; only `pg_try_advisory_lock` polled at `LEASE_POLL_INTERVAL_MS = 250` + `pg_advisory_unlock` (§5.4).
- `OutboxPublisherLoop.start()` is called only inside `RuntimeStateMachine.enterServing()`; `pauseScheduling()` only inside `leaveServing(to)`; `shutdownDrain(deadline)` only in shutdown step 4b when `leftFrom === 'SERVING'`. No methods named `stop()` or `drain()` on the loop (§6.1, §7.4).
- `StreamGate.isOpen()` is derived from `runtimeState.current === 'SERVING'`; no separate flag (§6.1).
- Client→server stream protocol is the query string only (`afterSequence`, `quoteSymbols`); inbound frames close with 1003. The only web change is `use-portfolio-stream.ts` `streamUrl(afterSequence)` + removing the `onopen` send (§2.2, §7.5).
- Time constants are code constants except `SHUTDOWN_DRAIN_DEADLINE_MS` (5000..40000, default 30000) and `RECOVERY_STABILITY_MS` (0..30000, default 5000).
- Tests first (RED → GREEN), Biome-clean, one focused commit per task; `.codegraph/`, `.cursor/`, `.omc/`, `.superpowers/` stay untracked. Git author `changminKo <rhckdals123@gmail.com>`.
- Each stage ends with `pnpm check && pnpm typecheck && pnpm test && pnpm check:deployment && pnpm build`, plus e2e for A/C. Docker required for integration tests and the drill; a missing Docker is a **failure**, not a skip (§10.2).
- Do not advance to the next stage without approval.

## Design confirmations (resolved before coding; deviations from spec text are listed here, nowhere else)

1. `StartupCoordinator` currently takes `acquireLease(market)` and does `Promise.all` per market. §4.1 shows `StartupCoordinator ─ LeaseRegistry.acquireAll(signal)`. Task A5 changes the option to `acquireLeases: (signal: AbortSignal) => Promise<LeaseBundle>` and removes the per-market call; `RecoveryCoordinator.acquireLease` stays and is wired to `LeaseRegistry.held(market)` (§5.4, A10).
2. `RecoveryCoordinator` still calls `acquireLease(market)` first; unchanged (it now returns the held lease). Spec §7.2 confirms.
3. `apps/paper-api/Dockerfile` already runs `node apps/paper-api/dist/main.js`; the spec's `main.ts` entrypoint matches. No Dockerfile change in A.
4. `release-drill.integration.test.ts` "unavailable" case (currently `MARKET_DATA_ADAPTER=''`) is redefined per §11.1: `MARKET_DATA_ADAPTER=toss` without `TOSS_CLIENT_*` → `ConfigError`, EXIT 1 (A: `toss adapter is not available in this build`; B: credentials missing).
5. `infra/compose.yaml` label `moi.leader-markets: KRX,US` → `KR,US` and `docs/runbooks/redis-or-leader-loss.md` Redis-lease wording are fixed in Task A12 (§1.1-7).

---

## Stage A — ProductionRuntime (provider-neutral)

Order rationale: leaf components with pure/unit tests first (A1–A4), then lease layer (A5–A6), stream layer (A7–A9), runtime assembly (A10), production wiring + config (A11), docs/ops drift + gates (A12).

### Task A1: `ws` dependency, `RuntimeStateMachine`, `AdmissionLatch`, `TradingCapabilities`

**Files:**
- Modify: `apps/paper-api/package.json` (add `"ws": "8.18.1"` dependency, `"@types/ws": "8.18.1"` devDependency), `packages/market-data/package.json` (same), `pnpm-lock.yaml`
- Create: `apps/paper-api/src/runtime/runtime-state.ts`
- Create: `apps/paper-api/src/runtime/admission-latch.ts`
- Create: `apps/paper-api/src/runtime/trading-capabilities.ts`
- Test: `apps/paper-api/src/runtime/runtime-state.test.ts`, `admission-latch.test.ts`, `trading-capabilities.test.ts`
- Modify: `apps/paper-api/src/observability/metrics.ts` (add every §12.2 metric to `allowed`)

**Interfaces (Produces):**

```ts
// runtime-state.ts
export type RuntimeState =
  | 'BOOTING' | 'RESTORING' | 'ACQUIRING_LEASES' | 'RECOVERING'
  | 'SERVING' | 'RE_ELECTING' | 'DRAINING' | 'STOPPED' | 'FAILED_CLOSED';
export interface RuntimeStateObserver {
  onTransition(from: RuntimeState, to: RuntimeState): void; // sync; audit/metrics done by ProductionRuntime asynchronously
}
export interface ServingHooks {
  readonly openLatches: () => void;   // admission + both matching latches (sync)
  readonly closeLatches: () => void;  // sync
  readonly publisher: { start(): void; pauseScheduling(): Promise<unknown> | null };
}
export class RuntimeStateMachine {
  constructor(hooks: ServingHooks, observer?: RuntimeStateObserver);
  readonly current: RuntimeState;              // getter
  readonly leftFrom: RuntimeState | undefined; // set by leaveServing
  readonly pendingPoll: Promise<unknown> | null;
  transition(to: RuntimeState): void;          // for non-SERVING transitions
  enterServing(): void;                        // SYNC: current='SERVING' → openLatches() → publisher.start()
  leaveServing(to: 'RE_ELECTING' | 'DRAINING'): Promise<unknown> | null; // SYNC: current=to, leftFrom=prev → closeLatches() → pendingPoll = publisher.pauseScheduling()
  gate(): { isOpen(): boolean };               // isOpen := this.current === 'SERVING'
}
```

```ts
// admission-latch.ts — implements StartupLatch & ShutdownLatch
export class AdmissionLatch { close(): void; open(): void; get isClosed(): boolean; }
```

```ts
// trading-capabilities.ts
export class TradingCapabilities {
  constructor(deps: { latch: { isClosed: boolean }; activeIncidents: () => readonly SafetyIncident[] });
  for(market: Market): ReadonlySet<Capability>; // §6.4
  tradingHealth(extraReasons: readonly string[]): { placement: boolean; cancellation: true; fx: boolean; reasons: string[] }; // reasons include MARKET_DEGRADED:<M>
}
```

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @moi/paper-api add ws@8.18.1 && pnpm --filter @moi/paper-api add -D @types/ws@8.18.1
pnpm --filter @moi/market-data add ws@8.18.1 && pnpm --filter @moi/market-data add -D @types/ws@8.18.1
```

- [ ] **Step 2: Write failing tests** — `runtime-state.test.ts`: (a) `enterServing` calls `openLatches` then `publisher.start` with no microtask between (use a `queueMicrotask` observer that must not run between the two spy calls); `gate().isOpen()` is `true` only when `current === 'SERVING'`; (b) `leaveServing('DRAINING')` sets `leftFrom='SERVING'`, closes latches, stores `pendingPoll` from `pauseScheduling`, gate closed synchronously; (c) `leaveServing` from `RECOVERING` yields `pendingPoll === null`; (d) `RuntimeStateMachine.prototype.enterServing.constructor.name === 'Function'` and source has no `await`. `admission-latch.test.ts`: open/close/isClosed. `trading-capabilities.test.ts`: latch closed → `{CANCEL}`; MARKET incident on KR denies PLACE/AMEND/MATCH/TRIGGER for KR only; `tradingHealth` reasons `MARKET_DEGRADED:KR`, `placement:true` when US allows PLACE.
- [ ] **Step 3: Run** `pnpm --filter @moi/paper-api exec vitest run src/runtime` → FAIL (modules missing).
- [ ] **Step 4: Implement** the three modules exactly as the interfaces above; extend `metrics.ts` `allowed` with §12.2 names/labels (`runtime_state:['state']`, `leader_epoch:['market']`, `leader_lease_held:['market']`, `leader_lease_wait_seconds:['market']`, `provider_connections_open:[]`, `provider_token_refresh_total:['result']`, `market_event_rejected_total:['market','reason']`, `outbox_published_total:[]`, `outbox_drain_remaining:[]`, `stream_sessions_open:[]`, `shutdown_drain_seconds:['phase']`, `shutdown_forced_total:[]`, `leader_reelection_total:['market']`, `leader_lease_poll_total:['market']`, `http_admission_rejected_total:[]`, `http_admission_inflight:[]`, `http_admission_drain_remaining:[]`, `stream_upgrade_rejected_total:['reason']`, `stream_replay_queue_depth:[]`, `stream_replay_overflow_total:[]`, `outbox_claims_total:['mode']`, `outbox_shutdown_drain_rounds:[]`, `lease_lost_total:['market','phase']`).
- [ ] **Step 5: Run** tests → PASS; `pnpm check`.
- [ ] **Step 6: Commit** `feat(runtime): add runtime state machine, latch, and capabilities`

### Task A2: `RequestAdmissionGate` (HTTP ingress fence)

**Files:** Create `apps/paper-api/src/runtime/request-admission-gate.ts`; Test `apps/paper-api/src/runtime/request-admission-gate.test.ts`.

**Produces:**

```ts
export const HEALTH_PATHS = new Set(['/health/live','/health/ready','/health/market-data','/api/v1/health/trading','/metrics']);
export class RequestAdmissionGate {
  constructor(deps: { metrics?: MetricsRegistry; log?: (event: string, fields: Record<string, unknown>) => void });
  register(app: FastifyInstance): void;   // addHook onRequest (callback-style, length 3, sync), onResponse, onError, onRequestAbort — all root scope, once
  close(): void;                          // sync
  get closed(): boolean; get inFlight(): number;
  drain(deadline: number): Promise<void>; // 50 ms poll until inFlight === 0 or deadline → http_admission_drain_remaining
}
```

- [ ] **Step 1: Write failing tests G1–G7** (§6.6 “RequestAdmissionGate 규격”; G5/G5b use a real `listen` + raw TCP `socket.destroy()`; G6 asserts `hook.constructor.name === 'Function'`, `hook.length === 3`, and `!/\bawait\b/.test(hook.toString())`; G7 asserts four hooks registered once via `app[Symbol.for('fastify.hooks')]` or `app.printPlugins()`/hook spy).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (reject body `{code:'NOT_READY', message:'Server is draining', retryable:true, requestId}` + `Retry-After: 1`; `settle(request)` consumes `request.admitted` once; do NOT call `done()` after `reply.send` on rejection). **Step 4: Run** → PASS. **Step 5: Commit** `feat(runtime): fence HTTP ingress during drain`

### Task A3: `OutboxPublisherLoop` (single-owner, two stop operations)

**Files:** Create `apps/paper-api/src/modules/stream/outbox-publisher-loop.ts`; Modify `outbox-publisher.ts` (`pollOnce({mode})` emits claim before first `await` — i.e. `const claimPromise = this.#store.claim(...)` synchronously and counter increment before awaiting); Test `outbox-publisher-loop.test.ts` (fake timers).

**Produces:**

```ts
export type OutboxPollMode = 'periodic' | 'shutdown_drain';
export class OutboxPublisherLoop {
  constructor(deps: { publisher: { pollOnce(opts: { mode: OutboxPollMode }): Promise<{claimed:number;published:number;failed:number}> }; prune: () => Promise<void>; metrics: MetricsRegistry; log: LogFn; intervalMs?: 200; pruneEveryMs?: 600_000 });
  start(): void;                                   // TOTAL: `this.running = true; this.timer = setTimeout(this.tick, 0);` nothing else; idempotent (one timer)
  pauseScheduling(): Promise<unknown> | null;      // SYNC, idempotent: clearTimeout, running=false, return in-flight pollOnce promise or null
  shutdownDrain(deadline: number): Promise<{rounds:number;claimed:number;remaining:number;deadlineHit:boolean}>; // precondition !isRunning() && !hasInFlightPoll(); repeats pollOnce({mode:'shutdown_drain'}) until claimed===0 twice or deadline; no setTimeout, never touches `running`
  isRunning(): boolean; hasInFlightPoll(): boolean;
}
```

- [ ] **Step 1: Write failing tests** covering A17 static+dynamic total-function invariants (`start.toString()` has no `await|throw|try|async`, exactly one call expression `setTimeout`; all injected deps throwing → `start()` returns, `isRunning()===true`, second `start()` keeps `vi.getTimerCount()===1`; first tick's `pollOnce` throwing is logged and the tick re-arms), A18 `pauseScheduling` semantics (sync return of pending promise while `publish` blocked by a `Deferred`; `isRunning()===false && hasInFlightPoll()===true`; advancing 200 ms+ starts no new poll; second call returns same promise; `null` when idle), `shutdownDrain` precondition rejection (claim 0), `shutdownDrain` loop ending on two consecutive `claimed:0` with `outbox.drain` summary log and `outbox_claims_total{mode:'shutdown_drain'}`, and source-level checks (`!/setInterval|\bstop\(|\bdrain\(/.test(source)`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(stream): single-owner outbox publisher loop`

### Task A4: `StreamHub`, `StreamHeartbeatLoop`, `StreamSession.open` result, `parseStreamQuery`, `cookieValueFromHeader`

**Files:**
- Modify: `apps/paper-api/src/modules/stream/stream-session.ts` — `export const STREAM_HEARTBEAT_MS = 30_000`; `static open(): Promise<StreamOpenResult>` where `StreamOpenResult = { session: StreamSession; replayedUpTo: string; replayedEventIds: ReadonlySet<string> }`; add `heartbeat(serverTime: string): void`; export `STREAM_MAX_QUOTE_SUBSCRIPTIONS = 5`
- Modify callers: `stream-routes.ts` (`(await StreamSession.open(options)).session` — unused in prod but kept), `stream-routes.test.ts`, `apps/e2e/start-system.ts` if it calls `open` (it does not today)
- Create: `stream-hub.ts`, `stream-heartbeat-loop.ts`, `stream-query.ts`
- Modify: `apps/paper-api/src/plugins/session-auth.ts` — `export function cookieValueFromHeader(header: string | undefined, name: string)`; `cookieValue` becomes a thin wrapper
- Test: `stream-hub.test.ts` (in-memory sockets, U11/U11b/U11c/U11d/U13 hub-level parts), `stream-heartbeat-loop.test.ts` (H1), `stream-query.test.ts` (U1b/U1c validation matrix), `session-auth.test.ts` (U10)

**Produces:**

```ts
// stream-hub.ts
export const STREAM_OPENING_QUEUE_MAX = 200; export const STREAM_PROMOTE_MAX_ROUNDS = 20;
export type StreamEntryState = 'OPENING' | 'LIVE';
export class StreamHub {
  constructor(deps: { metrics?: MetricsRegistry; log?: LogFn });
  registerOpening(sessionId: string, ws: StreamSocket): StreamHandle;
  unregister(sessionId: string, handle: StreamHandle): void;          // idempotent
  deliver(sessionId: string, event: DurableAccountEvent): Promise<void>;
  promoteToLive(sessionId: string, handle: StreamHandle, opened: StreamOpenResult): Promise<boolean>; // §7.5 step 5 algorithm; `state='LIVE'` assignment ONLY inside `if (entry.queue.length === 0)`
  publishQuote(event: QuoteEvent): void; heartbeat(serverTime: string): void; // LIVE only
  closeAll(code: number, reason: string): Promise<void>; size(): number;
  stateOf(handle: StreamHandle): StreamEntryState | undefined; queueDepth(handle: StreamHandle): number;
}
// stream-heartbeat-loop.ts
export class StreamHeartbeatLoop { constructor(o: { hub: StreamHub; intervalMs?: number; clock?: () => Date }); start(): void; stop(): void; }
// stream-query.ts
export function parseStreamQuery(url: URL): { afterSequence?: string; quoteSymbols: readonly { market: Market; symbol: string }[] }; // throws StreamQueryError(400)
```

- [ ] **Step 1: Write failing tests** (hub round-flush total order with a `Deferred` on `session.deliver`; dedupe via `replayedUpTo`/`replayedEventIds`; overflow 4010 + `resync-required`; unregister cleanup; heartbeat LIVE-only; H1 `vi.getTimerCount()===1`, `STREAM_HEARTBEAT_MS === ready.heartbeatIntervalMs` read from a real `open`; query matrix from U1b/U1c; U10 cookie parser parity).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Static test: `promoteToLive.toString()` contains exactly one `'LIVE'` assignment and it is inside the `queue.length === 0` branch. **Step 4: Run** → PASS (`stream-routes.test.ts` still green after `.session`). **Step 5: Commit** `feat(stream): add stream hub barrier, heartbeat loop, and query parser`

### Task A5: `LeaderLease` rewrite + `003_leader_release.sql` + `LeaseAuditPort`

**Files:**
- Create: `apps/paper-api/src/db/migrations/003_leader_release.sql` — `alter table leader_epochs add column released_at timestamptz;`
- Modify: `apps/paper-api/src/db/migrate.ts` (`MIGRATION_NAMES` add `'003_leader_release'`)
- Modify: `apps/paper-api/src/market-data/leader-lease.ts`
- Create: `apps/paper-api/src/runtime/lease-audit.ts`
- Test: `apps/paper-api/src/market-data/leader-lease.integration.test.ts` (replace; tests 1–8, 11, 12 of §5.4), `apps/paper-api/src/db/migration.integration.test.ts` (column exists, nullable)

**Produces:**

```ts
export const LEASE_POLL_INTERVAL_MS = 250;
export type LeaseState = 'ACQUIRING' | 'HELD' | 'RELEASING' | 'RELEASED' | 'LOST';
export interface LeaseAuditContext { market: Market; epoch: bigint; fencingToken: bigint; leaderId: string }
export interface LeaseAuditPort {
  recordAcquired(query: LeaseConnection['query'], ctx: LeaseAuditContext): Promise<void>;
  recordReleased(query: LeaseConnection['query'], ctx: LeaseAuditContext): Promise<void>;
}
export interface LeaderLeaseOptions {
  connectionString?: string; leaderId: string; clientFactory?: () => Promise<LeaseConnection>;
  signal?: AbortSignal; pollIntervalMs?: number; audit?: LeaseAuditPort;
  onLost?: (market: Market) => void; log?: LogFn; metrics?: MetricsRegistry;
}
export class LeaderLease {
  static acquire(market: Market, options: LeaderLeaseOptions): Promise<LeaderLease>; // single signature; the legacy (db, market, options) overload is removed and callers updated
  readonly market; readonly epoch; readonly fencingToken; readonly leaderId; get state(): LeaseState; get isHeld(): boolean;
  release(): Promise<void>;
}
export class AbortError extends Error {} // name 'AbortError'
// lease-audit.ts
export const leaseAuditPort: LeaseAuditPort; // single insert into audit_events, same columns as appendAuditEvent
```

- [ ] **Step 1: Write failing integration tests** 1–8, 11, 12 (Testcontainers PG; `LeaseConnection` recorder wrapper records query texts and can intercept the resolve of a specific query for test 8; real 250 ms polling).
- [ ] **Step 2: Run** `pnpm --filter @moi/paper-api exec vitest run src/market-data/leader-lease` → FAIL.
- [ ] **Step 3: Implement** per §5.4: poll loop → abort recheck (unlock + end + `AbortError`, log `lease.acquire_aborted{lockedThenUnlocked:true}`) → `begin` → upsert with `released_at = null` → `audit.recordAcquired` → `commit`; on failure `rollback` → unlock → end. `release()`: `state='RELEASING'` first → `begin` → `update … released_at = now()` → `audit.recordReleased` → `commit` (on failure `rollback` + log `lease.release_mark_failed`) → `finally` unlock + end. `#reportLost()` single handler for `error`/`end`; fires `onLost` once only from `HELD`. Metrics `leader_lease_poll_total{market}`, `leader_lease_wait_seconds{market}`; log `lease.waiting` at first poll and every 10 s.
- [ ] **Step 4: Run** → PASS; static assertions in test: source has no `pg_advisory_lock(` and `release` sets `RELEASING` before first query.
- [ ] **Step 5: Commit** `feat(lease): cancellable polling acquire with audited release`

### Task A6: `LeaseRegistry` (bundle) + `StartupCoordinator` bundle option

**Files:** Create `apps/paper-api/src/runtime/lease-registry.ts`; Modify `apps/paper-api/src/lifecycle/startup-coordinator.ts` (`acquireLeases: (signal) => Promise<LeaseBundle>` replaces `acquireLease`; sequential inside registry); Modify `startup-coordinator.integration.test.ts`; Test `apps/paper-api/src/runtime/lease-registry.integration.test.ts` (§5.4 tests 9, 10, 11 registry-level, 12 registry-level, 13).

**Produces:**

```ts
export class LeaseNotHeldError extends Error {}
export class LeaseLostError extends Error { constructor(public readonly market: Market) }
export type LeaseBundle = Readonly<Record<Market, LeaderLease>>;
export class LeaseRegistry {
  constructor(deps: { connectionString: string; leaderId: string; audit: LeaseAuditPort; onLostHeld: (market: Market) => void /* → ProductionRuntime.reelect */; log: LogFn; metrics: MetricsRegistry; clientFactory?: () => Promise<LeaseConnection> });
  acquireAll(signal: AbortSignal): Promise<LeaseBundle>; // KR then US; shares in-flight promise; partial reverse release on abort/failure; generation tracking {generation, controller, pending, held}
  held(market: Market): LeaderLease;               // throws LeaseNotHeldError
  abortPending(): Promise<void>;
  releaseAll(): Promise<void>;                     // US → KR; logs lease.released{auditPersisted}; writes no audit rows
  get pending(): Market | null; get generation(): number;
}
```

- [ ] **Step 1: Write failing tests** 9, 10, 13 and registry parts of 11/12 (observer connection holds US lock via `select pg_try_advisory_lock(hashtext('US'))`; `pg_terminate_backend` for loss; spies: `connect`, `getAccessToken`, `reelect`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; update `StartupCoordinator` + its test (open: latches close → restore → verifyInvariants → `await acquireLeases(signal)` → `Promise.all(recover)` → latches open). **Step 4: Run** lease + startup tests → PASS; static test: `LeaseRegistry` has no public `acquire(` method, only `acquireAll(`. **Step 5: Commit** `feat(runtime): acquire leader leases as a sequential KR→US bundle`

### Task A7: Stream upgrade bridge (`ws` noServer)

**Files:** Create `apps/paper-api/src/modules/stream/stream-upgrade.ts`; Test `stream-upgrade.test.ts` (U1–U13 incl. U1b/U1c/U8b/U9b/U9c/U9d/U12, H2); Modify `stream-routes.ts` docs comment only (426 fallback retained).

**Produces:** exactly the `createStreamUpgradeHandler({...})` signature and return type from §7.5, with constants `STREAM_MAX_PAYLOAD_BYTES = 4096`, `STREAM_CLOSE_GRACE_MS = 2000`.

- [ ] **Step 1: Write failing tests** U1–U13 + H2 with real `127.0.0.1` listen, `ws` client, in-memory `SessionService`-shaped stub, `Deferred`-wrapped `authenticate`, `LayeredRateLimiter` real instance, `gate` stub.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the 0/0b/1–10 check table, `onOpen` steps 1–6, `detach()`/`closeAll()`/`pendingCount()`, `stream_upgrade_rejected_total{reason}`; wrap everything in try/catch → 500 + destroy + `stream.upgrade_failed`. **Step 4: Run** → PASS. **Step 5: Commit** `feat(stream): authenticate websocket upgrades in a noServer bridge`

### Task A8: Web hook alignment (`streamUrl(afterSequence)`)

**Files:** Modify `apps/web/src/features/portfolio/use-portfolio-stream.ts` (only: `streamUrl(afterSequence?: string)` sets query when `/^(0|[1-9][0-9]{0,18})$/` matches; `connect()` passes `stateRef.current?.snapshot.accountSequence`; `onopen` keeps `attempt.current = 0` only); Create `apps/web/src/features/portfolio/use-portfolio-stream.test.tsx` (W1, W1b, W2, W3).

- [ ] **Step 1: Write failing tests W1–W3** (`webSocketFactory` fake socket recording URL and `send` calls; `vi.useFakeTimers`; seed `queryClient.setQueryData(PORTFOLIO_QUERY_KEY, …)`).
- [ ] **Step 2: Run** `pnpm --filter @moi/web exec vitest run use-portfolio-stream` → FAIL (send called / no query). **Step 3: Edit** the three lines. **Step 4: Run** → PASS; `git diff apps/web` touches only `streamUrl`, the `connect()` URL argument, and `onopen` (A13 review item). **Step 5: Commit** `fix(web): send afterSequence as a stream query parameter`

### Task A9: `MarketRuntime`, `SupervisedRecovery`, `KeepaliveLoop`, `ReconnectSupervisor`, `MarketEventLoop`

**Files:** Create `apps/paper-api/src/runtime/market-runtime.ts` (contains `MarketRuntime`, `SupervisedRecovery`, `KeepaliveLoop`, `MarketEventLoop`), `apps/paper-api/src/runtime/reconnect-supervisor.ts`; Test `market-runtime.test.ts` (FakeMarketData + in-memory snapshot source; A2, A3 unit-level, §7.1 rejection burst, §7.3 keepalive with fake timers, §8.2 causeCode mapping, §8.3 window), `reconnect-supervisor.test.ts`.

**Produces:**

```ts
export interface MarketRuntimeDeps {
  market: Market; stream: MarketDataStream; snapshots: MarketSnapshotSource; tokenProvider?: TokenProvider;
  stateStore: MarketStateStore; health: MarketHealthMachine; engine: PaperEngine; hub: StreamHub; incidents: IncidentService;
  leases: { held(m: Market): LeaderLease }; symbols: readonly string[]; subscriptions: readonly SubscriptionDeclaration[];
  stabilityMs: number; metrics: MetricsRegistry; log: LogFn; clock?: RecoveryClock;
}
export class MarketRuntime {
  constructor(deps: MarketRuntimeDeps);
  connect(signal: AbortSignal): Promise<void>;   // SupervisedRecovery.recover → apply triggers → markHealthy → start event loop + keepalive
  abort(): void;                                  // AbortController abort (event loop, keepalive, in-flight recovery)
  close(): Promise<void>;                         // abort + stream.close()
  readonly health: MarketHealthMachine; readonly supervisor: ReconnectSupervisor;
}
export class ReconnectSupervisor { constructor(o: { delayMs: (attempt: number) => number; windowMs?: 300_000; maxFailures?: 3; onExhausted: () => Promise<void>; clock?: RecoveryClock }); schedule(run: () => Promise<boolean>, opts?: { immediate?: boolean; serverShutdown?: boolean }): void; recordFailure(): boolean /* exhausted */; reset(): void; resume(): void; }
```

- [ ] **Step 1: Write failing tests** (transport close → DEGRADED only that market → recovery → HEALTHY, epoch +1, `feed_reconnect_total`; 3 failures/5 min → `RECOVERY_RETRY_EXHAUSTED` manual incident; keepalive 60 s ping, 2 misses → close; 20 consecutive rejected events → `EVENT_REJECTION_BURST`; SupervisedRecovery maps errors to causeCodes and returns normally; invariant errors rethrown).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(runtime): supervise per-market recovery, keepalive, and reconnect`

### Task A10: `ProductionRuntime` assembly + shutdown wiring + `ProviderBundle` interface + fake bundle

**Files:**
- Create: `apps/paper-api/src/runtime/production-runtime.ts`, `apps/paper-api/src/runtime/provider-bundle.ts`
- Create: `packages/market-data/src/fake-snapshot-source.ts` (promote e2e deterministic snapshot source; export from `./testing` entry and `index.ts`), add connection counter to `FakeMarketData` (`openConnections`, `peakConcurrentConnections` shared via an injectable `FakeConnectionLedger` for A16)
- Modify: `apps/paper-api/src/modules/health/health-routes.ts` (`marketData` per market `{state, reasons}`; `ready` returns 503 `{draining:true}` when draining flag set; trading reasons include runtime state)
- Test: `apps/paper-api/src/runtime/production-runtime.integration.test.ts` (A1, A2, A4, A4b, A5, A5b, A6, A7, A10, A15 + variants, A16, A16b, A17, A18 runtime parts)

**Produces:**

```ts
// provider-bundle.ts
export interface ProviderBundle {
  readonly kind: 'fake' | 'toss';
  streamFor(market: Market): MarketDataStream; readonly snapshots: MarketSnapshotSource;
  readonly instruments?: InstrumentCatalog; readonly calendar?: MarketCalendarSource; readonly fx?: FxRateSource;
  readonly tokenProvider?: TokenProvider; connectionsOpen(): number; close(): Promise<void>;
}
export function createProviderBundle(config: AppConfig, overrides?: Partial<ProviderBundle>): ProviderBundle; // A: 'toss' → throw ConfigError('toss adapter is not available in this build')
// production-runtime.ts
export interface ProductionRuntimeOptions { config: AppConfig; bundle: ProviderBundle; leaderId?: string; signal?: AbortSignal; hooks?: RuntimeTestHooks /* spies: onPhase, deferSnapshots */ }
export class ProductionRuntime {
  constructor(o: ProductionRuntimeOptions);
  start(): Promise<{ app: FastifyInstance; port: number }>; // BOOTING→RESTORING→ACQUIRING_LEASES→RECOVERING→SERVING
  reelect(reason: { lostMarket: Market }): Promise<void>;  // §6.5 steps 1–7, joins in-flight
  stop(): Promise<{ forced: boolean }>;                    // ShutdownCoordinator.drain → app.close → database.destroy
  readonly state: RuntimeStateMachine;
}
```

- [ ] **Step 1: Write failing integration tests** listed above (Testcontainers PG + Redis; observer lock connection; `pg_terminate_backend` on lease backend found by `application_name = 'moi-lease-<market>-<leaderId>'` — set `application_name` in `LeaderLease` connection options in A5 if not already; order-recording spies for A5 sequence; `queueMicrotask` observers for A17).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `ProductionRuntime` per §4/§6/§6.5/§6.6 (ShutdownCoordinator callbacks table; `RUNTIME_STATE_CHANGED`, `RUNTIME_DRAINING`, `RUNTIME_STOPPED`, `RECOVERY_COMPLETED`, `STARTUP_INVARIANT_OR_AUDIT_FAILURE` audits; `/health/*` extension; `registerStreamRoutes` 426 fallback + bridge attach after `app.ready()` before `listen`; heartbeat loop start). **Step 4: Run** → PASS. **Step 5: Commit** `feat(runtime): assemble the production runtime and shutdown sequence`

### Task A11: `config.ts` rules, `main.ts` reduction, release-drill redefinition, logger redaction

**Files:** Modify `apps/paper-api/src/config.ts` (§5.1 table: `MARKET_DATA_ADAPTER`, `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, `TOSS_REST_BASE_URL`, `TOSS_WS_URL`, `SHUTDOWN_DRAIN_DEADLINE_MS`, `RECOVERY_STABILITY_MS`, loopback rule §5.3, `ConfigError` class); Modify `apps/paper-api/src/main.ts` → `loadConfig()` → `createProviderBundle(config)` → `new ProductionRuntime({config, bundle}).start()`; delete cancel-only `execute`, `cancelOnly`, stub engine; Modify `apps/paper-api/src/observability/logger.ts` (`authorization|access_token|client_secret|TOSS_CLIENT_SECRET` keys + `Bearer\s+\S+` value pattern); Modify `apps/paper-api/src/release-drill.integration.test.ts` ("unavailable" → `MARKET_DATA_ADAPTER=toss`, no `TOSS_CLIENT_*` → exit 1, stderr contains `ConfigError`); Test `config.test.ts` (A8 matrix), `logger.test.ts` (redaction), `main.integration.test.ts` (A12: real `ws` client with cookie + `?afterSequence` receives outbox event; inbound frame → 1003).

- [ ] **Step 1: Write failing tests.** **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** paper-api suite → PASS. **Step 5: Commit** `feat(api): boot the production runtime from an explicit adapter config`

### Task A12: Deployment contract, docs drift, e2e switch, Stage A gate

**Files:** Modify `infra/compose.yaml` (`MARKET_DATA_ADAPTER: toss` literal; `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET` `${…:?}`; label `KR,US`), `scripts/check-deployment-contract.mjs` (assert literal `toss`; add two secrets to required interpolation; `tossinvest.com` string scan over test sources excluding contracts/spec/`TOSS_CONTRACT_SERVERS`; leader-markets ⊆ {KR,US}), `scripts/check-deployment-contract.test.mjs` (new: temp-copy mutations fail — A8 second half), `infra/monitoring/prometheus-alerts.yaml` (§12.3 alerts incl. `OutboxClaimsOutsideServing`, `OutboxShutdownDrainOutsideDraining`), `docs/runbooks/redis-or-leader-loss.md` (remove Redis-lease wording; add “이전 프로세스가 종료되지 않음”, “한 시장 lease 손실은 전역 재선출” sections), `docs/runbooks/market-data-degraded.md` (`PROVIDER_IP_NOT_ALLOWED`), `docs/operations/deployment.md` (P2-ready precondition sentence, egress IP note), `apps/e2e/start-system.ts` (replace hand-rolled upgrade with `createStreamUpgradeHandler` + `StreamHeartbeatLoop` + `FakeSnapshotSource` from `@moi/market-data/testing`).

- [ ] **Step 1: Write failing checker test + update checker; run** `pnpm check:deployment` → FAIL until compose updated. **Step 2: Apply compose/docs/alerts.** **Step 3: Switch e2e start-system; run** `pnpm --filter @moi/e2e test:e2e` → 18/18. **Step 4: Full gate** `pnpm check && pnpm typecheck && pnpm test && pnpm check:deployment && pnpm build`. **Step 5: Commit** `chore(ops): declare the toss adapter contract and fix leader runbook drift` — then **STOP for Stage A approval / Codex verification** (§11.1 Codex items).

---

## Stage B — OAuth + Toss REST/WS adapters, fake servers (after A approval)

### Task B1: Live-provider guard + contract server constants

**Files:** Create `packages/market-data/vitest.setup.ts`, `apps/paper-api/vitest.setup.ts` (wrap `globalThis.fetch` and `ws` `WebSocket` constructor: non-loopback host → `Error('LIVE_PROVIDER_FORBIDDEN: <host>')`); wire via `vitest.config.ts` `setupFiles` in both packages; Create `packages/market-data/src/toss/contract-servers.ts` (`TOSS_CONTRACT_SERVERS = { rest: 'https://openapi.tossinvest.com', ws: 'wss://openapi-ws.tossinvest.com/ws/v1' }`); Test `contract-servers.test.ts` (B10: equals `openapi.json` `servers[0].url` and `asyncapi.json` `servers.production`; SHA-256 matches `provenance.json`), `live-guard.test.ts` (B9).

- [ ] RED → GREEN → Commit `test(market-data): forbid live provider hosts and pin contract servers`

### Task B2: `FakeTossRestServer` + `OAuthTokenProvider`

**Files:** Create `packages/market-data/testing/fake-toss/fake-toss-rest-server.ts` (§9.2 table + control API), `packages/market-data/src/toss/oauth-token-provider.ts`; Modify `types.ts` (`MarketDataErrorCode` add `AUTH_FAILED`, `AUTH_THROTTLED`, `RATE_LIMITED`); Test `oauth-token-provider.test.ts` (B5 with in-memory fetch), `oauth-token-provider.integration.test.ts` (against fake REST over TCP), `fake-toss-rest-server.test.ts`.

**Produces:** `class OAuthTokenProvider implements TokenProvider { constructor(o: { baseUrl: string; clientId: string; clientSecret: string; fetch?: FetchLike; clock?: () => number; metrics?: … }); getAccessToken(signal): Promise<string>; invalidate(): void }`, constants `TOKEN_REFRESH_LEAD_MS = 300_000`, `TOKEN_MIN_REISSUE_INTERVAL_MS = 10_000`.

- [ ] RED → GREEN → Commit `feat(market-data): add oauth token provider and fake toss rest server`

### Task B3: `FakeTossWsServer` + `TossWebSocketMarketData` fixes (defects §1.1-1/2/3)

**Files:** Create `packages/market-data/testing/fake-toss/fake-toss-ws-server.ts` (§9.3 table, counters `connections`, `peakConcurrentConnections`, `evictions`); Modify `toss-websocket.ts` (declare frame = JSON array `[{id},{type:'trade:us',codes:[…]}]`; `TossWebSocketOptions.market`; remove `setInterval` keepalive; `ws`-based default `TossSocketFactory` with `Authorization: Bearer` header; 401→`AUTH_FAILED` with one `invalidate()` + retry, 403→`AUTH_FAILED`(`PROVIDER_IP_NOT_ALLOWED` mapping via `statusCode`), `rate-limit-exceeded` → one re-declare after 1 s, `server-shutdown` → `transportClosed{reason:'server-shutdown'}`); Modify `toss-rest.ts` (429 + `Retry-After` honored, max 2 retries; `RATE_LIMITED`); Test `toss-websocket.conformance.test.ts` (B1 via `runMarketDataConformance`), `toss-websocket.fake-server.test.ts` (B2, B3, B4 static `!/setInterval/.test(source)`, keepalive 1:1 with fake pong log, §8.4 mapping), `toss-rest.fake-server.test.ts` (B6).

- [ ] RED (conformance fails on `wrong-format`) → GREEN → Commit `fix(market-data): align toss websocket adapter with the pinned contract`

### Task B4: `toss` provider bundle + runtime integration (B7, B8)

**Files:** Modify `apps/paper-api/src/runtime/provider-bundle.ts` (`toss` → `OAuthTokenProvider` + `TossRestClient` + per-market `TossWebSocketMarketData`; remove A's `not available` error); Modify `release-drill.integration.test.ts` (unavailable → credentials-missing `ConfigError`); Modify `main.ts` only if bundle factory signature changed; Test `production-runtime.toss.integration.test.ts` (A1–A5 equivalents with fake servers; `server-shutdown` → 1 s → `NORMAL`; B8 log-capture regex `Bearer\s+\S+|client_secret=|<issued token>` = 0 hits).

- [ ] RED → GREEN → full gate (`pnpm check && typecheck && test && check:deployment && build`) → Commit `feat(runtime): wire the toss provider bundle` — **STOP for Stage B approval / Codex verification**.

---

## Stage C — Two-process handoff drill (after B approval)

### Task C1: Two-process harness

**Files:** Create `apps/paper-api/src/runtime/testing/two-process-harness.ts` (Testcontainers PG 17 + Redis 7, fake REST/WS servers, credential issue, `spawn('node', ['dist/main.js'])` with §10.1 env, 100 ms observers for `/health/*`, `/api/v1/health/trading`, `/health/market-data`, `/metrics` (recorded, not asserted), `outbox_events` + `pg_stat_activity` + `leader_epochs` observer connection, stdout JSON line capture per process, harness `ws` client with `eventId` dedupe across P1/P2 sockets, evidence writer `apps/paper-api/test-results/leader-handoff/<utc>.json`); Test `two-process-harness.test.ts` (harness boots one process to `NORMAL` and tears down; Docker absent → **fails**).

- [ ] Prereq: `pnpm --filter @moi/paper-api build` (drill uses `dist/main.js`; add `pretest` hook or assert dist freshness by mtime > src mtime).
- [ ] RED → GREEN → Commit `test(runtime): add two-process leader handoff harness`

### Task C2: Drill `leader-handoff.drill.integration.test.ts`

**Files:** Create `apps/paper-api/src/runtime/leader-handoff.drill.integration.test.ts` implementing §10.2 steps 1–11 (with 3b precondition; step 4/5/6/8 C-path (i)/(ii) tolerance; step 10 partial-loss + waiter; step 11 SIGTERM while polling ≤ 3 s); overall timeout 180 s.

- [ ] Run `pnpm --filter @moi/paper-api test -- leader-handoff.drill` **3 consecutive times** (C1: each `peakConcurrentConnections===2`, `evictions===0`, split-lease observations 0). Record the three JSON files.
- [ ] Commit `test(runtime): prove graceful leader handoff with two processes`

### Task C3: Evidence and checklist

**Files:** Modify `docs/operations/release-checklist.md` (cite drill JSON summary: time, commit, peak=2, evictions=0; mark the handoff item `[x]` — **only after Codex verification passes**), `docs/operations/deployment.md` (drill command in stop-then-start section), each `docs/runbooks/*.md` Verification section (drill command).

- [ ] Full gate + e2e → Commit `docs: record leader handoff drill evidence` (last commit of C).

---

## Self-review

- **Spec coverage:** §4.1 components → A1 (state/latch/capabilities), A2 (gate), A3 (publisher loop), A4 (hub/heartbeat/query/cookie), A5–A6 (lease/audit/registry/migration), A7 (bridge), A8 (web), A9 (market runtime/supervisors), A10 (ProductionRuntime/bundle/fake snapshot), A11 (config/main/logger/release-drill), A12 (compose/checker/alerts/runbooks/e2e). §5.5/§5.7/§8.4/§9 → B1–B4. §10 → C1–C3. §12.2 metrics → A1; §12.3 alerts → A12; §12.4 log events → emitted in A3/A5/A6/A7/A10. §13 migration → A5; deployment precondition → A12/C3.
- **Placeholder scan:** assertions are delegated to spec IDs by design (spec enumerates them); every task names its files, interfaces, RED command, and commit.
- **Type consistency:** `StreamOpenResult` (A4) consumed by A7/A10; `LeaseBundle`/`held()` (A6) consumed by A9/A10; `RuntimeStateMachine.gate()` (A1) consumed by A7 `gate` option and A10; `OutboxPollMode` (A3) used in A10 logs/metrics; `ProviderBundle` (A10) implemented by B4; `FakeTossWsServer` counters (B3) consumed by C1/C2.
