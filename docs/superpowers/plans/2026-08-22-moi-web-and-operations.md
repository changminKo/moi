# Moi Web and Operations Implementation Plan

> **Status:** implemented and merged into `portfolio-project-ideas` (PR #1). The step checkboxes below are the original authoring artefacts and were not ticked retroactively; the spec's §16 implementation-deviation table and the release checklist are the record of what shipped and how it was verified.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the anonymous paper-trading web application, prove the complete browser-to-ledger flow with Playwright, and package the system with reproducible CI, container, deployment, and incident runbooks.

**Architecture:** The React client treats REST snapshots as authoritative and WebSocket events as an at-least-once acceleration layer. UI modules consume typed API/stream adapters, retain decimal values as strings, and centralize safety capability rendering so no screen can accidentally enable a server-disabled action. Deployment remains provider-neutral: one public web service, one single-replica `paper-api` process that also owns the fenced market-data leader, PostgreSQL, and Redis.

**Tech Stack:** The Plan 1–3 stack plus React 19.2.8, React DOM 19.2.8, Vite 8.2.2, @vitejs/plugin-react 6.1.0, React Router DOM 7.18.2, TanStack Query 5.101.4, clsx 2.1.1, Testing Library React 16.3.2, jest-dom 7.0.1, jsdom 30.0.1, and Playwright 1.62.1.

**Spec:** `docs/superpowers/specs/2026-08-21-moi-paper-trading-architecture-design.md`

## Global Constraints

- Complete the foundation/core, market-data/engine, and paper-API plans first.
- The server and PostgreSQL remain authoritative. Browser state must never invent fills, balances, capabilities, or recovery completion.
- Keep money, price, quantity-derived notional, FX, fees, and PnL as canonical decimal strings through the client. Convert only bounded chart coordinates to `number` at the rendering boundary.
- All API requests include credentials. Every mutation includes the server-issued CSRF value; every order mutation and virtual-FX conversion also includes a fresh idempotency key.
- WebSocket events are at-least-once. Deduplicate by `eventId`; any account-sequence gap triggers one coalesced REST snapshot refresh.
- `DEGRADED`, `RECOVERING`, `CANCEL_ONLY`, and `recoveryFill` are visible states, not generic failures. Disabled UI controls mirror server capabilities but never replace server enforcement.
- Never expose Toss credentials, admin controls, Redis endpoints, database endpoints, or real-account order paths to the browser bundle.
- The default UI must be keyboard usable, responsive at 360 px, and meet WCAG AA color contrast for text and controls.
- Tests are written first. Every task ends with targeted tests, workspace checks, and one focused commit.
- `.codegraph/`, `.cursor/`, and `.omc/` remain untracked.

## Plan Dependency

This is plan 4 of 4. Start only after these plans pass their acceptance tasks:

1. `2026-08-22-moi-foundation-and-trading-core.md`
2. `2026-08-22-moi-market-data-and-paper-engine.md`
3. `2026-08-22-moi-paper-api.md`

---

### Task 1: Scaffold the React application and accessibility baseline

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/public/runtime-config.js`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/globals.css`
- Create: `apps/web/src/test/setup.ts`
- Test: `apps/web/src/app.test.tsx`

- [ ] **Step 1: Add the pinned package manifest and test configuration**

Create `apps/web/package.json` with the exact versions from this plan and these scripts:

```json
{
  "name": "@moi/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty false"
  },
  "dependencies": {
    "@tanstack/react-query": "5.101.4",
    "clsx": "2.1.1",
    "decimal.js": "10.6.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-router-dom": "7.18.2"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.2",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.1.0",
    "jsdom": "30.0.1",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11"
  }
}
```

Configure `vite.config.ts` with the React plugin, `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']`, and one `/api` development proxy to `http://localhost:3000` with WebSocket upgrade enabled and no path rewrite. Import `@testing-library/jest-dom/vitest` in the setup file.

- [ ] **Step 2: Write the failing application-shell test**

```tsx
// apps/web/src/app.test.tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "./app";

describe("App", () => {
  it("renders the primary navigation and one main landmark", () => {
    render(<App />, { wrapper: MemoryRouter });

    expect(screen.getByRole("navigation", { name: "주요 메뉴" })).toBeVisible();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "거래" })).toHaveAttribute("href", "/trade");
    expect(screen.getByRole("link", { name: "포트폴리오" })).toHaveAttribute("href", "/portfolio");
  });
});
```

- [ ] **Step 3: Run the test and verify that it fails**

Run: `pnpm --filter @moi/web test -- src/app.test.tsx`

Expected: FAIL because `App` does not exist.

- [ ] **Step 4: Implement the shell, routes, and design tokens**

Export `App` with `/trade`, `/portfolio`, and a redirect from `/` to `/trade`. Load `/runtime-config.js` before the Vite module in `index.html`; the development file uses `window.location.origin` so Vite's `/api` proxy handles REST and WebSocket traffic, while the production server overrides that route at runtime. Use semantic `header`, labeled `nav`, and a single `main`. Define tokens for surface, text, positive, negative, warning, focus, spacing, and type scale in `tokens.css`; add visible `:focus-visible`, reduced-motion, and 360 px layout rules in `globals.css`.

```tsx
export function App() {
  return (
    <div className="app-shell">
      <header>
        <a className="brand" href="/trade">Moi</a>
        <nav aria-label="주요 메뉴">
          <NavLink to="/trade">거래</NavLink>
          <NavLink to="/portfolio">포트폴리오</NavLink>
        </nav>
      </header>
      <main id="main-content">
        <Routes>
          <Route path="/trade" element={<TradePlaceholder />} />
          <Route path="/portfolio" element={<PortfolioPlaceholder />} />
          <Route path="*" element={<Navigate replace to="/trade" />} />
        </Routes>
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @moi/web test -- src/app.test.tsx
pnpm --filter @moi/web build
pnpm check
```

Expected: all commands pass and `apps/web/dist/index.html` is generated.

Commit: `feat(web): scaffold accessible trading shell`

---

### Task 2: Bootstrap anonymous sessions and a typed REST client

**Files:**

- Create: `apps/web/src/lib/api-types.ts`
- Create: `apps/web/src/lib/runtime-config.ts`
- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/idempotency.ts`
- Create: `apps/web/src/lib/query-client.ts`
- Create: `apps/web/src/features/session/session-provider.tsx`
- Test: `apps/web/src/lib/api-client.test.ts`
- Test: `apps/web/src/features/session/session-provider.test.tsx`

- [ ] **Step 1: Write failing API-client tests**

Cover all of these behaviors with a mocked `fetch`:

1. `credentials: "include"` is always present.
2. A write copies the current CSRF token into `X-CSRF-Token`.
3. A trade mutation carries its caller-provided `Idempotency-Key`.
4. Decimal JSON fields remain strings.
5. The stable error envelope becomes `ApiError` without discarding `requestId`, `retryable`, or `retryAfter`.

```ts
it("sends credentials, CSRF, and idempotency on order placement", async () => {
  await client.post("/api/v1/orders", orderBody, { idempotencyKey: "order-1" });

  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.test/api/v1/orders",
    expect.objectContaining({
      credentials: "include",
      headers: expect.objectContaining({
        "X-CSRF-Token": "csrf-token",
        "Idempotency-Key": "order-1"
      })
    })
  );
});
```

- [ ] **Step 2: Run the tests and verify that they fail**

Run: `pnpm --filter @moi/web test -- src/lib/api-client.test.ts`

Expected: FAIL because the REST client does not exist.

- [ ] **Step 3: Implement API types and the client**

Define the API boundary explicitly; do not import server-internal repository types.

```ts
export type ApiErrorBody = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  requestId: string;
}>;

