# Moi Foundation and Trading Core Implementation Plan

> **Status:** implemented and merged into `portfolio-project-ideas` (PR #1). The step checkboxes below are the original authoring artefacts and were not ticked retroactively; the spec's §16 implementation-deviation table and the release checklist are the record of what shipped and how it was verified.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the pinned TypeScript monorepo, pure trading domain, PostgreSQL ledger, transactional audit/outbox, and deterministic unit and integration tests on which every later Moi subsystem depends.

**Architecture:** Keep market-independent rules in `packages/trading-core` as pure functions over decimal strings and immutable snapshots. Keep PostgreSQL migrations and repositories private to `apps/paper-api`; expose transactions through narrow repository interfaces so later market-engine and HTTP layers cannot bypass invariants.

**Tech Stack:** Node.js 24.19.0 LTS, pnpm 11.22.0, Turborepo 2.10.11, TypeScript 7.0.2, Biome 2.5.9, Vitest 4.1.11, fast-check 4.9.0, Decimal.js 10.6.0, Kysely 0.29.5, pg 8.21.3, Testcontainers 12.1.0, PostgreSQL 17.

**Spec:** `docs/superpowers/specs/2026-08-21-moi-paper-trading-architecture-design.md`

## Global Constraints

- The server and PostgreSQL are authoritative; browser state and Redis are never trading truth.
- Initial wallets are KRW 10,000,000 and USD 0 for a new anonymous session.
- Quantities are positive whole shares; margin, leverage, shorting, derivatives, and fractional shares are excluded.
- JavaScript `number` is forbidden for money, price, quantity-derived notional, FX, fees, and PnL. APIs exchange canonical decimal strings and persistence uses PostgreSQL `numeric`.
- Persistence versions and sequences use `bigint` in server code and decimal strings at JSON boundaries; they never pass through JavaScript `number`.
- `wallet.total = wallet.available + wallet.reserved` and `position.total = position.available + position.reserved`; all three values are non-negative.
- An order's total fill quantity never exceeds order quantity; an OCO group resolves at most one winner leg.
- Terminal orders (`FILLED`, `CANCELLED`, `EXPIRED`, `REJECTED`) never reactivate, including after restart.
- Trading mutation, reservation, audit, outbox, and stored idempotency response commit or roll back together.
- Public packages contain the provider-neutral `Broker` contract and paper-only `PaperBroker`; no real-account credentials or live-order path may enter this repository.
- `.codegraph/`, `.cursor/`, and `.omc/` remain untracked.
- Tests are written first. Every task ends with targeted tests, workspace checks, and one focused commit.

## Plan Dependency

This is plan 1 of 4. Complete it before:

1. `2026-08-22-moi-market-data-and-paper-engine.md`
2. `2026-08-22-moi-paper-api.md`
3. `2026-08-22-moi-web-and-operations.md`

---

### Task 1: Pin the workspace and quality gates

**Files:**
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `scripts/check-runtime.mjs`
- Create: `packages/trading-core/package.json`
- Create: `packages/trading-core/tsconfig.json`
- Create: `packages/trading-core/src/index.ts`
- Create: `packages/strategy-sdk/package.json`
- Create: `packages/strategy-sdk/tsconfig.json`
- Create: `packages/strategy-sdk/src/index.ts`
- Create: `apps/paper-api/package.json`
- Create: `apps/paper-api/tsconfig.json`
- Create: `apps/paper-api/src/index.ts`
- Generate: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Node.js installed on the worker machine.
- Produces: `pnpm check`, `pnpm test`, `pnpm typecheck`, and `pnpm build` workspace commands; workspace package names `@moi/trading-core`, `@moi/strategy-sdk`, and `@moi/paper-api`.

- [ ] **Step 1: Write the runtime guard before installing dependencies**

```js
// scripts/check-runtime.mjs
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 19) {
  console.error(`Moi requires Node 24.19.x; received ${process.version}`);
  process.exit(1);
}
```

- [ ] **Step 2: Verify the current runtime fails the guard**

Run: `node scripts/check-runtime.mjs`

Expected: FAIL on the current Node 20 environment with `Moi requires Node 24.19.x`.

- [ ] **Step 3: Create the pinned workspace manifests**

```json
{
  "name": "moi",
  "private": true,
  "packageManager": "pnpm@11.22.0",
  "engines": { "node": ">=24.19.0 <25" },
  "scripts": {
    "preinstall": "node scripts/check-runtime.mjs",
    "build": "turbo run build",
    "check": "biome check .",
    "check:write": "biome check --write .",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.9",
    "@types/node": "24.13.3",
    "fast-check": "4.9.0",
    "turbo": "2.10.11",
    "typescript": "7.0.2",
    "vitest": "4.1.11"
  }
}
```

Set `.nvmrc` to `24.19.0`; configure `pnpm-workspace.yaml` for `apps/*` and `packages/*`; make Turbo tasks depend on `^build`; enable TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM, and project references. Configure Biome for two-space indentation, single quotes, sorted imports, and no implicit formatting exclusions.

- [ ] **Step 4: Switch to Node 24 and install exactly once**

Run:

```bash
nvm install 24.19.0
nvm use 24.19.0
corepack prepare pnpm@11.22.0 --activate
pnpm install
pnpm check
pnpm typecheck
```

Expected: runtime guard passes, a lockfile is generated, and all empty package checks pass.

- [ ] **Step 5: Commit the workspace foundation**

```bash
git add .nvmrc .gitignore package.json pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json scripts packages apps pnpm-lock.yaml
git commit -m "chore: initialize moi workspace"
```

---

### Task 2: Define decimal-safe domain primitives

**Files:**
- Create: `packages/trading-core/src/decimal.ts`
- Create: `packages/trading-core/src/decimal.test.ts`
- Create: `packages/trading-core/src/domain-types.ts`
- Create: `packages/trading-core/src/domain-errors.ts`
- Modify: `packages/trading-core/src/index.ts`

**Interfaces:**
- Consumes: Decimal.js 10.6.0.
- Produces: `DecimalString`, `Currency`, `Market`, `Side`, `OrderType`, `OrderStatus`, `Money`, `Quantity`, `DomainError`, `decimal()`, `canonicalDecimal()`, and `assertPositiveWholeQuantity()`.

- [ ] **Step 1: Write failing decimal boundary tests**

```ts
import { describe, expect, it } from 'vitest';
import { assertPositiveWholeQuantity, canonicalDecimal } from './decimal.js';

describe('decimal primitives', () => {
  it('canonicalizes without binary floating point', () => {
    expect(canonicalDecimal('0.10', '0.20')).toBe('0.3');
  });

  it.each(['0', '-1', '1.5'])('rejects invalid whole-share quantity %s', value => {
    expect(() => assertPositiveWholeQuantity(value)).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and confirm missing exports**

Run: `pnpm --filter @moi/trading-core test -- decimal.test.ts`

Expected: FAIL because `canonicalDecimal` and `assertPositiveWholeQuantity` do not exist.

- [ ] **Step 3: Implement canonical decimal primitives and closed unions**

```ts
import Decimal from 'decimal.js';

export type DecimalString = string;
export type Quantity = DecimalString;
export type Currency = 'KRW' | 'USD';
export type Market = 'KR' | 'US';

export const decimal = (value: Decimal.Value): Decimal => new Decimal(value);

export const canonicalDecimal = (...values: Decimal.Value[]): DecimalString =>
  values.reduce((sum, value) => sum.plus(value), new Decimal(0)).toString();

export function assertPositiveWholeQuantity(value: DecimalString): void {
  const quantity = decimal(value);
  if (!quantity.isInteger() || !quantity.isPositive()) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity must be a positive whole number');
  }
}
```

Define `DomainErrorCode` as a closed union containing the stable spec codes plus domain validation codes `INVALID_QUANTITY`, `INVALID_PRICE`, `INVALID_ORDER`, and `INVARIANT_VIOLATION`. Make `DomainError` carry `code`, `retryable`, and optional `retryAfterSeconds`; the API layer alone adds transport/session codes. Export every public primitive from `src/index.ts`.

- [ ] **Step 4: Run unit, type, and formatting checks**

Run: `pnpm --filter @moi/trading-core test && pnpm --filter @moi/trading-core typecheck && pnpm check`

Expected: PASS with no `number`-typed monetary fields.

- [ ] **Step 5: Commit the primitives**

```bash
git add packages/trading-core
git commit -m "feat(core): add decimal-safe domain primitives"
```

---

### Task 3: Implement the order and OCO state machines

**Files:**
- Create: `packages/trading-core/src/order.ts`
- Create: `packages/trading-core/src/order.test.ts`
- Create: `packages/trading-core/src/oco.ts`
- Create: `packages/trading-core/src/oco.test.ts`
- Modify: `packages/trading-core/src/index.ts`

**Interfaces:**
- Consumes: domain primitives and `DomainError` from Task 2.
- Produces: `OrderSnapshot`, `OrderEvent`, `transitionOrder(order, event)`, `OcoGroupSnapshot`, and `resolveOco(group, winnerLegId)`.

- [ ] **Step 1: Write failing transition tests**

```ts
it('never reactivates a terminal order', () => {
  const filled = orderFixture({ status: 'FILLED', version: 4n });
  expect(() => transitionOrder(filled, { type: 'OPENED' })).toThrowError(
    expect.objectContaining({ code: 'ORDER_STATE_CONFLICT' }),
  );
});

