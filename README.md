# Skipjack

Skipjack is an anonymous, deterministic paper-trading application for Korean
and US equities. PostgreSQL is authoritative for sessions, wallets, orders,
fills, audit records, and the user-event outbox; the browser reconciles its
view from REST snapshots and treats WebSocket delivery as an at-least-once
acceleration layer.

This repository implements simulated trading only. It is not investment
advice, a brokerage service, or a promise that a paper result can be reproduced
in a real market.

## What the public MVP supports

- Anonymous sessions funded with KRW 10,000,000 and USD 0, plus virtual FX.
- Search across 40 Korean and 40 US allow-listed symbols.
- MARKET, LIMIT, STOP, TAKE_PROFIT, and OCO paper orders, including whole-share
  validation, deterministic fees, reservations, partial fills, and slippage.
- Visible `NORMAL`, `DEGRADED`, `RECOVERING`, and `CANCEL_ONLY` safety states.
- REST snapshot recovery after duplicate or missing user-stream events.
- PostgreSQL-backed idempotency, audit, outbox, leader fencing, health probes,
  metrics, alerts, and operational runbooks.

The approved architecture is documented in
[`docs/superpowers/specs/2026-08-21-skipjack-paper-trading-architecture-design.md`](docs/superpowers/specs/2026-08-21-skipjack-paper-trading-architecture-design.md).
Deployment topology and rollback rules are in
[`docs/operations/deployment.md`](docs/operations/deployment.md), and release
evidence is tracked in
[`docs/operations/release-checklist.md`](docs/operations/release-checklist.md).

## Local development

Install Node 24.19.0 and activate the pinned package manager:

```bash
nvm use 24
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

The browser development server uses `/api` against `http://localhost:3000`.
The Playwright harness starts disposable PostgreSQL and Redis containers and a
deterministic fake market-data feed; it never contacts Toss or a broker:

```bash
pnpm --filter @skipjack/e2e test:e2e
```

For a provider-neutral container topology, supply the required runtime secrets
described in the deployment guide and run:

```bash
docker compose -f infra/compose.yaml up --build
```

`MARKET_DATA_ADAPTER=fake` is for deterministic tests and development only.
Provider tokens, database URLs, Redis URLs, admin credentials, and session
secrets are runtime-only values and must never enter the browser bundle.

The current image does not yet compose the live provider adapter, market
leader lifecycle, and outbox publisher into `paper-api` at runtime. When the
fake adapter is not explicitly selected, the API therefore starts fail-closed
in `CANCEL_ONLY`: reads and cancellations remain available, while placement
and virtual FX are disabled. Do not enable the fake adapter for a public
deployment. The release remains blocked until the runtime integration and its
graceful leader-handoff drill are complete; see the release checklist.

## Simulation limits

- Every user independently reuses the displayed order-book depth. Liquidity is
  not depleted globally between anonymous paper accounts.
- Aggregate paper fills can therefore exceed liquidity that a real market
  displayed at the same instant.
- No exchange queue position, hidden liquidity, venue routing, or real order
  acknowledgement is modeled.
- Recovery uses the current REST price and book. It does not invent
  retroactive fills for a missing feed interval; any recovery-triggered fill is
  labeled.
- Performance observed against the deterministic feed is not a prediction of
  execution quality, latency, fees, tax, or profit in a live account.

## Real-account boundary

This public repository contains no real-account credentials, real-broker order
route, or real-order execution implementation. Any private real-bot repository
is a separate project and trust boundary; it does not share Skipjack's browser,
admin API, anonymous-session credentials, or deployment secrets.

## License and safety

Use the software only in environments you control. Paper balances and results
have no cash value. Always verify local law, tax, market-data licensing, and
broker rules independently before building any unrelated live-trading system.