export type SessionSnapshot = Readonly<{
  sessionId: string;
  expiresAt: string;
  csrfToken: string;
}>;

export type CapabilitySnapshot = Readonly<{
  mode: 'NORMAL' | 'CANCEL_ONLY' | 'READ_ONLY' | 'UNAVAILABLE';
  canPlace: boolean;
  canCancel: boolean;
  reasonCodes: readonly string[];
}>;
```

`readRuntimeConfig()` accepts only an `http:` loopback URL outside production and requires `https:` in production. `createApiClient` resolves API paths against that origin, accepts `getCsrfToken`, serializes bodies as JSON, validates response shapes, and throws `ApiError` for non-2xx responses. The stream client derives `ws:`/`wss:` from the same origin. `newIdempotencyKey()` must use `crypto.randomUUID()` and never reuse a key across user gestures.

- [ ] **Step 4: Write the failing session-provider tests**

Test that the provider calls `POST /api/v1/sessions/anonymous` exactly once on first render, keeps the returned CSRF token in memory, exposes a loading state, and shows a retry action for bootstrap failure. It must not persist the token or session identifier in `localStorage` or `sessionStorage`.

- [ ] **Step 5: Implement session and query providers**

Use a single `QueryClient` whose queries retry transient reads at most twice and never automatically retry mutations. Wrap the router with `QueryClientProvider` and `SessionProvider` in `main.tsx`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @moi/web test -- src/lib/api-client.test.ts src/features/session/session-provider.test.tsx
pnpm --filter @moi/web build
```