it('resolves exactly one OCO winner', () => {
  const once = resolveOco(ocoFixture(), 'stop-leg');
  expect(once.winnerLegId).toBe('stop-leg');
  expect(() => resolveOco(once, 'take-profit-leg')).toThrow();
});
```

- [ ] **Step 2: Run the state tests and verify failure**

Run: `pnpm --filter @moi/trading-core test -- order.test.ts oco.test.ts`

Expected: FAIL because the state machines are not implemented.

- [ ] **Step 3: Implement an explicit transition table**

```ts
const transitions: Record<OrderStatus, ReadonlySet<OrderStatus>> = {
  RECEIVED: new Set(['REJECTED', 'OPEN', 'PENDING_TRIGGER']),
  PENDING_TRIGGER: new Set(['TRIGGERED', 'CANCELLED', 'EXPIRED']),
  TRIGGERED: new Set(['OPEN', 'FILLED', 'CANCELLED']),
  OPEN: new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED']),
  PARTIALLY_FILLED: new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED']),
  FILLED: new Set(),
  CANCELLED: new Set(),
  EXPIRED: new Set(),
  REJECTED: new Set(),
};

export function transitionOrder(order: OrderSnapshot, next: OrderStatus): OrderSnapshot {
  if (!transitions[order.status].has(next)) {
    throw new DomainError('ORDER_STATE_CONFLICT', `${order.status} cannot transition to ${next}`);
  }
  return { ...order, status: next, version: order.version + 1n };
}
```

Represent partial IOC completion as terminal `CANCELLED` with positive `filledQuantity` and `terminalReason='IOC_REMAINDER'`. In `resolveOco`, reject any group not `ACTIVE`, set one winner, mark the sibling `CANCELLED`, and increment group version once.

- [ ] **Step 4: Run focused tests and property-check terminal states**

Run: `pnpm --filter @moi/trading-core test -- order.test.ts oco.test.ts`

Expected: PASS, including a fast-check property that no generated event can leave a terminal state.

- [ ] **Step 5: Commit the state machines**

```bash
git add packages/trading-core/src
git commit -m "feat(core): add order and OCO state machines"
```

---

### Task 4: Implement reservations and account invariants

**Files:**
- Create: `packages/trading-core/src/reservation.ts`
- Create: `packages/trading-core/src/reservation.test.ts`
- Create: `packages/trading-core/src/invariants.ts`
- Create: `packages/trading-core/src/invariants.property.test.ts`
- Modify: `packages/trading-core/src/index.ts`

**Interfaces:**
- Consumes: `Money`, `Quantity`, order snapshots, and Decimal helpers.
- Produces: `WalletSnapshot`, `PositionSnapshot`, `ReservationPlan`, `reserveCash()`, `reservePosition()`, `releaseReservation()`, and `assertAccountInvariants()`.

- [ ] **Step 1: Write reservation conservation tests**

```ts
it('moves cash from available to reserved without changing total', () => {
  const wallet = walletFixture({ total: '1000', available: '1000', reserved: '0' });
  expect(reserveCash(wallet, '250')).toEqual({
    ...wallet,
    available: '750',
    reserved: '250',
    version: wallet.version + 1n,
  });
});

