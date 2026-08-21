# Skipjack Paper API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the approved trading engine through a secure, idempotent Fastify API with anonymous sessions, virtual FX, portfolio snapshots, user streams, health/admin controls, rate limits, and observability.

**Architecture:** Fastify routes perform transport validation and delegate to application services that own one transaction per command. Session cookies, CSRF, idempotency, safety capabilities, and PostgreSQL outbox delivery are composed as plugins; no route writes raw ledger rows or calls Toss directly.

**Tech Stack:** The Plan 1–2 stack plus Fastify 5.12.1, @fastify/cookie 11.1.2, @fastify/cors 11.3.0, @fastify/helmet 13.1.1, @fastify/websocket 11.3.0, @fastify/rate-limit 11.2.0, Zod 4.4.3, Pino 10.3.1, ioredis 6.0.0, prom-client 15.1.3, and Node.js crypto.

**Spec:** `docs/superpowers/specs/2026-08-21-skipjack-paper-trading-architecture-design.md`

## Global Constraints

- Complete the foundation/core and market-data/engine plans first.
- Browser clients never receive Toss credentials or access Toss directly.
- Anonymous session tokens contain at least 256 random bits, are stored only as hashes, and use `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- New sessions receive KRW 10,000,000 and USD 0 exactly once; expired sessions cancel active orders and release reservations before deletion.
- Every write validates Origin and CSRF and requires an `Idempotency-Key` where specified.
- Stable errors contain `code`, `message`, `retryable`, optional `retryAfter`, and `requestId`.
- The closed error catalog contains every core spec code plus transport/domain extensions `NOT_FOUND`, `VALIDATION_ERROR`, `FORBIDDEN`, `SESSION_EXPIRED`, and `QUOTE_EXPIRED`; each has one documented HTTP status and retry policy.
- Deterministic accepted/rejected responses are stored for at least 24 hours; transient pre-transaction `503` and rate-limit responses are not stored.
- `CANCEL_ONLY` cancellation receives a separate priority limiter; Redis loss blocks placement/amendment but does not block safe cancellation.
- The user stream is at-least-once and clients deduplicate `eventId`; account sequence gaps force a snapshot refresh.
- Admin endpoints are not exposed on the public listener in production.
- Every task follows TDD and ends in a focused commit.

---

### Task 1: Compose a testable Fastify application

**Files:**
- Create: `apps/paper-api/src/config.ts`
- Create: `apps/paper-api/src/app.ts`
- Create: `apps/paper-api/src/server.ts`
- Create: `apps/paper-api/src/plugins/error-handler.ts`
- Create: `apps/paper-api/src/plugins/request-context.ts`
- Create: `apps/paper-api/src/app.test.ts`
- Create: `apps/paper-api/.env.example`
- Modify: `apps/paper-api/src/index.ts`
- Modify: `apps/paper-api/package.json`

**Interfaces:**
- Consumes: environment values and dependency instances from Plans 1–2.
- Produces: `AppConfig`, `AppDependencies`, `buildApp(config, dependencies)`, `startServer()`, `RequestContext`, and stable error serialization.

- [ ] **Step 1: Write an injection-only app test**

```ts
it('returns a request id and stable not-found envelope', async () => {
  const app = await buildApp(testConfig(), fakeDependencies());
  const response = await app.inject({ method: 'GET', url: '/missing' });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({
    code: 'NOT_FOUND',
    message: 'Route not found',
    retryable: false,
    requestId: expect.any(String),
  });
});
```

- [ ] **Step 2: Run and verify the app is missing**

Run: `pnpm --filter @skipjack/paper-api test -- app.test.ts`

Expected: FAIL because `buildApp` does not exist.

- [ ] **Step 3: Implement configuration and composition root**

```ts
export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly sessionHashKeys: readonly [string, ...string[]];
  readonly csrfSecret: string;
}