Expected: tests pass; production output contains no `localStorage` session write and no Toss credential string.

Commit: `feat(web): bootstrap anonymous trading sessions`

---

### Task 3: Reconcile at-least-once user-stream events with authoritative snapshots

**Files:**

- Create: `apps/web/src/lib/user-stream.ts`
- Create: `apps/web/src/features/portfolio/portfolio-model.ts`
- Create: `apps/web/src/features/portfolio/portfolio-store.tsx`
- Create: `apps/web/src/features/portfolio/use-portfolio-stream.ts`
- Test: `apps/web/src/lib/user-stream.test.ts`
- Test: `apps/web/src/features/portfolio/portfolio-store.test.tsx`

- [ ] **Step 1: Write failing pure reconciliation tests**

The reducer tests must prove:

- an event with a previously seen `eventId` is ignored;
- sequence `'42'` followed by `'44'` marks the store stale and requests one refresh;
- later events are ignored while stale;
- applying a REST snapshot at sequence `'46'` clears stale state and resets the deduplication window;
- `recoveryFill: true` survives reconciliation and is visible on the fill view model.

```ts
it("coalesces an account-sequence gap into one snapshot request", () => {
  const afterGap = reducePortfolio(atSequence('42'), event({ eventId: 'e44', accountSequence: '44' }));
  const afterAnotherEvent = reducePortfolio(afterGap, event({ eventId: 'e45', accountSequence: '45' }));

  expect(afterGap.sync).toEqual({ status: "STALE", refreshRequested: true });
  expect(afterAnotherEvent.sync).toEqual({ status: "STALE", refreshRequested: true });
});
```

- [ ] **Step 2: Run the tests and verify that they fail**

Run: `pnpm --filter @moi/web test -- src/features/portfolio/portfolio-store.test.tsx`

Expected: FAIL because the store and reducer do not exist.

- [ ] **Step 3: Implement the stream protocol and reducer**

Use a discriminated union with explicit protocol messages:

```ts
export type UserStreamMessage =
  | { type: 'ready'; accountSequence: string; heartbeatIntervalMs: number }
  | { type: 'event'; eventId: string; accountSequence: string; payload: PortfolioEvent }
  | { type: 'quote'; market: Market; symbol: string; recoveryEpoch: string; marketDataVersion: string; payload: QuoteSnapshot }
  | { type: 'resync-required'; reason: 'BACKPRESSURE' | 'OUTBOX_GAP' }
  | { type: 'heartbeat'; serverTime: string };
```

Keep a bounded LRU set of 2,048 event IDs. Parse sequence strings with `BigInt` only for adjacency comparison and keep the API value as a string in state. The reducer accepts immutable snapshots and events; it must not perform fetches itself.

- [ ] **Step 4: Write failing stream lifecycle tests**

With a fake WebSocket, verify exponential reconnect with jitter capped at 15 seconds, heartbeat timeout at the server-advertised interval, clean close on unmount, and a `resync-required` message causing one `GET /api/v1/portfolio` refresh.

- [ ] **Step 5: Implement the stream hook**