it('rejects two orders that spend the same available cash', () => {
  const once = reserveCash(walletFixture({ total: '1000', available: '1000' }), '800');
  expect(() => reserveCash(once, '300')).toThrowError(
    expect.objectContaining({ code: 'INSUFFICIENT_AVAILABLE_CASH' }),
  );
});
```

- [ ] **Step 2: Verify the reservation tests fail**

Run: `pnpm --filter @moi/trading-core test -- reservation.test.ts invariants.property.test.ts`

Expected: FAIL because reservation functions are missing.

- [ ] **Step 3: Implement immutable reservation operations**

```ts
export function reserveCash(wallet: WalletSnapshot, amount: DecimalString): WalletSnapshot {
  const requested = decimal(amount);
  if (decimal(wallet.available).lt(requested)) {
    throw new DomainError('INSUFFICIENT_AVAILABLE_CASH', 'Available cash is insufficient');
  }
  return {
    ...wallet,
    available: decimal(wallet.available).minus(requested).toString(),
    reserved: decimal(wallet.reserved).plus(requested).toString(),
    version: wallet.version + 1n,
  };
}
```

Implement the symmetric position operation and releases. The reservation planner uses remaining quantity × limit price plus estimated fee for limit buys; current reference price × the 5% protection ceiling plus estimated fee for market and conditional-market buys; remaining quantity for sells; and one maximum exposure rather than the sum of two OCO legs. Amend, partial fill, cancellation, expiry, and OCO resolution move or release exactly the reservation delta. `assertAccountInvariants()` independently recomputes totals and throws an invariant-specific error without importing any reservation mutation function.

- [ ] **Step 4: Run property tests with recorded seeds**

Configure fast-check PR runs with seed `220826`, include the failing seed and path in assertion output, and make every generated operation sequence serializable into a regression fixture. A later nightly job may rotate the seed; PR replay remains fixed.

Run: `pnpm --filter @moi/trading-core test -- reservation.test.ts invariants.property.test.ts --reporter=verbose`

Expected: PASS for generated create/reserve/release sequences and KRW/USD separation.

- [ ] **Step 5: Commit reservations**

```bash
git add packages/trading-core/src
git commit -m "feat(core): enforce asset reservations"
```

---

### Task 5: Implement fee models and order-book execution

**Files:**
- Create: `packages/trading-core/src/fee-model.ts`
- Create: `packages/trading-core/src/fee-model.test.ts`
- Create: `packages/trading-core/src/execution.ts`
- Create: `packages/trading-core/src/execution.test.ts`
- Create: `packages/trading-core/src/execution.property.test.ts`
- Create: `packages/trading-core/src/portfolio-math.ts`
- Create: `packages/trading-core/src/portfolio-math.test.ts`
- Modify: `packages/trading-core/src/index.ts`

**Interfaces:**
- Consumes: decimal primitives, order snapshots, and normalized `OrderBookSnapshot` declared in this task.
- Produces: `FeeModel`, `OrderBookLevel`, `OrderBookSnapshot`, `ExecutionResult`, `PositionCost`, `calculateExecution(order, book, feeModel, protection)`, `applyFillToPosition()`, and `calculateUnrealizedPnl()`.

- [ ] **Step 1: Write golden execution tests with no production helper in the oracle**

```ts
it('walks ask depth and cancels an IOC remainder', () => {
  const result = calculateExecution(
    marketBuyFixture({ quantity: '5' }),
    bookFixture({ asks: [{ price: '100', volume: '2' }, { price: '101', volume: '2' }] }),
    zeroFeeModel,
    { referenceMid: '100', maxDeviationBps: 500 },
  );
  expect(result.fills).toEqual([
    { price: '100', quantity: '2', fee: '0' },
    { price: '101', quantity: '2', fee: '0' },
  ]);
  expect(result.unfilledQuantity).toBe('1');
  expect(result.terminalReason).toBe('IOC_REMAINDER');
});
```

- [ ] **Step 2: Run execution tests and verify failure**

Run: `pnpm --filter @moi/trading-core test -- execution.test.ts fee-model.test.ts portfolio-math.test.ts`

Expected: FAIL because execution and fee interfaces do not exist.

- [ ] **Step 3: Implement deterministic book walking and price protection**

```ts
export interface FeeModel {
  readonly version: string;
  calculate(input: { market: Market; side: Side; price: DecimalString; quantity: Quantity }): DecimalString;
}