export async function buildApp(config: AppConfig, deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger, genReqId: deps.requestId, bodyLimit: 65_536 });
  await app.register(helmet);
  await app.register(cors, { origin: config.publicOrigin, credentials: true });
  await registerRequestContext(app, deps.clock);
  await registerErrorHandler(app);
  await registerRoutes(app, deps);
  return app;
}
```

Validate environment with Zod at process start; `server.ts` alone opens sockets, runs the Plan 2 startup coordinator, and handles SIGTERM through the shutdown coordinator. Tests always call `buildApp()` and `inject()`. Add injection cases for an unapproved Origin, a body above 64 KiB, and an unknown request field; all return stable non-retryable errors.

- [ ] **Step 4: Run app, type, and redaction tests**

Run: `pnpm --filter @skipjack/paper-api test -- app.test.ts && pnpm --filter @skipjack/paper-api typecheck`

Expected: PASS and logs redact authorization, cookie, CSRF, and session-token fields.

- [ ] **Step 5: Commit app composition**

```bash
git add apps/paper-api pnpm-lock.yaml
git commit -m "feat(api): compose Fastify application"
```

---

### Task 2: Implement anonymous sessions, cookie rotation, and expiry

**Files:**
- Create: `apps/paper-api/src/modules/session/session-token.ts`
- Create: `apps/paper-api/src/modules/session/session-token.test.ts`
- Create: `apps/paper-api/src/modules/session/session-service.ts`
- Create: `apps/paper-api/src/modules/session/session-service.integration.test.ts`
- Create: `apps/paper-api/src/modules/session/session-routes.ts`
- Create: `apps/paper-api/src/modules/session/session-routes.test.ts`
- Create: `apps/paper-api/src/modules/session/session-cleanup.ts`
- Create: `apps/paper-api/src/modules/session/session-cleanup.integration.test.ts`
- Create: `apps/paper-api/src/plugins/session-auth.ts`
- Create: `apps/paper-api/src/plugins/csrf.ts`

**Interfaces:**
- Consumes: session/account repositories, UnitOfWork, clock, random bytes, configured hash keys.
- Produces: `SessionPrincipal`, `SessionService.bootstrap()`, `authenticateSession()`, `expireInactiveSessions()`, `POST /api/v1/sessions/anonymous`, and `GET /api/v1/session`.

- [ ] **Step 1: Write token non-recovery and one-time-wallet tests**

```ts
it('stores only an HMAC hash and returns the raw token once', async () => {
  const issued = await service.bootstrap();
  const row = await readSession(db, issued.session.id);
  expect(issued.token).toHaveLength(43);
  expect(row.tokenHash).not.toContain(issued.token);
  expect(await readWallets(db, issued.session.id)).toMatchObject([
    { currency: 'KRW', total: '10000000', available: '10000000', reserved: '0' },
    { currency: 'USD', total: '0', available: '0', reserved: '0' },
  ]);
});
```

- [ ] **Step 2: Run session tests and verify failure**

Run: `pnpm --filter @skipjack/paper-api test -- session-token.test.ts session-service.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement token issuance and transactional bootstrap**

Use `randomBytes(32).toString('base64url')`; store `HMAC-SHA-256(activeKey, token)`, and authenticate against all configured rotation keys in constant time. Bootstrap session and both wallets in one transaction; when a valid cookie already exists, bootstrap returns that session and a fresh CSRF token without creating wallets again. Set cookie path `/`, max-age 30 days, and the approved security attributes. Refresh `lastActivityAt` and cookie expiry at most once per hour for authenticated activity to avoid write amplification. Return a separate non-HttpOnly CSRF token bound to the session and require `X-CSRF-Token` plus exact Origin on writes.

On 30 inactive days, one cleanup transaction acquires account gates, creates an expiry incident, cancels active legs, releases reservations, marks session expired, and emits audit/outbox. Delete identifying rows 30 days later while retaining pseudonymous audit partitions up to 90 days.

- [ ] **Step 4: Run cookie, rotation, CSRF, concurrency, and expiry tests**

Run: `pnpm --filter @skipjack/paper-api test -- session-token.test.ts session-service.integration.test.ts session-routes.test.ts session-cleanup.integration.test.ts`

Expected: PASS: concurrent bootstrap cannot initialize one token twice; old hash key authenticates during rotation; invalid Origin and CSRF return 403; expiry leaves no reservation.

- [ ] **Step 5: Commit sessions**