`usePortfolioStream` owns the connection lifecycle. A REST snapshot query supplies truth; stream events dispatch into the reducer. Coalesce refreshes through one TanStack Query key, `['portfolio']`, so reconnect, sequence gap, and `resync-required` cannot create parallel snapshot requests.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @moi/web test -- src/lib/user-stream.test.ts src/features/portfolio/portfolio-store.test.tsx
pnpm --filter @moi/web build
```

Expected: all tests pass, including duplicate delivery and sequence-gap cases.

Commit: `feat(web): reconcile portfolio user stream`

---

### Task 4: Build market selection, wallet summary, virtual FX, and quotes

**Files:**

- Create: `apps/web/src/features/instruments/instrument-search.tsx`
- Create: `apps/web/src/features/instruments/use-instruments.ts`
- Create: `apps/web/src/features/market/quote-panel.tsx`
- Create: `apps/web/src/features/market/order-book.tsx`
- Create: `apps/web/src/features/market/use-quote-stream.ts`
- Create: `apps/web/src/features/wallet/wallet-summary.tsx`
- Create: `apps/web/src/features/wallet/fx-ticket.tsx`
- Create: `apps/web/src/pages/trade-page.tsx`
- Test: `apps/web/src/pages/trade-page.test.tsx`
- Test: `apps/web/src/features/wallet/fx-ticket.test.tsx`

- [ ] **Step 1: Write failing trade-page tests**

Mock only the typed API/stream adapters. Verify that:

- search returns all symbols but clearly marks non-tradable instruments;
- selecting a tradable KR or US symbol shows its current price, timestamp, health, and book depth;
- selecting a non-tradable symbol disables the order ticket with `SYMBOL_NOT_TRADABLE`;
- KRW and USD wallet cards show available, reserved, and total separately;
- no rendered amount is derived through floating-point arithmetic.

- [ ] **Step 2: Run the page tests and verify that they fail**

Run: `pnpm --filter @moi/web test -- src/pages/trade-page.test.tsx`

Expected: FAIL because the trade page components do not exist.

- [ ] **Step 3: Implement search and market panels**

Search with `GET /api/v1/instruments?q=apple`, debounce input by 150 ms, and retain the selected symbol in the URL query string. Seed the panel from `GET /api/v1/markets/:market/symbols/:symbol/quote`, then subscribe through the shared stream only when the symbol is tradable and accept only events whose recovery epoch and market-data version are not older than the current view. Unsubscribe the previous symbol on selection change. Search-only non-tradable symbols remain REST-only. Render book levels with the original canonical decimal strings; calculate only each depth bar's percentage as a bounded display `number`.

```ts
export function depthPercent(size: string, maxSize: string): number {
  if (maxSize === "0") return 0;
  return Decimal.min(new Decimal(size).div(maxSize).mul(100), 100).toNumber();
}
```

Show explicit `DEGRADED` and `RECOVERING` badges next to quote timestamps. Do not display a stale quote as live.

- [ ] **Step 4: Write failing virtual-FX tests**

Test both directions, positive input validation, an expired quote, insufficient available balance, double-click submission, and a successful response that refreshes wallet and portfolio queries. The preview must display rate, fee, source amount, and destination amount as server-provided strings.

- [ ] **Step 5: Implement virtual FX**

The form requests a quote first and sends `quoteId` plus a fresh idempotency key to `POST /api/v1/fx/conversions`. Disable submit while pending. On `QUOTE_EXPIRED`, keep the input, obtain a new quote only after explicit user action, and never silently accept a changed rate.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @moi/web test -- src/pages/trade-page.test.tsx src/features/wallet/fx-ticket.test.tsx
pnpm --filter @moi/web build
```

Expected: all tests pass and all displayed wallet arithmetic uses Decimal.js or server-computed strings.

Commit: `feat(web): add instruments quotes wallets and fx`

---

### Task 5: Implement the order ticket, open orders, fills, and portfolio views

**Files:**

- Create: `apps/web/src/features/orders/order-form.ts`
- Create: `apps/web/src/features/orders/order-ticket.tsx`
- Create: `apps/web/src/features/orders/open-orders.tsx`
- Create: `apps/web/src/features/orders/order-edit-dialog.tsx`
- Create: `apps/web/src/features/orders/fill-history.tsx`
- Create: `apps/web/src/features/orders/use-order-mutations.ts`
- Create: `apps/web/src/features/portfolio/positions-table.tsx`
- Create: `apps/web/src/pages/portfolio-page.tsx`
- Test: `apps/web/src/features/orders/order-form.test.ts`
- Test: `apps/web/src/features/orders/order-ticket.test.tsx`
- Test: `apps/web/src/features/orders/order-edit-dialog.test.tsx`
- Test: `apps/web/src/pages/portfolio-page.test.tsx`

- [ ] **Step 1: Write failing pure order-form tests**

Define a discriminated form model and test its exact server request mapping:

```ts
export type OrderDraft =
  | { kind: "MARKET"; side: Side; quantity: string }
  | { kind: "LIMIT"; side: Side; quantity: string; limitPrice: string }
  | { kind: "STOP"; side: Side; quantity: string; stopPrice: string }
  | { kind: "TAKE_PROFIT"; side: Side; quantity: string; triggerPrice: string }
  | {
      kind: "OCO";
      side: Side;
      quantity: string;
      takeProfitPrice: string;
      stopPrice: string;
    };
```

Reject zero, negative, exponent notation, fractional shares, missing conditional prices, and identical OCO trigger prices before submit. Do not duplicate balance or market-health acceptance rules in the form.

- [ ] **Step 2: Run the form tests and verify that they fail**

Run: `pnpm --filter @moi/web test -- src/features/orders/order-form.test.ts`

Expected: FAIL because order-form mapping does not exist.

- [ ] **Step 3: Implement the form model and accessible ticket**