export function withinProtection(price: DecimalString, mid: DecimalString, bps: number): boolean {
  const ratio = decimal(price).minus(mid).abs().div(mid).mul(10_000);
  return ratio.lte(bps);
}
```

Walk asks low-to-high for buys and bids high-to-low for sells; enforce a limit price before consuming a level; never consume more than remaining order quantity; reject one-sided or crossed books; return every consumed level so audit can explain the fill. Keep fee rounding inside the versioned `FeeModel`. Implement weighted-average cost, realized PnL on sells, and unrealized PnL from a supplied current price entirely with Decimal.js. Add hand-calculated KRW and USD golden cases whose expected values do not import production helpers.

- [ ] **Step 4: Run example and metamorphic properties**

Run: `pnpm --filter @moi/trading-core test -- execution.test.ts execution.property.test.ts fee-model.test.ts portfolio-math.test.ts`

Expected: PASS for fill quantity conservation, limit-price protection, deterministic level ordering, configured fee rounding, weighted-average cost, and realized/unrealized PnL.

- [ ] **Step 5: Commit execution logic**

```bash
git add packages/trading-core/src
git commit -m "feat(core): calculate protected book fills"
```

---

### Task 6: Publish the strategy-facing Broker contract

**Files:**
- Create: `packages/strategy-sdk/src/broker.ts`
- Create: `packages/strategy-sdk/src/broker.contract.test.ts`
- Create: `packages/strategy-sdk/src/paper-broker.ts`
- Create: `packages/strategy-sdk/src/paper-broker.test.ts`
- Modify: `packages/strategy-sdk/src/index.ts`
- Modify: `packages/strategy-sdk/package.json`

**Interfaces:**
- Consumes: exported snapshots and command types from `@moi/trading-core`.
- Produces: `Broker`, `PaperBroker`, `PaperBrokerTransport`, `PlaceOrderCommand`, `CancelOrderCommand`, `ExchangeCommand`, `PortfolioSnapshot`, and a reusable `runBrokerContract(factory)` test suite.

- [ ] **Step 1: Write a compile-time and runtime fake Broker contract test**

```ts
export interface Broker {
  placeOrder(command: PlaceOrderCommand): Promise<OrderSnapshot>;
  cancelOrder(command: CancelOrderCommand): Promise<OrderSnapshot>;
  exchange(command: ExchangeCommand): Promise<ExchangeReceipt>;
  getPortfolio(sessionId: string): Promise<PortfolioSnapshot>;
}
```

The contract test must assert same-key replay, terminal cancel behavior, and that portfolio currencies remain separate.

- [ ] **Step 2: Run the contract test and verify missing types**

Run: `pnpm --filter @moi/strategy-sdk test -- broker.contract.test.ts`

Expected: FAIL until command and snapshot types are exported.

- [ ] **Step 3: Add the exact public command contracts**

```ts
export interface PlaceOrderCommand {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly quantity: Quantity;
  readonly limitPrice?: DecimalString;
  readonly triggerPrice?: DecimalString;
}
```

Add discriminated unions so market orders cannot carry limit prices and limit orders must carry them. Keep all public types free of Fastify, Kysely, Toss, and database imports.

Implement `PaperBroker` as a thin adapter over an injected authenticated `PaperBrokerTransport`. It maps only to the paper endpoints `/api/v1/orders`, `/api/v1/fx/conversions`, and `/api/v1/portfolio`, forwards idempotency keys unchanged, and decodes stable paper-API errors. The transport owns cookie/session mechanics so the SDK never stores an anonymous token or imports a browser API. There is no configurable live-order base path.

- [ ] **Step 4: Run package contract and dependency-boundary checks**

Run: `pnpm --filter @moi/strategy-sdk test -- broker.contract.test.ts paper-broker.test.ts && pnpm --filter @moi/strategy-sdk typecheck && pnpm build`

Expected: PASS and `pnpm --filter @moi/strategy-sdk why fastify` returns no runtime dependency.

- [ ] **Step 5: Commit the Broker contract**

```bash
git add packages/strategy-sdk
git commit -m "feat(strategy): define broker contract"
```

---

### Task 7: Create the PostgreSQL ledger migration

**Files:**
- Create: `apps/paper-api/src/db/database.ts`
- Create: `apps/paper-api/src/db/migrate.ts`
- Create: `apps/paper-api/src/db/migrations/001_ledger.sql`
- Create: `apps/paper-api/src/db/migrations/002_audit_partitions.sql`
- Create: `apps/paper-api/src/db/migration.integration.test.ts`
- Modify: `apps/paper-api/package.json`

**Interfaces:**
- Consumes: PostgreSQL 17 connection URL.
- Produces: `Database`, `createDatabase(url)`, `migrateToLatest(db)`, and schema tables listed in spec section 5.1.

- [ ] **Step 1: Write a failing Testcontainers migration test**

```ts
it('creates ledger constraints on an empty PostgreSQL database', async () => {
  const postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
  const db = createDatabase(postgres.getConnectionUri());
  await migrateToLatest(db);
  const tables = await sql<{ table_name: string }>`
    select table_name from information_schema.tables where table_schema = 'public'
  `.execute(db);
  expect(tables.rows.map(row => row.table_name)).toEqual(
    expect.arrayContaining(['wallets', 'positions', 'orders', 'fills', 'reservations', 'audit_events']),
  );
});
```

- [ ] **Step 2: Run the migration test and verify failure**

Run: `pnpm --filter @moi/paper-api test -- migration.integration.test.ts`

Expected: FAIL because no database or migrations exist.

- [ ] **Step 3: Write the complete ledger schema**

The SQL migration must create UUID-keyed session, wallet, position, order, OCO, fill, reservation, idempotency, safety-incident, outbox, account-sequence, market-state, leader-epoch, capacity, market-session, fee-model-version, whitelist-version, and whitelist-entry tables. Use `numeric` for decimal fields, `version bigint not null`, unique `(session_id, currency)`, unique `(session_id, idempotency_key)`, unique outbox `event_id`, unique `(session_id, account_sequence)`, check `total = available + reserved`, non-negative checks, and unique OCO winner semantics. Foreign keys prevent a whitelist entry or order from referring to an unknown market; published whitelist and fee-model versions are immutable. Audit rows retain a pseudonymous session reference rather than a cascading foreign key so expiry deletion cannot remove them. Partition `audit_events` by `occurred_at` with a default partition; `ensureAuditPartitions(db, now)` creates current and next monthly partitions transactionally.

```sql
create table wallets (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  currency text not null check (currency in ('KRW', 'USD')),
  total numeric not null check (total >= 0),
  available numeric not null check (available >= 0),
  reserved numeric not null check (reserved >= 0),
  version bigint not null default 0,
  unique (session_id, currency),
  check (total = available + reserved)
);
```

- [ ] **Step 4: Run migrations twice and verify idempotence**

Run: `pnpm --filter @moi/paper-api test -- migration.integration.test.ts`

Expected: PASS when migrating a new database and when `migrateToLatest()` is called again.

- [ ] **Step 5: Commit the ledger schema**

```bash
git add apps/paper-api/src/db apps/paper-api/package.json pnpm-lock.yaml
git commit -m "feat(api): add transactional ledger schema"
```

---

### Task 8: Implement the transactional repositories and unit of work

**Files:**
- Create: `apps/paper-api/src/db/unit-of-work.ts`
- Create: `apps/paper-api/src/db/repositories/session-repository.ts`
- Create: `apps/paper-api/src/db/repositories/account-repository.ts`
- Create: `apps/paper-api/src/db/repositories/order-repository.ts`
- Create: `apps/paper-api/src/db/repositories/audit-repository.ts`
- Create: `apps/paper-api/src/db/repositories/outbox-repository.ts`
- Create: `apps/paper-api/src/db/repositories/idempotency-repository.ts`
- Create: `apps/paper-api/src/db/unit-of-work.integration.test.ts`

**Interfaces:**
- Consumes: `Database`, core snapshots, and domain errors.
- Produces: `UnitOfWork.run<T>(work)`, `TradingTransaction`, row-locking repository methods, and atomic `commitTradingMutation(input)` behavior.

- [ ] **Step 1: Write a failing rollback and replay test**

```ts
it('rolls back ledger, audit, outbox, and idempotency together', async () => {
  await expect(
    unitOfWork.run(async tx => {
      await tx.orders.insert(orderFixture());
      await tx.audit.append(auditFixture());
      await tx.outbox.append(outboxFixture());
      await tx.idempotency.complete(idempotencyFixture());
      throw new Error('forced rollback');
    }),
  ).rejects.toThrow('forced rollback');
  expect(await countLedgerRows(db)).toEqual({ orders: 0, audit: 0, outbox: 0, idempotency: 0 });
});
```

- [ ] **Step 2: Run the unit-of-work test and verify failure**

Run: `pnpm --filter @moi/paper-api test -- unit-of-work.integration.test.ts`

Expected: FAIL because repositories are missing.

- [ ] **Step 3: Implement one Kysely transaction boundary**

```ts
export class UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: TradingTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async trx => work(createTradingTransaction(trx)));
  }
}
```

Repository mutation methods must accept the transaction object, use `FOR UPDATE` for wallet/position/order/OCO rows, require expected versions in updates, and return `ORDER_STATE_CONFLICT` on zero updated rows. `UnitOfWork.run()` retries PostgreSQL `40001` serialization failures and `40P01` deadlocks at most three times with injected deterministic backoff, but never retries domain errors or an unknown commit outcome. Do not export the raw Kysely instance from an application service.

- [ ] **Step 4: Run rollback, optimistic-version, and concurrent-reservation tests**

Run: `pnpm --filter @moi/paper-api test -- unit-of-work.integration.test.ts`

Expected: PASS, including two concurrent reservations where exactly one succeeds, forced serialization/deadlock retries preserve one result, and the retry ceiling returns a stable transient error.

- [ ] **Step 5: Commit repositories**

```bash
git add apps/paper-api/src/db
git commit -m "feat(api): add ledger unit of work"
```

---

### Task 9: Verify plan-1 invariants as one deliverable

**Files:**
- Create: `apps/paper-api/src/db/ledger.contract.integration.test.ts`
- Create: `docs/testing/ledger-test-oracle.md`

**Interfaces:**
- Consumes: all Plan 1 exports.
- Produces: a reusable ledger contract that later API and engine implementations must run unchanged.

- [ ] **Step 1: Add the cross-package contract test**

```ts
it('preserves the independent ledger equation across reserve, partial fill, and cancel', async () => {
  const before = await readAccountLedger(db, sessionId);
  await exerciseReservePartialFillAndCancel(unitOfWork, sessionId);
  const after = await readAccountLedger(db, sessionId);
  expect(independentLedgerEquation(before, after)).toEqual({ balanced: true, delta: '0' });
});
```

Document the independent oracle equations and golden KRW/USD examples in `ledger-test-oracle.md`; the oracle may query audit/fill rows but may not import production fee, execution, or reservation helpers.

- [ ] **Step 2: Run the full workspace and capture failures**

Run: `pnpm check && pnpm typecheck && pnpm test && pnpm build`

Expected: PASS. If a package leaks Fastify, Kysely, or Toss types into `trading-core` or `strategy-sdk`, type/dependency checks must fail before proceeding.

- [ ] **Step 3: Test the production migration from an empty database**

Run: `pnpm --filter @moi/paper-api test -- migration.integration.test.ts ledger.contract.integration.test.ts`

Expected: PASS with PostgreSQL 17 Testcontainers and no residual containers.

- [ ] **Step 4: Inspect the public export surface**

Run: `pnpm --filter @moi/trading-core build && pnpm --filter @moi/strategy-sdk build`

Expected: generated declarations contain domain and Broker contracts only, with no database or real-broker secret type.

- [ ] **Step 5: Commit the Plan 1 acceptance suite**

```bash
git add apps/paper-api/src/db/ledger.contract.integration.test.ts docs/testing/ledger-test-oracle.md
git commit -m "test: lock ledger invariants"
```

Plan 1 is complete when the workspace is reproducible on Node 24.19.0, all pure-domain and PostgreSQL tests pass, and later plans can use the exported contracts without accessing raw database state.