```bash
git add apps/paper-api/src/modules/session apps/paper-api/src/plugins
git commit -m "feat(api): add secure anonymous sessions"
```

---

### Task 3: Expose instruments, market status, and virtual FX

**Files:**
- Create: `apps/paper-api/src/modules/instruments/instrument-service.ts`
- Create: `apps/paper-api/src/modules/instruments/instrument-routes.ts`
- Create: `apps/paper-api/src/modules/instruments/instrument-routes.test.ts`
- Create: `apps/paper-api/src/modules/instruments/whitelist-service.ts`
- Create: `apps/paper-api/src/modules/instruments/whitelist-service.integration.test.ts`
- Create: `apps/paper-api/src/modules/instruments/market-calendar-service.ts`
- Create: `apps/paper-api/src/modules/instruments/market-calendar-service.integration.test.ts`
- Create: `config/mvp-whitelist.v1.json`
- Create: `config/mvp-whitelist.v1.provenance.json`
- Create: `apps/paper-api/src/modules/fx/fx-service.ts`
- Create: `apps/paper-api/src/modules/fx/fx-service.integration.test.ts`
- Create: `apps/paper-api/src/modules/fx/fx-routes.ts`
- Create: `apps/paper-api/src/modules/fx/fx-schemas.ts`

**Interfaces:**
- Consumes: Toss REST instrument/rate ports, whitelist version, market health, UnitOfWork.
- Produces: `GET /api/v1/instruments`, `GET /api/v1/instruments/:market/:symbol`, `GET /api/v1/markets/:market/symbols/:symbol/quote`, `POST /api/v1/fx/quotes`, `POST /api/v1/fx/conversions`, `WhitelistService`, `MarketCalendarService`, `FxQuote`, and `ExchangeReceipt`.

- [ ] **Step 1: Write whitelist and quote-expiry tests**

```ts
it('searches all instruments but marks only the fixed universe tradable', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/instruments?q=apple' });
  expect(response.json().items).toContainEqual(expect.objectContaining({ symbol: 'AAPL', tradable: true }));
  expect(response.json().items).toContainEqual(expect.objectContaining({ symbol: 'AAPL.UNLISTED', tradable: false }));
});

it('rejects an exchange quote after ten seconds', async () => {
  const quote = await fx.quote(sessionId, { from: 'KRW', to: 'USD', amount: '100000' });
  clock.advanceBy(10_001);
  await expect(fx.exchange(sessionId, quote.id, key)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
});
```

- [ ] **Step 2: Run and verify missing instrument/FX services**