Use a real `form`, fieldsets for side/type, associated labels, inline errors with `aria-describedby`, and one submit button. Render server capability reasons above the button. Send exactly one order request with a fresh idempotency key per explicit submit gesture.

- [ ] **Step 4: Write failing lifecycle-view tests**

Test that:

- partial fills show filled and remaining quantities;
- open orders can be cancelled during `CANCEL_ONLY`;
- placement is disabled during `CANCEL_ONLY`;
- a repeated cancel click is harmless and reuses the in-flight mutation only;
- terminal orders cannot expose cancel controls;
- eligible GTC orders expose quantity/price amendment with a fresh idempotency key, while `CANCEL_ONLY` hides amendment but keeps cancellation;
- OCO siblings and the winning leg are linked visibly;
- `recoveryFill` is labeled on fill history;
- available and reserved position quantities are separate.

- [ ] **Step 5: Implement order and portfolio views**

Use the reconciled portfolio store from Task 3. On successful placement, amendment, or cancellation, merge the returned authoritative command result and invalidate `['portfolio']`. Same-key/same-payload replay arrives as the original 2xx response and is rendered normally; `409 IDEMPOTENCY_CONFLICT` remains an error. Show every stable rejection with its code and request ID instead of replacing it with a generic toast.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @moi/web test -- src/features/orders src/pages/portfolio-page.test.tsx
pnpm --filter @moi/web build
```

Expected: all order types, amendment, partial fills, OCO, cancellation, and recovery-fill views pass.

Commit: `feat(web): add paper order and portfolio workflows`

---

### Task 6: Make health, incident, and capability states explicit and accessible

**Files:**

- Create: `apps/web/src/features/system/system-status-provider.tsx`
- Create: `apps/web/src/features/system/system-banner.tsx`
- Create: `apps/web/src/features/system/error-notice.tsx`
- Create: `apps/web/src/features/system/capability-guard.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/features/orders/order-ticket.tsx`
- Modify: `apps/web/src/features/orders/open-orders.tsx`
- Modify: `apps/web/src/features/wallet/fx-ticket.tsx`
- Test: `apps/web/src/features/system/system-status-provider.test.tsx`
- Test: `apps/web/src/features/system/capability-guard.test.tsx`

- [ ] **Step 1: Write the failing capability-matrix tests**

Turn the approved capability matrix into parameterized UI tests. At minimum cover:

| State | Place | Cancel | FX | Required message |
|---|---:|---:|---:|---|
| Healthy/normal | enabled | enabled | enabled | none |
| Market degraded | disabled for affected market | enabled | enabled | market data delayed |
| Recovering | disabled for affected market | enabled | enabled | recovery in progress |
| Global cancel-only | disabled | enabled | disabled | safety mode |
| Account read-only | disabled | disabled | disabled | account safety lock |
| Unavailable | disabled | disabled | disabled | service unavailable |
| Session expired | disabled | disabled | disabled | start new session |

Also prove that a front-end capability bug cannot turn a server rejection into success.

- [ ] **Step 2: Run the tests and verify that they fail**

Run: `pnpm --filter @moi/web test -- src/features/system`

Expected: FAIL because status provider and guards do not exist.

- [ ] **Step 3: Implement status composition**

Compose `/api/v1/health/trading` with session and selected-market data into one view model. Preserve all server `reasonCodes`; choose presentation text through an exhaustive mapping that throws in tests for an unknown reason.

```ts
export type TradingAvailability = Readonly<{
  place: { enabled: boolean; reasons: readonly string[] };
  cancel: { enabled: boolean; reasons: readonly string[] };
  fx: { enabled: boolean; reasons: readonly string[] };
}>;
```

Use `role="status"` for passive transitions and `role="alert"` only when a just-attempted action failed. Never use color as the sole state indicator.

- [ ] **Step 4: Test accessibility and responsive behavior**

Add keyboard tests for navigation, search, order-type selection, submit, cancel, retry, and dismissible notices. Render key pages at a 360 px viewport in component tests and assert no control is removed; tables may become labeled cards.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @moi/web test
pnpm --filter @moi/web build
```

Expected: all web tests pass, capability states are exhaustively covered, and the production bundle succeeds.

Commit: `feat(web): surface trading safety capabilities`

---

### Task 7: Prove critical journeys with deterministic Playwright E2E tests

**Files:**