Run: `pnpm --filter @skipjack/paper-api test -- instrument-routes.test.ts fx-service.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement cached search and zero-fee quote exchange**

```ts
export interface FxQuote {
  readonly id: string;
  readonly sessionId: string;
  readonly from: Currency;
  readonly to: Currency;
  readonly sourceAmount: DecimalString;
  readonly rate: DecimalString;
  readonly fee: '0';
  readonly targetAmount: DecimalString;
  readonly expiresAt: string;
}
```

Quote with server time, zero fee, and exact decimal strings; exchange locks both wallets in currency sort order, validates ownership/expiry, moves balances atomically, writes idempotency/audit/outbox, and consumes a quote once. REST failure returns a retryable stable error without storing the idempotency key. Cache Toss market calendars in PostgreSQL and refresh them through the REST port.

Pin this exact initial universe in `mvp-whitelist.v1.json`:

```json
{
  "KR": ["005930", "000660", "373220", "207940", "005380", "000270", "068270", "105560", "055550", "035420", "035720", "012330", "005490", "028260", "006400", "051910", "066570", "003670", "096770", "034730", "003550", "017670", "030200", "032830", "086790", "316140", "024110", "009150", "010130", "011200", "018260", "090430", "010950", "267250", "329180", "042660", "047810", "012450", "009540", "034020"],
  "US": ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "JPM", "LLY", "V", "XOM", "UNH", "MA", "COST", "HD", "PG", "JNJ", "ABBV", "BAC", "KO", "NFLX", "CRM", "ORCL", "AMD", "CSCO", "ADBE", "WMT", "CVX", "MRK", "PEP", "TMO", "MCD", "ACN", "QCOM", "TXN", "AMAT", "LIN", "DIS", "IBM"]
}
```

Validate all 80 identifiers against one dated Toss catalog snapshot during implementation and record retrieval time, source response hash, normalized provider identifiers, and validation result in the provenance file. Do not silently substitute a rejected identifier. Commit the fixed list and sanitized provenance so CI never calls live Toss. Publish the versioned rows atomically; removal first activates symbol `CANCEL_ONLY`, then refuses publication until every active leg is gone.

- [ ] **Step 4: Run route, decimal, replay, and concurrent-exchange tests**

Run: `pnpm --filter @skipjack/paper-api test -- instrument-routes.test.ts whitelist-service.integration.test.ts market-calendar-service.integration.test.ts fx-service.integration.test.ts`

Expected: PASS with no cross-currency mutation and exact original response replay.

- [ ] **Step 5: Commit market lookup and FX**

```bash
git add apps/paper-api/src/modules/instruments apps/paper-api/src/modules/fx config/mvp-whitelist.v1.json config/mvp-whitelist.v1.provenance.json
git commit -m "feat(api): add instruments and virtual FX"
```

---

### Task 4: Implement order commands and HTTP idempotency

**Files:**
- Create: `apps/paper-api/src/modules/orders/order-schemas.ts`
- Create: `apps/paper-api/src/modules/orders/order-service.ts`
- Create: `apps/paper-api/src/modules/orders/order-routes.ts`
- Create: `apps/paper-api/src/modules/orders/order-routes.integration.test.ts`
- Create: `apps/paper-api/src/modules/orders/idempotency-service.ts`
- Create: `apps/paper-api/src/modules/orders/canonical-request.ts`
- Create: `apps/paper-api/src/modules/orders/canonical-request.test.ts`

**Interfaces:**
- Consumes: PaperEngine, repositories, SafetyGate, session principal, market calendar/health.
- Produces: `POST /api/v1/orders`, `PATCH /api/v1/orders/:id`, `DELETE /api/v1/orders/:id`, `OrderService.place/amend/cancel`, canonical SHA-256 request hashes, and stored HTTP response replay.

- [ ] **Step 1: Write route-level replay and capability tests**

```ts
it('replays byte-equivalent status and body for the same key and payload', async () => {
  const first = await placeOrder(app, cookie, csrf, 'key-1', marketBuyBody);
  const second = await placeOrder(app, cookie, csrf, 'key-1', marketBuyBody);
  expect(second.statusCode).toBe(first.statusCode);
  expect(second.body).toBe(first.body);
  expect(await countOrders(db, sessionId)).toBe(1);
});

it('allows cancel but rejects place while CANCEL_ONLY', async () => {
  await activateMarketCancelOnly(db, 'US');
  expect((await placeOrder(app, cookie, csrf, 'key-2', marketBuyBody)).statusCode).toBe(409);
  expect((await cancelOrder(app, cookie, csrf, 'key-3', openOrderId)).statusCode).toBe(200);
});
```

- [ ] **Step 2: Run order route tests and verify failure**

Run: `pnpm --filter @skipjack/paper-api test -- order-routes.integration.test.ts canonical-request.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement discriminated schemas and one-command transactions**

Canonicalize JSON by schema field order, normalize decimal strings, and hash UTF-8 bytes. Validate session, whitelist, regular session rules, order-specific price fields, active-leg count, market freshness, capabilities, reservations, and price protection before engine execution. Market orders outside regular hours return `MARKET_CLOSED`; GTC limit/conditional orders reserve and wait.

```ts
export interface StoredHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
```

Persist deterministic success/rejection with the command transaction; do not persist `429`, `503`, or failure before DB admission. Same key/different hash returns 409.

- [ ] **Step 4: Run validation, replay, race, market-session, and OCO route tests**

Run: `pnpm --filter @skipjack/paper-api test -- order-routes.integration.test.ts canonical-request.test.ts`

Expected: PASS, including same-key concurrent requests and active-leg counting where one OCO consumes two legs.

- [ ] **Step 5: Commit order API**

```bash
git add apps/paper-api/src/modules/orders
git commit -m "feat(api): expose idempotent order commands"
```

---

### Task 5: Implement portfolio and order snapshots

**Files:**
- Create: `apps/paper-api/src/modules/portfolio/portfolio-service.ts`
- Create: `apps/paper-api/src/modules/portfolio/portfolio-routes.ts`
- Create: `apps/paper-api/src/modules/portfolio/portfolio-routes.integration.test.ts`
- Create: `apps/paper-api/src/modules/portfolio/portfolio-schemas.ts`

**Interfaces:**
- Consumes: ledger read repositories and current market-state read model.
- Produces: `GET /api/v1/portfolio`, `GET /api/v1/orders`, `GET /api/v1/orders/:id`, and `PortfolioSnapshot` with decimal-string `accountSequence`.

- [ ] **Step 1: Write an authoritative snapshot test**

```ts
it('returns wallets, positions, reservations, active orders, and latest durable sequence together', async () => {
  const response = await authenticatedGet(app, cookie, '/api/v1/portfolio');
  expect(response.json()).toMatchObject({
    wallets: [{ currency: 'KRW', total: '10000000', available: expect.any(String), reserved: expect.any(String) }],
    positions: expect.any(Array),
    activeOrders: expect.any(Array),
    accountSequence: expect.any(String),
  });
});
```

- [ ] **Step 2: Run and verify routes are missing**

Run: `pnpm --filter @skipjack/paper-api test -- portfolio-routes.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement one repeatable-read snapshot query**

Use one read-only repeatable-read transaction so wallets, positions, reservations, orders, and latest outbox sequence refer to the same committed view. Return decimal strings, explicit market health, `recoveryFill`, and stable pagination cursor for historical orders.

- [ ] **Step 4: Run consistency and authorization tests**

Run: `pnpm --filter @skipjack/paper-api test -- portfolio-routes.integration.test.ts`

Expected: PASS when a fill commits concurrently; response is entirely before or after the fill, never mixed.

- [ ] **Step 5: Commit snapshots**

```bash
git add apps/paper-api/src/modules/portfolio
git commit -m "feat(api): expose portfolio snapshots"
```

---

### Task 6: Implement user and quote WebSocket streams

**Files:**
- Create: `apps/paper-api/src/modules/stream/stream-routes.ts`
- Create: `apps/paper-api/src/modules/stream/stream-session.ts`
- Create: `apps/paper-api/src/modules/stream/outbox-publisher.ts`
- Create: `apps/paper-api/src/modules/stream/outbox-publisher.integration.test.ts`
- Create: `apps/paper-api/src/modules/stream/stream-routes.test.ts`

**Interfaces:**
- Consumes: authenticated session, outbox repository, market state store, optional Redis fan-out.
- Produces: `GET /api/v1/stream` WebSocket, `AccountStreamEvent`, `QuoteStreamEvent`, and `OutboxPublisher.pollOnce()`.

- [ ] **Step 1: Write at-least-once and gap tests**

```ts
it('replays committed account events and permits eventId deduplication', async () => {
  await publishOrderAndFill(db, sessionId);
  const first = await collectAccountEvents(connectStream(app, cookie), 2);
  await restartPublisher();
  const replay = await collectAccountEvents(connectStream(app, cookie), 2);
  expect(new Set([...first, ...replay].map(event => event.eventId)).size).toBe(2);
});
```

- [ ] **Step 2: Run and verify stream modules are missing**

Run: `pnpm --filter @skipjack/paper-api test -- stream-routes.test.ts outbox-publisher.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement durable account events and ephemeral quotes**

Account events allocate the next per-account sequence in the same transaction and carry persisted decimal-string `accountSequence` plus globally unique `eventId`; publisher uses `FOR UPDATE SKIP LOCKED`, marks delivery attempts, and tolerates duplicate delivery. Retain delivered outbox events for 24 hours, then delete them in bounded batches only after durable account state exists. Quote events carry `recoveryEpoch` and `marketDataVersion` but are not written to outbox. On connect, accept `afterSequence`; if retention cannot satisfy it, send `{ type: 'resync-required', reason: 'OUTBOX_GAP' }` and close with an application code. A bounded slow-client queue sends the same message with reason `BACKPRESSURE` before closing when possible.