- Create: `apps/e2e/package.json`
- Create: `apps/e2e/tsconfig.json`
- Create: `apps/e2e/playwright.config.ts`
- Create: `apps/e2e/start-system.ts`
- Create: `apps/e2e/fixtures/paper-system.ts`
- Create: `apps/e2e/specs/anonymous-session.spec.ts`
- Create: `apps/e2e/specs/order-lifecycle.spec.ts`
- Create: `apps/e2e/specs/recovery-and-safety.spec.ts`
- Create: `apps/e2e/specs/responsive-accessibility.spec.ts`

- [ ] **Step 1: Add the E2E package and failing smoke test**

Create `@moi/e2e` with `"test:e2e": "playwright test"`, `@playwright/test` 1.62.1, `@types/node` 24.13.3, `testcontainers` 12.1.0, `tsx` 4.23.12, and TypeScript 7.0.2. Configure Chromium, trace-on-first-retry, screenshots on failure, and a 360 × 800 mobile project. Configure one Playwright `webServer` command, `tsx start-system.ts`; the orchestrator starts disposable dependencies, the API with the deterministic fake market-data adapter from Plan 2, and the built web server, then becomes ready only after `/health/ready` succeeds. Do not define a `test` script in this package: the root unit/integration gate and the explicit E2E gate must remain separate.

```ts
test("creates one anonymous wallet and reloads it", async ({ page }) => {
  await page.goto("/trade");
  await expect(page.getByText("₩10,000,000")).toBeVisible();
  await page.reload();
  await expect(page.getByText("₩10,000,000")).toBeVisible();
});
```

- [ ] **Step 2: Run the smoke test and verify that it fails**

Run: `pnpm --filter @moi/e2e test:e2e -- specs/anonymous-session.spec.ts`

Expected: FAIL until the E2E fixture starts PostgreSQL, Redis, API, and web dependencies with isolated test state.

- [ ] **Step 3: Implement deterministic system fixtures**

Use Testcontainers for PostgreSQL and Redis with dynamic host ports. `start-system.ts` first verifies fixed loopback test ports 3100 (API), 4173 (web), and 3101 (private controls) are free, runs migrations once, starts `paper-api` with `NODE_ENV=test`, `MARKET_DATA_ADAPTER=fake`, and a random loopback-only admin credential, and starts web with `PUBLIC_API_ORIGIN=http://127.0.0.1:3100`. It writes the generated control credential to a mode-0600 process-owned temporary state file and tears down the file, child processes, and containers on SIGTERM or exit. Fake-feed controls bind only to 127.0.0.1:3101 and require that credential. The `paper-system` fixture reads the state, invokes controls from the Node test process, and creates a fresh session per test; no test shares an account or idempotency key.

- [ ] **Step 4: Add critical lifecycle scenarios**

Implement these browser-level tests:

1. Create anonymous session, verify initial wallets, convert KRW to USD, reload, and retain the same totals.
2. Place a KR market order, inject partial book depth, observe partial then complete fill, and reconcile the portfolio.
3. Place a US limit order, receive duplicate user-stream delivery, and display one fill only.
4. Place an OCO sell, trigger one leg, and verify its sibling is cancelled with reservations released.
5. Enter `DEGRADED`, reject placement, allow cancellation, recover through REST snapshot, and label a recovery fill.
6. Trip the emergency latch, show `CANCEL_ONLY`, reject placement/FX, and preserve cancellation.
7. Create an account-sequence gap and verify one REST snapshot request restores the screen.

- [ ] **Step 5: Add responsive and keyboard journeys**