```ts
export type ServerStreamMessage =
  | { type: 'ready'; accountSequence: string; heartbeatIntervalMs: number }
  | { type: 'event'; eventId: string; accountSequence: string; payload: PortfolioEvent }
  | { type: 'quote'; market: Market; symbol: string; recoveryEpoch: string; marketDataVersion: string; payload: QuoteSnapshot }
  | { type: 'resync-required'; reason: 'BACKPRESSURE' | 'OUTBOX_GAP' }
  | { type: 'heartbeat'; serverTime: string };

export type ClientStreamMessage =
  | { type: 'subscribe-quote'; market: Market; symbol: string }
  | { type: 'unsubscribe-quote'; market: Market; symbol: string };
```

Validate the WebSocket handshake Origin and session cookie before upgrade. Allow at most five simultaneous quote subscriptions per session, accept only current whitelist symbols, and remove every subscription when the socket closes. Search-only non-tradable symbols use REST detail and never allocate a real-time topic.

- [ ] **Step 4: Run reconnect, slow-client, and authorization tests**

Run: `pnpm --filter @skipjack/paper-api test -- stream-routes.test.ts outbox-publisher.integration.test.ts`

Expected: PASS; slow clients are disconnected without blocking the outbox poller, and one session cannot subscribe to another session.

- [ ] **Step 5: Commit streams**

```bash
git add apps/paper-api/src/modules/stream
git commit -m "feat(api): stream durable portfolio events"
```

---

### Task 7: Add health, metrics, rate limits, and admin control plane

**Files:**
- Create: `apps/paper-api/src/modules/health/health-routes.ts`
- Create: `apps/paper-api/src/modules/health/health-routes.test.ts`
- Create: `apps/paper-api/src/modules/admin/admin-app.ts`
- Create: `apps/paper-api/src/modules/admin/admin-routes.ts`
- Create: `apps/paper-api/src/modules/admin/admin-routes.integration.test.ts`
- Create: `apps/paper-api/src/observability/metrics.ts`
- Create: `apps/paper-api/src/observability/metrics.test.ts`
- Create: `apps/paper-api/src/observability/logger.ts`
- Create: `apps/paper-api/src/observability/logger.test.ts`
- Create: `apps/paper-api/src/plugins/rate-limits.ts`
- Create: `apps/paper-api/src/plugins/rate-limits.test.ts`

**Interfaces:**
- Consumes: health machine, incidents, emergency latch, DB/Redis probes, config.
- Produces: `/health/live`, `/health/ready`, `/health/market-data`, `/metrics`, authenticated `GET /api/v1/health/trading`, private admin listener, `activateIncident`, `resolveIncidentCas`, `publishWhitelistVersion`, `cancelAll`, and layered limiters.

- [ ] **Step 1: Write readiness separation and Redis-failure tests**

```ts
it('keeps readiness true while market data is degraded', async () => {
  fakeHealth.setMarket('US', 'DEGRADED');
  expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/health/market-data' })).json()).toMatchObject({ US: { state: 'DEGRADED' } });
});

it('blocks place but allows locally limited cancel when Redis is down', async () => {
  redis.fail();
  expect((await placeOrder(app, cookie, csrf, 'r1', body)).statusCode).toBe(503);
  expect((await cancelOrder(app, cookie, csrf, 'r2', orderId)).statusCode).toBe(200);
});
```

- [ ] **Step 2: Run and verify modules are missing**

Run: `pnpm --filter @skipjack/paper-api test -- health-routes.test.ts admin-routes.integration.test.ts rate-limits.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement bounded metrics and a separate admin listener**

Implement every metric named in spec section 11.3 with those exact bounded labels, plus `transactional_audit_failure_total`, `transaction_error_total{tx_type}`, and `outbox_oldest_pending_seconds`; never label session/order/symbol/idempotency values. `GET /api/v1/health/trading` returns effective placement/cancellation/FX capabilities and reason codes for the authenticated session plus requested market/symbol. Admin app binds loopback/private host, requires short-lived credential, IP allowlist, actor, reason, idempotency key, and expected incident version. Admin release bypasses user trading gates but may not bypass audit availability. Cancel-all and whitelist publication are separate commands; whitelist removal requires the symbol incident and zero active legs.

Structured logs include `requestId`, `orderId`, `idempotencyKeyHash`, `recoveryEpoch`, `market`, `symbol`, `healthState`, and `errorCode` only when present; they never include OAuth tokens, cookie values, raw anonymous tokens, CSRF values, or actual account data. Do not log every tick. Log lifecycle transitions, errors, and fill evidence, with deployment retention fixed at 14 days.

Implement session 5/s burst 10 mutation, cancel 10/s burst 20, IP 20/s burst 40, session creation 5/min and 100/day, session 50 legs, and global 10,000-leg capacity. Persist configuration version in audit.

- [ ] **Step 4: Run health, cardinality, rate, admin-lockout, and CAS tests**

Run: `pnpm --filter @skipjack/paper-api test -- health-routes.test.ts admin-routes.integration.test.ts rate-limits.test.ts metrics.test.ts logger.test.ts`

Expected: PASS; `/metrics` contains no high-cardinality identifier and an audit outage prevents incident release.

- [ ] **Step 5: Commit operations API**

```bash
git add apps/paper-api/src/modules/health apps/paper-api/src/modules/admin apps/paper-api/src/observability apps/paper-api/src/plugins
git commit -m "feat(api): add safety operations endpoints"
```

---

### Task 8: Lock the API vertical slice

**Files:**
- Create: `apps/paper-api/src/api.acceptance.integration.test.ts`
- Create: `apps/paper-api/src/api.crash-recovery.integration.test.ts`
- Create: `docs/api/error-contract.md`

**Interfaces:**
- Consumes: all Plans 1–3 components.
- Produces: one executable API acceptance suite and stable error-code documentation.

- [ ] **Step 1: Write the full user-flow acceptance test**

```ts
it('runs session, FX, market order, partial fill, snapshot, and reconnect', async () => {
  const client = await anonymousClient(app);
  const quote = await client.createFxQuote({ from: 'KRW', to: 'USD', amount: '1000000' });
  await client.exchange(quote.id, 'fx-1');
  fakeMarket.setBook('US', 'AAPL', bookWithDepth('200', '2'));
  await client.placeOrder({ key: 'order-1', market: 'US', symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: '3' });
  const snapshot = await client.portfolio();
  expect(snapshot.positions[0].quantity).toBe('2');
  expect(snapshot.activeOrders).toEqual([]);
});
```

Add a table-driven error-catalog assertion: `VALIDATION_ERROR` is 400; `SESSION_EXPIRED` is 401; `FORBIDDEN` is 403; `NOT_FOUND` is 404; domain/capability conflicts are 409; `RATE_LIMITED` is 429; and `MARKET_DATA_DEGRADED`, `RECOVERY_IN_PROGRESS`, and `SERVICE_UNAVAILABLE` are 503. Only the 429/503 group is retryable, and retryable responses provide `retryAfter` whenever the server can estimate it. Generate `docs/api/error-contract.md` from the same catalog and fail the test on undocumented or duplicate codes.

- [ ] **Step 2: Add commit-boundary crash cases**

Inject crash points immediately before ledger commit and immediately after commit/before HTTP response. The first attempt must leave no order; the second must replay the stored response and never create a second order. Restart outbox publishing and prove terminal orders are not rearmed.

- [ ] **Step 3: Run the entire API suite**

Run: `pnpm --filter @skipjack/paper-api test -- api.acceptance.integration.test.ts api.crash-recovery.integration.test.ts`

Expected: PASS with PostgreSQL/Redis Testcontainers and fake market data.

- [ ] **Step 4: Run all repository gates**

Run: `pnpm check && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS with no live Toss calls, no leaked secrets, and no unexpected fixture changes.

- [ ] **Step 5: Commit API acceptance**

```bash
git add apps/paper-api/src/api.acceptance.integration.test.ts apps/paper-api/src/api.crash-recovery.integration.test.ts docs/api/error-contract.md
git commit -m "test: lock paper API behavior"
```

Plan 3 is complete when a headless client can perform the full paper-trading flow, recover from connection and process failures, and explain every denial through stable API and audit contracts.