At desktop and 360 px widths, complete instrument selection and order validation without a pointer. Assert one `main`, visible focus, labeled form controls, non-color status text, and no horizontal page overflow.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm --filter @moi/e2e test:e2e
pnpm test
pnpm build
```

Expected: all E2E, unit, integration, and build tasks pass against deterministic local services.

Commit: `test(e2e): cover paper trading safety journeys`

---

### Task 8: Package CI, containers, deployment topology, and runbooks

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.dockerignore`
- Create: `apps/paper-api/Dockerfile`
- Create: `apps/web/Dockerfile`
- Create: `apps/web/server.mjs`
- Test: `apps/web/server.test.mjs`
- Create: `infra/compose.yaml`
- Create: `infra/monitoring/prometheus-alerts.yaml`
- Create: `docs/operations/deployment.md`
- Create: `docs/runbooks/market-data-degraded.md`
- Create: `docs/runbooks/redis-or-leader-loss.md`
- Create: `docs/runbooks/postgres-or-outbox-lag.md`
- Create: `docs/runbooks/emergency-cancel-only.md`
- Create: `docs/runbooks/anonymous-session-cleanup.md`
- Test: `scripts/check-deployment-contract.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write a failing deployment-contract checker**

The script parses deployment files and fails unless all invariants hold:

- runtime is Node 24.19.0;
- API and web images run as non-root users;
- only web and API ports are public;
- PostgreSQL and Redis use health checks and persistent data;
- the single `paper-api` process serves HTTP and owns exactly one leader per market;
- exactly one `paper-api` replica is configured by default;
- no Toss token, database password, or cookie secret is committed;
- readiness is distinct from liveness;
- shutdown grace exceeds the API drain interval.

```js
assert.equal(compose.services['paper-api'].deploy.replicas, 1);
assert.equal(compose.services.postgres.ports, undefined);
assert.equal(compose.services.redis.ports, undefined);
assert.match(apiDockerfile, /USER node/);
```

Add `"check:deployment": "node scripts/check-deployment-contract.mjs"` to the root scripts and `yaml` 2.9.0 to root development dependencies. The checker parses Compose and Prometheus YAML instead of relying on substring matches.

- [ ] **Step 2: Run the checker and verify that it fails**

Run: `pnpm check:deployment`

Expected: FAIL because container and compose files do not exist.

- [ ] **Step 3: Build minimal non-root production images**

Use multi-stage builds with a pinned Node 24.19.0 base, `corepack` plus pnpm 11.22.0, `pnpm fetch`, frozen lockfile installs, compilation in the builder, and production-only artifacts in the final image. API starts `node apps/paper-api/dist/server.js`; web starts `node apps/web/server.mjs`. The built-in Node static server allows only GET/HEAD, normalizes and confines paths to `dist`, sets an explicit MIME allowlist and security headers, serves hashed assets with immutable caching, serves `index.html` with `no-store`, and uses `index.html` only as the SPA fallback. It serves `/runtime-config.js` with `no-store` from validated `PUBLIC_API_ORIGIN` and includes that origin in `connect-src`; no secret enters the script. Test traversal, missing asset, HEAD, cache, MIME, runtime-config escaping, CSP, and fallback behavior. Run both final images as `node`; do not copy `.env`, tests, Git metadata, or developer control directories.

- [ ] **Step 4: Define the provider-neutral topology**

`infra/compose.yaml` must include `web`, `paper-api`, `postgres`, and `redis`. The one `paper-api` process serves public HTTP, acquires one fenced leader lease for each market, and owns the two Toss connections. Document how hosted platforms map those roles without assuming Docker Compose is production orchestration; scaling `paper-api` above one replica is outside the MVP.

Define Prometheus rules for immediate invariant/audit/emergency-latch failures; sustained market `DEGRADED`/`RECOVERING`; recovery beyond 60 seconds; reconnect flapping; transaction errors; DB lock wait; and outbox lag. Alert labels remain bounded by market, state, cause group, transaction type, and lock type. Annotations link each alert to one committed runbook; notification deduplication and cooldown key on alert name, market, incident, and recovery epoch.

- [ ] **Step 5: Write deployment and incident runbooks**

Every runbook must contain:

1. alert and dashboard symptoms;
2. safe first action;
3. how to enter or preserve `CANCEL_ONLY`;
4. read-only diagnosis commands;
5. recovery preconditions;
6. how to verify reservations, leader fence, outbox lag, and user-stream recovery;
7. rollback criteria;
8. evidence to retain after the incident.

The deployment guide must require migrations before traffic, one leader replica, readiness gates, graceful `CANCEL_ONLY → old leader disconnect → new leader recover → NORMAL` handoff, a rollback that preserves database compatibility, secret injection, TLS, secure cookies, same-site web/API origins compatible with `SameSite=Lax`, 14-day application-log retention, and backup/restore drills. It must explicitly forbid a rolling handoff that creates a third Toss connection.

- [ ] **Step 6: Add continuous integration**

The GitHub Actions workflow must pin Node and pnpm, use lockfile caching, start no external market connection, and run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm check:deployment
pnpm build
pnpm --filter @moi/e2e exec playwright install --with-deps chromium
pnpm --filter @moi/e2e test:e2e
```

Upload Playwright reports only on failure. Grant `contents: read` and no write permissions.

- [ ] **Step 7: Verify and commit**

Run:

```bash
pnpm check:deployment
docker compose -f infra/compose.yaml config --quiet
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands pass; `docker compose config` shows one `paper-api` replica and no public PostgreSQL or Redis port.

Commit: `chore(ops): add reproducible deployment and runbooks`

---

### Task 9: Run the full public-MVP acceptance gate

**Files:**

- Create: `docs/operations/release-checklist.md`
- Create: `apps/paper-api/src/release-drill.integration.test.ts`
- Create: `scripts/load-smoke.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the release checklist before claiming completion**

The checklist must link evidence for every approved-design promise:

- 40 Korean plus 40 US tradable symbols and all-symbol search;
- initial KRW 10,000,000 / USD 0 and virtual FX;
- market, limit, stop, take-profit, OCO, partial fills, slippage, and whole-share validation;
- deterministic fees, reservations, idempotency, audit, and outbox atomicity;
- `HEALTHY → DEGRADED → RECOVERING → HEALTHY` without retroactive gap fill;
- current REST price/book recovery, recovery epoch, fencing, and recovery-fill labeling;
- cause-specific incidents, hierarchical gates, local emergency latch, and cancel priority;
- anonymous-session expiry cleanup;
- user-stream deduplication and snapshot resync;
- metrics, logs, alerts, runbooks, backup/restore, and graceful deployment handoff;
- healthy mutation p95 ≤ 500 ms, cancel-only cancellation p95 ≤ 1,000 ms, PONG-loss detection ≤ 120 seconds, and at least 95% of transient regular-session feed incidents recovering within 60 seconds;
- absence of real-account credentials and real-order execution code.

- [ ] **Step 2: Run the complete clean-room gate**

From a clean clone with no developer environment files copied, run:

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm check:deployment
pnpm build
pnpm --filter @moi/e2e test:e2e
git diff --exit-code
```

Expected: every command passes, no generated artifact changes tracked files, and no test contacts Toss or a real broker.

- [ ] **Step 3: Perform targeted security and failure checks**

Write `release-drill.integration.test.ts` to use disposable Testcontainers only. It must migrate forward, restore a `pg_dump` into a second PostgreSQL container, verify ledger/audit counts and invariants, exercise the documented backward-compatible application rollback, and then deterministically inject leader loss, Redis loss, PostgreSQL outage, outbox backlog, WebSocket disconnect, and anonymous-session expiry. With virtual time it also proves two missed 60-second PONG windows close the feed and at least 95 of 100 deterministic transient incidents recover within 60 seconds.

`scripts/load-smoke.mjs` accepts `LOAD_BASE_URL`, `LOAD_DURATION_SECONDS`, and a test-admin credential, creates isolated anonymous sessions, measures server-observed command durations, and exits non-zero unless healthy order-mutation p95 is at most 500 ms and cancel-only cancellation p95 is at most 1,000 ms. It must restore `NORMAL` and cancel all test orders in a `finally` block.

Run the exact security and failure gates:

```bash
docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 detect --source=/repo --no-banner
pnpm audit --prod --audit-level high
docker build -f apps/paper-api/Dockerfile -t moi/paper-api:release .
docker build -f apps/web/Dockerfile -t moi/web:release .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.74.0 image --exit-code 1 --severity HIGH,CRITICAL moi/paper-api:release
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.74.0 image --exit-code 1 --severity HIGH,CRITICAL moi/web:release
pnpm --filter @moi/paper-api test -- release-drill.integration.test.ts
LOAD_BASE_URL=http://127.0.0.1:3000 LOAD_DURATION_SECONDS=60 LOAD_ADMIN_TOKEN=release-drill-only node scripts/load-smoke.mjs
```

Record timestamps and artifact links in the release checklist; do not waive a failure without an owner and expiry.

- [ ] **Step 4: Update public documentation**

Document local setup, architecture links, deterministic fake-feed development, supported order types, safety modes, project limitations, and the private real-bot repository boundary. State explicitly that users independently reuse displayed book depth, aggregate paper fills may exceed real liquidity, and no exchange queue position is modeled. State clearly that this is simulated trading and not investment advice.

- [ ] **Step 5: Commit the acceptance evidence**

Run: `git status --short`

Expected: only `README.md`, `CHANGELOG.md`, and `docs/operations/release-checklist.md` are staged for this task.

Commit: `docs: record public mvp acceptance evidence`

---

## Completion Criteria

Plan 4 is complete only when:

1. The browser completes every approved paper-trading journey using anonymous sessions.
2. Duplicate events and sequence gaps cannot duplicate fills or leave stale balances presented as current.
3. Every server safety capability has an explicit, accessible client state while server enforcement remains authoritative.
4. The deterministic E2E suite proves partial fills, OCO, recovery, cancel-only, and snapshot reconciliation.
5. CI, containers, topology checks, runbooks, and clean-room release evidence all pass.
6. No Toss secret, real-account credential, or real-order execution code exists in browser artifacts or the public repository.
