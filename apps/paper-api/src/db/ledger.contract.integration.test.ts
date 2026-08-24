/**
 * The Plan 1 ledger contract.
 *
 * This file is the acceptance deliverable of Plan 1 and it is written to be run
 * unchanged by later plans. It has three separable parts:
 *
 *   1. An **independent oracle** (`readAccountLedger`, `independentLedgerEquation`,
 *      `ledgerEquationResiduals`) that reads raw ledger rows and re-derives what
 *      the account's balances must be, using arithmetic implemented here from
 *      scratch. It imports no production fee, execution, reservation, or
 *      accounting helper — not even `@skipjack/trading-core`'s `decimal`. If the
 *      oracle shared an arithmetic implementation with the code under test, a
 *      defect in that implementation would cancel out of both sides and the
 *      suite would confirm nothing.
 *   2. A **driver contract** (`LedgerScenarioDriver`) naming the three ledger
 *      operations the scenario needs: reserve, partial fill, cancel. Plan 1's
 *      driver is built here from Plan 1's own exports. A later API or engine
 *      plan supplies its own driver and runs every test below unchanged.
 *   3. The **contract tests**, which assert the equation over every adjacent
 *      before/after pair and the whole scenario. Literal leg snapshots make the
 *      contract non-vacuous: a no-op fill or cancel fails even though comparing
 *      two unchanged ledgers could otherwise produce a zero residual.
 *
 * The equations and the golden KRW/USD examples are documented in
 * `docs/testing/ledger-test-oracle.md`; the numbers in `GOLDEN_SCENARIOS` below
 * are the same numbers, and a test asserts the observed balances against them
 * digit for digit so the document cannot drift away from the code.
 */

import { randomUUID } from 'node:crypto';
import {
  applyFillToPosition,
  type Currency,
  calculateExecution,
  createFeeModel,
  type DecimalString,
  type ExecutionFill,
  type FeeModel,
  type Market,
  planReservation,
  type Quantity,
  releaseReservation,
} from '@skipjack/trading-core';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  type Database,
  type LedgerTransaction,
} from './database.js';
import { compositeLockKey, createLockOrderGuard } from './lock-order.js';
import { ensureAuditPartitions, migrateToLatest } from './migrate.js';
import { createAccountRepository } from './repositories/account-repository.js';
import { createAuditRepository } from './repositories/audit-repository.js';
import { createOrderRepository } from './repositories/order-repository.js';
import { createOutboxRepository } from './repositories/outbox-repository.js';
import { type LedgerConnection, UnitOfWork } from './unit-of-work.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;

let container: StartedPostgreSqlContainer;
let db: Database;

// ---------------------------------------------------------------------------
// 1. The independent oracle
//
// Everything between here and the driver section is deliberately free of
// production imports. It parses `numeric` text into an exact scaled integer and
// does its own addition, subtraction and multiplication. Division never appears:
// no equation below needs it, which is what lets the oracle be exact.
// ---------------------------------------------------------------------------

/** An exact decimal: `units * 10^-scale`, with `scale >= 0`. */
interface Exact {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL_TEXT = /^-?[0-9]+(?:\.[0-9]+)?$/u;

function exact(text: string): Exact {
  if (!DECIMAL_TEXT.test(text)) {
    throw new Error(`the oracle cannot read ${text} as an exact decimal`);
  }
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const point = digits.indexOf('.');
  if (point === -1) {
    const units = BigInt(digits);
    return { units: negative ? -units : units, scale: 0 };
  }
  const fraction = digits.slice(point + 1);
  const units = BigInt(digits.slice(0, point) + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

const ZERO: Exact = { units: 0n, scale: 0 };

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Re-expresses both values at their common (larger) scale. */
function align(a: Exact, b: Exact): readonly [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.units * pow10(scale - a.scale),
    b.units * pow10(scale - b.scale),
    scale,
  ];
}

function add(a: Exact, b: Exact): Exact {
  const [left, right, scale] = align(a, b);
  return { units: left + right, scale };
}

function subtract(a: Exact, b: Exact): Exact {
  const [left, right, scale] = align(a, b);
  return { units: left - right, scale };
}

function multiply(a: Exact, b: Exact): Exact {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

function negate(a: Exact): Exact {
  return { units: -a.units, scale: a.scale };
}

function isZero(a: Exact): boolean {
  return a.units === 0n;
}

function absolute(a: Exact): Exact {
  return a.units < 0n ? negate(a) : a;
}

/**
 * Renders an exact value the way the equation reports it: no trailing zeros, no
 * negative zero, so a zero residual is the string `'0'` whatever scale it was
 * computed at.
 */
function format(value: Exact): string {
  if (value.units === 0n) {
    return '0';
  }
  const negative = value.units < 0n;
  let digits = (negative ? -value.units : value.units).toString();
  if (value.scale === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }
  digits = digits.padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits
    .slice(digits.length - value.scale)
    .replace(/0+$/u, '');
  const rendered = fraction === '' ? whole : `${whole}.${fraction}`;
  return `${negative ? '-' : ''}${rendered}`;
}

function sum(values: readonly Exact[]): Exact {
  return values.reduce(add, ZERO);
}

/** A wallet as the database holds it, with no production type in sight. */
interface WalletLedgerRow {
  readonly currency: string;
  readonly total: string;
  readonly available: string;
  readonly reserved: string;
}

interface PositionLedgerRow {
  readonly marketCode: string;
  readonly symbol: string;
  readonly total: string;
  readonly available: string;
  readonly reserved: string;
}

interface FillLedgerRow {
  readonly orderId: string;
  readonly side: string;
  readonly currency: string;
  readonly marketCode: string;
  readonly symbol: string;
  readonly price: string;
  readonly quantity: string;
  readonly fee: string;
}

interface OrderLedgerRow {
  readonly id: string;
  readonly side: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly filledQuantity: string;
  readonly status: string;
}

interface ReservationLedgerRow {
  readonly orderId: string | null;
  readonly kind: string;
  readonly currency: string | null;
  readonly marketCode: string | null;
  readonly symbol: string | null;
  readonly amount: string;
  readonly released: boolean;
}

/** Everything the oracle is allowed to look at, at one instant. */
interface AccountLedger {
  readonly sessionId: string;
  readonly wallets: readonly WalletLedgerRow[];
  readonly positions: readonly PositionLedgerRow[];
  readonly fills: readonly FillLedgerRow[];
  readonly orders: readonly OrderLedgerRow[];
  readonly reservations: readonly ReservationLedgerRow[];
  readonly auditEventTypes: readonly string[];
}

/**
 * Reads one account's ledger through plain SQL.
 *
 * `fills` is joined to `orders` so a fill carries the side, symbol and currency
 * the wallet equation needs without the oracle ever asking production code what
 * a fill means. The currency comes from `markets.base_currency`, which is the
 * schema's own statement of which wallet a market settles in.
 */
async function readAccountLedger(
  target: Database,
  sessionId: string,
): Promise<AccountLedger> {
  const wallets = await sql<WalletLedgerRow>`
    select currency, total::text as total, available::text as available,
           reserved::text as reserved
    from wallets
    where session_id = ${sessionId}
    order by currency
  `.execute(target);

  const positions = await sql<PositionLedgerRow>`
    select market_code as "marketCode", symbol,
           total_quantity::text as total,
           available_quantity::text as available,
           reserved_quantity::text as reserved
    from positions
    where session_id = ${sessionId}
    order by market_code, symbol
  `.execute(target);

  const fills = await sql<FillLedgerRow>`
    select f.order_id as "orderId", o.side, m.base_currency as currency,
           o.market_code as "marketCode", o.symbol,
           f.price::text as price, f.quantity::text as quantity,
           f.fee::text as fee
    from fills f
    join orders o on o.id = f.order_id
    join markets m on m.code = o.market_code
    where o.session_id = ${sessionId}
    order by f.occurred_at, f.id
  `.execute(target);

  const orders = await sql<OrderLedgerRow>`
    select id, side, symbol, quantity::text as quantity,
           filled_quantity::text as "filledQuantity", status
    from orders
    where session_id = ${sessionId}
    order by created_at, id
  `.execute(target);

  const reservations = await sql<ReservationLedgerRow>`
    select order_id as "orderId", kind, currency,
           market_code as "marketCode", symbol,
           amount::text as amount, released
    from reservations
    where session_id = ${sessionId}
    order by id
  `.execute(target);

  const auditEventTypes = await sql<{ event_type: string }>`
    select a.event_type
    from audit_events a
    join orders o on o.id = a.order_id
    where o.session_id = ${sessionId}
    order by a.occurred_at, a.id
  `.execute(target);

  return {
    sessionId,
    wallets: wallets.rows,
    positions: positions.rows,
    fills: fills.rows,
    orders: orders.rows,
    reservations: reservations.rows,
    auditEventTypes: auditEventTypes.rows.map((row) => row.event_type),
  };
}

/** One equation's residual. Zero means the equation held. */
interface Residual {
  readonly equation: string;
  readonly subject: string;
  readonly residual: string;
}

function walletOf(
  ledger: AccountLedger,
  currency: string,
): WalletLedgerRow | undefined {
  return ledger.wallets.find((wallet) => wallet.currency === currency);
}

function positionOf(
  ledger: AccountLedger,
  marketCode: string,
  symbol: string,
): PositionLedgerRow | undefined {
  return ledger.positions.find(
    (position) =>
      position.marketCode === marketCode && position.symbol === symbol,
  );
}

/**
 * E1 — composition. `total = available + reserved` in both buckets, in whichever
 * snapshot it is checked. The schema states it too; checking it here means the
 * oracle never builds a later equation on a row that is already inconsistent.
 */
function compositionResiduals(
  ledger: AccountLedger,
  label: string,
): readonly Residual[] {
  const residuals: Residual[] = [];
  for (const wallet of ledger.wallets) {
    residuals.push({
      equation: 'E1-wallet-composition',
      subject: `${label}:${wallet.currency}`,
      residual: format(
        subtract(
          exact(wallet.total),
          add(exact(wallet.available), exact(wallet.reserved)),
        ),
      ),
    });
  }
  for (const position of ledger.positions) {
    residuals.push({
      equation: 'E1-position-composition',
      subject: `${label}:${position.marketCode}:${position.symbol}`,
      residual: format(
        subtract(
          exact(position.total),
          add(exact(position.available), exact(position.reserved)),
        ),
      ),
    });
  }
  return residuals;
}

/**
 * The cash a fill moves out of the wallet, derived from the fill row alone.
 *
 * A BUY pays the notional and the fee; a SELL receives the notional and pays the
 * fee out of the proceeds. Expressed as a single signed outflow so one equation
 * covers both sides.
 */
function cashOutflow(fill: FillLedgerRow): Exact {
  const notional = multiply(exact(fill.price), exact(fill.quantity));
  const fee = exact(fill.fee);
  if (fill.side === 'BUY') {
    return add(notional, fee);
  }
  if (fill.side === 'SELL') {
    return subtract(fee, notional);
  }
  throw new Error(`the oracle does not know the side ${fill.side}`);
}

/** The signed quantity a fill adds to the position. */
function positionInflow(fill: FillLedgerRow): Exact {
  const quantity = exact(fill.quantity);
  if (fill.side === 'BUY') {
    return quantity;
  }
  if (fill.side === 'SELL') {
    return negate(quantity);
  }
  throw new Error(`the oracle does not know the side ${fill.side}`);
}

function currencies(...ledgers: readonly AccountLedger[]): readonly string[] {
  const found = new Set<string>();
  for (const ledger of ledgers) {
    for (const wallet of ledger.wallets) {
      found.add(wallet.currency);
    }
    for (const fill of ledger.fills) {
      found.add(fill.currency);
    }
    for (const reservation of ledger.reservations) {
      if (reservation.currency !== null) {
        found.add(reservation.currency);
      }
    }
  }
  return [...found].sort();
}

function positionKeys(
  ...ledgers: readonly AccountLedger[]
): readonly (readonly [string, string])[] {
  const found = new Map<string, readonly [string, string]>();
  for (const ledger of ledgers) {
    for (const position of ledger.positions) {
      found.set(`${position.marketCode}:${position.symbol}`, [
        position.marketCode,
        position.symbol,
      ]);
    }
    for (const fill of ledger.fills) {
      found.set(`${fill.marketCode}:${fill.symbol}`, [
        fill.marketCode,
        fill.symbol,
      ]);
    }
  }
  return [...found.keys()].sort().map((key) => {
    const entry = found.get(key);
    if (entry === undefined) {
      throw new Error(`the oracle lost the position key ${key}`);
    }
    return entry;
  });
}

/** The fills present in `after` that were not already present in `before`. */
function fillsBetween(
  before: AccountLedger,
  after: AccountLedger,
): readonly FillLedgerRow[] {
  return after.fills.slice(before.fills.length);
}

/**
 * Every equation's residual for one before/after pair.
 *
 * Reported per equation and per subject rather than as one number, because a
 * single scalar tells you the ledger drifted but not which conservation law
 * broke, and a contract test whose failure message does not name the law is a
 * contract test somebody will delete.
 */
function ledgerEquationResiduals(
  before: AccountLedger,
  after: AccountLedger,
): readonly Residual[] {
  if (before.sessionId !== after.sessionId) {
    throw new Error('the oracle cannot compare two different accounts');
  }
  const residuals: Residual[] = [
    ...compositionResiduals(before, 'before'),
    ...compositionResiduals(after, 'after'),
  ];
  const newFills = fillsBetween(before, after);

  // E2 — cash conservation. The change in a wallet's total equals the cash the
  // fills between the snapshots moved out of it.
  for (const currency of currencies(before, after)) {
    const beforeWallet = walletOf(before, currency);
    const afterWallet = walletOf(after, currency);
    const beforeTotal =
      beforeWallet === undefined ? ZERO : exact(beforeWallet.total);
    const afterTotal =
      afterWallet === undefined ? ZERO : exact(afterWallet.total);
    const outflow = sum(
      newFills
        .filter((fill) => fill.currency === currency)
        .map((fill) => cashOutflow(fill)),
    );
    residuals.push({
      equation: 'E2-cash-conservation',
      subject: currency,
      residual: format(add(subtract(afterTotal, beforeTotal), outflow)),
    });
  }

  // E3 — the reserved bucket is backed by the reservation ledger. Reserved cash
  // that no unreleased reservation accounts for is cash nothing knows how to
  // release, which is the failure mode a balance-only check cannot see.
  for (const currency of currencies(before, after)) {
    const afterWallet = walletOf(after, currency);
    const reserved =
      afterWallet === undefined ? ZERO : exact(afterWallet.reserved);
    const backing = sum(
      after.reservations
        .filter(
          (reservation) =>
            reservation.kind === 'CASH' &&
            reservation.currency === currency &&
            !reservation.released,
        )
        .map((reservation) => exact(reservation.amount)),
    );
    residuals.push({
      equation: 'E3-cash-reservation-backing',
      subject: currency,
      residual: format(subtract(reserved, backing)),
    });
  }

  for (const [marketCode, symbol] of positionKeys(before, after)) {
    const beforePosition = positionOf(before, marketCode, symbol);
    const afterPosition = positionOf(after, marketCode, symbol);
    const beforeTotal =
      beforePosition === undefined ? ZERO : exact(beforePosition.total);
    const afterTotal =
      afterPosition === undefined ? ZERO : exact(afterPosition.total);
    const inflow = sum(
      newFills
        .filter(
          (fill) => fill.marketCode === marketCode && fill.symbol === symbol,
        )
        .map((fill) => positionInflow(fill)),
    );

    // E4 — position conservation.
    residuals.push({
      equation: 'E4-position-conservation',
      subject: `${marketCode}:${symbol}`,
      residual: format(subtract(subtract(afterTotal, beforeTotal), inflow)),
    });

    // E5 — the reserved quantity is backed by the reservation ledger.
    const reserved =
      afterPosition === undefined ? ZERO : exact(afterPosition.reserved);
    const backing = sum(
      after.reservations
        .filter(
          (reservation) =>
            reservation.kind === 'POSITION' &&
            reservation.marketCode === marketCode &&
            reservation.symbol === symbol &&
            !reservation.released,
        )
        .map((reservation) => exact(reservation.amount)),
    );
    residuals.push({
      equation: 'E5-position-reservation-backing',
      subject: `${marketCode}:${symbol}`,
      residual: format(subtract(reserved, backing)),
    });
  }

  // E6 — an order's recorded fill quantity equals the fills recorded against
  // it. Both sides of this one live in `after`: it is a within-snapshot law, and
  // an order whose header disagrees with its own fills makes every quantity
  // equation above unauditable.
  for (const order of after.orders) {
    const recorded = sum(
      after.fills
        .filter((fill) => fill.orderId === order.id)
        .map((fill) => exact(fill.quantity)),
    );
    residuals.push({
      equation: 'E6-order-fill-agreement',
      subject: order.id,
      residual: format(subtract(exact(order.filledQuantity), recorded)),
    });
  }

  return residuals;
}

interface LedgerEquationVerdict {
  readonly balanced: boolean;
  readonly delta: string;
}

/**
 * The whole ledger equation as one verdict.
 *
 * `delta` is the sum of the absolute residuals of every equation, so it is `'0'`
 * exactly when all of them held, and its magnitude is the size of the drift when
 * they did not. `balanced` is not derived from `delta` alone — a structural
 * violation with a zero residual (a fill whose side the oracle does not know,
 * for instance) throws rather than balancing quietly.
 */
function independentLedgerEquation(
  before: AccountLedger,
  after: AccountLedger,
): LedgerEquationVerdict {
  const residuals = ledgerEquationResiduals(before, after);
  const delta = sum(residuals.map((entry) => absolute(exact(entry.residual))));
  return { balanced: isZero(delta), delta: format(delta) };
}

/** The residuals that did not hold, for a failure message worth reading. */
function brokenEquations(
  before: AccountLedger,
  after: AccountLedger,
): readonly Residual[] {
  return ledgerEquationResiduals(before, after).filter(
    (entry) => entry.residual !== '0',
  );
}

// ---------------------------------------------------------------------------
// 2. The driver contract
//
// From here on production imports are expected: this half is the code under
// test. `LedgerScenarioDriver` is the seam a later plan replaces — the contract
// tests below never touch anything else.
// ---------------------------------------------------------------------------

interface ScenarioAccount {
  readonly sessionId: string;
  readonly market: Market;
  readonly currency: Currency;
  readonly symbol: string;
  readonly walletTotal: DecimalString;
}

interface ReserveRequest {
  readonly account: ScenarioAccount;
  readonly orderId: string;
  readonly quantity: Quantity;
  readonly limitPrice: DecimalString;
}

interface PartialFillRequest {
  readonly account: ScenarioAccount;
  readonly orderId: string;
  readonly quantity: Quantity;
  readonly limitPrice: DecimalString;
  readonly fillQuantity: Quantity;
}

interface CancelRequest {
  readonly account: ScenarioAccount;
  readonly orderId: string;
}

/**
 * The three ledger operations the acceptance scenario needs.
 *
 * A later API or engine implementation supplies its own driver and every test
 * below runs unchanged. That is the whole point of the seam: the contract is
 * about what the ledger must look like afterwards, never about which code put it
 * there.
 */
interface LedgerScenarioDriver {
  reserve(request: ReserveRequest): Promise<void>;
  partialFill(request: PartialFillRequest): Promise<void>;
  cancel(request: CancelRequest): Promise<void>;
}

const FEE_SCHEDULES = {
  KR: {
    version: 'kr-2026-08',
    market: 'KR',
    currency: 'KRW',
    commissionRate: '0.00015',
    sellTaxRate: '0.0018',
    roundingDecimals: 0,
    roundingMode: 'DOWN',
  },
  US: {
    version: 'us-2026-08',
    market: 'US',
    currency: 'USD',
    commissionRate: '0.0025',
    sellTaxRate: '0',
    roundingDecimals: 2,
    roundingMode: 'HALF_UP',
  },
} as const;

function feeModelFor(market: Market): FeeModel {
  return createFeeModel(FEE_SCHEDULES[market]);
}

const PROTECTION_BPS = 500;
const RESERVED_AT = new Date('2026-08-22T00:00:00.000Z');
const PARTIALLY_FILLED_AT = new Date('2026-08-22T00:00:01.000Z');
const CANCELLED_AT = new Date('2026-08-22T00:00:02.000Z');

async function lockScenarioSession(
  connection: LedgerConnection,
  sessionId: string,
): Promise<void> {
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: sessionId,
    strength: 'UPDATE',
  });
  const result = await sql<{ id: string }>`
    select id from anonymous_sessions where id = ${sessionId} for update
  `.execute(connection.executor);
  if (result.rows.length !== 1) {
    throw new Error(`session ${sessionId} does not exist`);
  }
}

function onlyFill(
  fills: readonly ExecutionFill[],
  expectedQuantity: Quantity,
): ExecutionFill {
  const fill = fills[0];
  if (
    fills.length !== 1 ||
    fill === undefined ||
    fill.quantity !== expectedQuantity
  ) {
    throw new Error('the golden partial-fill book must produce one exact fill');
  }
  return fill;
}

/**
 * Plan 1's driver.
 *
 * Every write Plan 1 owns goes through Plan 1's own code: `UnitOfWork` opens the
 * transaction for the reserve leg, the repositories write the order, the
 * reservation, the audit event and the outbox event, and trading-core computes
 * every amount (`planReservation`, `calculateExecution`, `createFeeModel`,
 * `applyFillToPosition`, `releaseReservation`).
 *
 * Settlement has no Plan 1 repository owner yet: debiting a wallet, creating
 * the bought position, recording a fill, and drawing down or releasing a
 * reservation therefore use raw SQL inside the same transaction. Every
 * contended Plan 1 parent is first held through the real Task 8 guard in global
 * order (session, wallet, position key, order); inserts only re-pin those held
 * parents. The reservation row is protected by its already-held order row and
 * is mutated last among ledger rows. No other Plan 1 path updates reservations.
 * A later plan that owns settlement replaces this shim; the contract function
 * and all of its assertions remain unchanged.
 */
function createPlan1Driver(target: Database): LedgerScenarioDriver {
  return {
    async reserve(request) {
      const account = request.account;
      const feeModel = feeModelFor(account.market);
      const estimatedFee = feeModel.calculate({
        market: account.market,
        side: 'BUY',
        price: request.limitPrice,
        quantity: request.quantity,
      });
      const plan = planReservation({
        id: request.orderId,
        status: 'RECEIVED',
        side: 'BUY',
        type: 'LIMIT',
        currency: account.currency,
        symbol: account.symbol,
        quantity: request.quantity,
        limitPrice: request.limitPrice,
        estimatedFee,
      });
      const cash = plan.cash;
      if (cash === undefined) {
        throw new Error('a BUY reservation plan must name its cash leg');
      }

      const unitOfWork = new UnitOfWork(target, {
        backoff: async () => undefined,
      });
      await unitOfWork.run(async (tx) => {
        const session = await tx.sessions.lock(account.sessionId);
        if (session === undefined) {
          throw new Error(`session ${account.sessionId} does not exist`);
        }
        const wallet = await tx.accounts.lockWallet({
          sessionId: account.sessionId,
          currency: account.currency,
        });
        if (wallet === undefined) {
          throw new Error(`session ${account.sessionId} holds no wallet`);
        }
        await tx.accounts.reserveCash({ wallet, amount: cash.amount });
        await tx.orders.insert({
          id: request.orderId,
          sessionId: account.sessionId,
          marketCode: account.market,
          symbol: account.symbol,
          orderType: 'LIMIT',
          side: 'BUY',
          limitPrice: request.limitPrice,
          quantity: request.quantity,
          status: 'OPEN',
        });
        await tx.accounts.recordReservation({
          id: randomUUID(),
          sessionId: account.sessionId,
          orderId: request.orderId,
          kind: 'CASH',
          currency: account.currency,
          amount: cash.amount,
        });
        await tx.audit.append({
          id: randomUUID(),
          eventType: 'ORDER_RESERVED',
          payload: { orderId: request.orderId, reserved: cash.amount },
          occurredAt: RESERVED_AT,
          orderId: request.orderId,
          sessionReference: `pseudonym-${account.sessionId}`,
        });
        await tx.outbox.append({
          id: randomUUID(),
          eventId: randomUUID(),
          sessionId: account.sessionId,
          streamSequence: 1n,
          eventType: 'ORDER_RESERVED',
          payload: { orderId: request.orderId },
        });
      });
    },

    async partialFill(request) {
      const account = request.account;
      const feeModel = feeModelFor(account.market);
      const execution = calculateExecution(
        {
          id: request.orderId,
          side: 'BUY',
          type: 'LIMIT',
          market: account.market,
          currency: account.currency,
          symbol: account.symbol,
          quantity: request.quantity,
          filledQuantity: '0',
          limitPrice: request.limitPrice,
        },
        {
          symbol: account.symbol,
          market: account.market,
          currency: account.currency,
          bids: [
            {
              price: account.market === 'KR' ? '69999' : '185.49',
              volume: request.fillQuantity,
            },
          ],
          asks: [{ price: request.limitPrice, volume: request.fillQuantity }],
        },
        feeModel,
        {
          referenceMid: request.limitPrice,
          maxDeviationBps: PROTECTION_BPS,
        },
      );
      const fill = onlyFill(execution.fills, request.fillQuantity);
      const remainingFee = feeModel.calculate({
        market: account.market,
        side: 'BUY',
        price: request.limitPrice,
        quantity: execution.unfilledQuantity,
      });
      const remainingPlan = planReservation({
        id: request.orderId,
        status: 'PARTIALLY_FILLED',
        side: 'BUY',
        type: 'LIMIT',
        currency: account.currency,
        symbol: account.symbol,
        quantity: request.quantity,
        filledQuantity: execution.filledQuantity,
        limitPrice: request.limitPrice,
        estimatedFee: remainingFee,
      });
      const remainingCash = remainingPlan.cash;
      if (remainingCash === undefined) {
        throw new Error('a partially filled BUY must keep a cash reservation');
      }
      const position = applyFillToPosition(
        {
          symbol: account.symbol,
          quantity: '0',
          totalCost: '0',
          realizedPnl: '0',
        },
        {
          symbol: account.symbol,
          side: 'BUY',
          price: fill.price,
          quantity: fill.quantity,
          fee: fill.fee,
        },
      );

      await target.transaction().execute(async (executor) => {
        const connection = ledgerConnection(executor);
        const accounts = createAccountRepository(connection);
        const orders = createOrderRepository(connection);
        const audit = createAuditRepository(connection);
        const outbox = createOutboxRepository(connection);

        await lockScenarioSession(connection, account.sessionId);
        const wallet = await accounts.lockWallet({
          sessionId: account.sessionId,
          currency: account.currency,
        });
        if (wallet === undefined) {
          throw new Error(`session ${account.sessionId} holds no wallet`);
        }
        const existingPosition = await accounts.lockPosition({
          sessionId: account.sessionId,
          marketCode: account.market,
          symbol: account.symbol,
        });
        if (existingPosition !== undefined) {
          throw new Error('the golden scenario must start without a position');
        }

        const released = releaseReservation(wallet, execution.netAmount);
        if (released.reserved !== remainingCash.amount) {
          throw new Error('fill settlement disagrees with remaining reserve');
        }
        connection.acquireLock({
          table: 'wallets',
          key: compositeLockKey(account.sessionId, account.currency),
          strength: 'NO_KEY_UPDATE',
        });
        const walletUpdate = await sql<{ version: string }>`
          update wallets
          set total = total - ${execution.netAmount}::numeric,
              available = ${released.available}::numeric
                - ${execution.netAmount}::numeric,
              reserved = ${released.reserved},
              version = version + 1
          where id = ${wallet.id} and version = ${wallet.version}
          returning version
        `.execute(executor);
        if (walletUpdate.rows.length !== 1) {
          throw new Error('the locked wallet changed before fill settlement');
        }

        await sql`
          insert into positions (
            id, session_id, market_code, symbol, total_quantity,
            available_quantity, reserved_quantity, average_cost
          ) values (
            ${randomUUID()}, ${account.sessionId}, ${account.market},
            ${account.symbol}, ${position.quantity}, ${position.quantity}, '0',
            ${position.totalCost}::numeric / ${position.quantity}::numeric
          )
        `.execute(executor);

        const order = await orders.lock(request.orderId);
        if (order === undefined || order.sessionId !== account.sessionId) {
          throw new Error(`order ${request.orderId} does not exist`);
        }
        await orders.update({
          id: request.orderId,
          expectedVersion: order.version,
          status: 'PARTIALLY_FILLED',
          filledQuantity: execution.filledQuantity,
        });

        const reservationUpdate = await sql<{ id: string }>`
          update reservations
          set amount = ${remainingCash.amount}, version = version + 1
          where order_id = ${request.orderId} and not released
          returning id
        `.execute(executor);
        if (reservationUpdate.rows.length !== 1) {
          throw new Error('the order must have one live cash reservation');
        }

        await sql`
          insert into fills (
            id, order_id, price, quantity, fee, slippage, occurred_at
          ) values (
            ${randomUUID()}, ${request.orderId}, ${fill.price}, ${fill.quantity},
            ${fill.fee}, ${execution.slippageAmount}, ${PARTIALLY_FILLED_AT}
          )
        `.execute(executor);
        await audit.append({
          id: randomUUID(),
          eventType: 'ORDER_PARTIALLY_FILLED',
          payload: {
            orderId: request.orderId,
            quantity: fill.quantity,
            price: fill.price,
            fee: fill.fee,
          },
          occurredAt: PARTIALLY_FILLED_AT,
          orderId: request.orderId,
          sessionReference: `pseudonym-${account.sessionId}`,
        });
        await outbox.append({
          id: randomUUID(),
          eventId: randomUUID(),
          sessionId: account.sessionId,
          streamSequence: 2n,
          eventType: 'ORDER_PARTIALLY_FILLED',
          payload: { orderId: request.orderId, quantity: fill.quantity },
        });
      });
    },

    async cancel(request) {
      const account = request.account;
      await target.transaction().execute(async (executor) => {
        const connection = ledgerConnection(executor);
        const accounts = createAccountRepository(connection);
        const orders = createOrderRepository(connection);
        const audit = createAuditRepository(connection);
        const outbox = createOutboxRepository(connection);

        await lockScenarioSession(connection, account.sessionId);
        const wallet = await accounts.lockWallet({
          sessionId: account.sessionId,
          currency: account.currency,
        });
        if (wallet === undefined) {
          throw new Error(`session ${account.sessionId} holds no wallet`);
        }
        const order = await orders.lock(request.orderId);
        if (order === undefined || order.sessionId !== account.sessionId) {
          throw new Error(`order ${request.orderId} does not exist`);
        }

        const released = releaseReservation(wallet, wallet.reserved);
        connection.acquireLock({
          table: 'wallets',
          key: compositeLockKey(account.sessionId, account.currency),
          strength: 'NO_KEY_UPDATE',
        });
        const walletUpdate = await sql<{ version: string }>`
          update wallets
          set available = ${released.available},
              reserved = ${released.reserved},
              version = version + 1
          where id = ${wallet.id} and version = ${wallet.version}
          returning version
        `.execute(executor);
        if (walletUpdate.rows.length !== 1) {
          throw new Error('the locked wallet changed before cancellation');
        }
        await orders.update({
          id: request.orderId,
          expectedVersion: order.version,
          status: 'CANCELLED',
        });

        const reservationUpdate = await sql<{ id: string }>`
          update reservations
          set released = true, version = version + 1
          where order_id = ${request.orderId} and not released
          returning id
        `.execute(executor);
        if (reservationUpdate.rows.length !== 1) {
          throw new Error('the order must have one live cash reservation');
        }

        await audit.append({
          id: randomUUID(),
          eventType: 'ORDER_CANCELLED',
          payload: { orderId: request.orderId, released: wallet.reserved },
          occurredAt: CANCELLED_AT,
          orderId: request.orderId,
          sessionReference: `pseudonym-${account.sessionId}`,
        });
        await outbox.append({
          id: randomUUID(),
          eventId: randomUUID(),
          sessionId: account.sessionId,
          streamSequence: 3n,
          eventType: 'ORDER_CANCELLED',
          payload: { orderId: request.orderId },
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario fixtures
// ---------------------------------------------------------------------------

/** A `LedgerConnection` over one explicit transaction, with the real guard. */
function ledgerConnection(executor: LedgerTransaction): LedgerConnection {
  return { executor, ...createLockOrderGuard(undefined, undefined) };
}

async function insertSession(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into anonymous_sessions (id, token_hash, expires_at)
    values (${id}, ${`token-hash-${id}`}, now() + interval '1 hour')
  `.execute(db);
  return id;
}

async function insertWallet(
  sessionId: string,
  currency: Currency,
  total: DecimalString,
): Promise<void> {
  await sql`
    insert into wallets (id, session_id, currency, total, available, reserved)
    values (${randomUUID()}, ${sessionId}, ${currency}, ${total}, ${total}, '0')
  `.execute(db);
}

interface GoldenScenario {
  readonly name: string;
  readonly market: Market;
  readonly currency: Currency;
  readonly symbol: string;
  readonly walletTotal: DecimalString;
  readonly quantity: Quantity;
  readonly limitPrice: DecimalString;
  readonly fillQuantity: Quantity;
  /** The balances the document asserts, checked digit for digit below. */
  readonly expected: {
    readonly reserved: DecimalString;
    readonly fillFee: DecimalString;
    readonly cashOut: DecimalString;
    readonly totalAfterFill: DecimalString;
    readonly reservedAfterFill: DecimalString;
    readonly availableAfterFill: DecimalString;
    readonly availableAfterCancel: DecimalString;
  };
}

const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  {
    name: 'KRW',
    market: 'KR',
    currency: 'KRW',
    symbol: '005930',
    walletTotal: '1000000',
    quantity: '10',
    limitPrice: '70000',
    fillQuantity: '4',
    expected: {
      reserved: '700105',
      fillFee: '42',
      cashOut: '280042',
      totalAfterFill: '719958',
      reservedAfterFill: '420063',
      availableAfterFill: '299895',
      availableAfterCancel: '719958',
    },
  },
  {
    name: 'USD',
    market: 'US',
    currency: 'USD',
    symbol: 'AAPL',
    walletTotal: '10000.00',
    quantity: '10',
    limitPrice: '185.50',
    fillQuantity: '4',
    expected: {
      reserved: '1859.64',
      fillFee: '1.86',
      cashOut: '743.86',
      totalAfterFill: '9256.14',
      reservedAfterFill: '1115.78',
      availableAfterFill: '8140.36',
      availableAfterCancel: '9256.14',
    },
  },
];

async function seedAccount(scenario: GoldenScenario): Promise<ScenarioAccount> {
  const sessionId = await insertSession();
  await insertWallet(sessionId, scenario.currency, scenario.walletTotal);
  return {
    sessionId,
    market: scenario.market,
    currency: scenario.currency,
    symbol: scenario.symbol,
    walletTotal: scenario.walletTotal,
  };
}

/**
 * The scenario of the plan: reserve, then a partial fill, then a cancel of the
 * remainder. Named as the plan names it so a reader can match the two.
 */
async function exerciseReservePartialFillAndCancel(
  driver: LedgerScenarioDriver,
  account: ScenarioAccount,
  scenario: GoldenScenario,
): Promise<{
  readonly orderId: string;
  readonly afterReserve: AccountLedger;
  readonly afterPartialFill: AccountLedger;
  readonly afterCancel: AccountLedger;
}> {
  const orderId = randomUUID();
  await driver.reserve({
    account,
    orderId,
    quantity: scenario.quantity,
    limitPrice: scenario.limitPrice,
  });
  const afterReserve = await readAccountLedger(db, account.sessionId);
  await driver.partialFill({
    account,
    orderId,
    quantity: scenario.quantity,
    limitPrice: scenario.limitPrice,
    fillQuantity: scenario.fillQuantity,
  });
  const afterPartialFill = await readAccountLedger(db, account.sessionId);
  await driver.cancel({ account, orderId });
  const afterCancel = await readAccountLedger(db, account.sessionId);
  return { orderId, afterReserve, afterPartialFill, afterCancel };
}

function expectGoldenLegSnapshots(
  scenario: GoldenScenario,
  legs: Awaited<ReturnType<typeof exerciseReservePartialFillAndCancel>>,
): void {
  const { orderId, afterReserve, afterPartialFill, afterCancel } = legs;
  const orderIdentity = {
    id: orderId,
    side: 'BUY',
    symbol: scenario.symbol,
    quantity: scenario.quantity,
  };
  const cashReservationIdentity = {
    orderId,
    kind: 'CASH',
    currency: scenario.currency,
    marketCode: null,
    symbol: null,
  };

  expect(afterReserve.wallets).toEqual([
    {
      currency: scenario.currency,
      total: scenario.walletTotal,
      available: scenario.expected.availableAfterFill,
      reserved: scenario.expected.reserved,
    },
  ]);
  expect(afterReserve.positions).toEqual([]);
  expect(afterReserve.fills).toEqual([]);
  expect(afterReserve.orders).toEqual([
    { ...orderIdentity, filledQuantity: '0', status: 'OPEN' },
  ]);
  expect(afterReserve.reservations).toEqual([
    {
      ...cashReservationIdentity,
      amount: scenario.expected.reserved,
      released: false,
    },
  ]);
  expect(afterReserve.auditEventTypes).toEqual(['ORDER_RESERVED']);

  expect(afterPartialFill.wallets).toEqual([
    {
      currency: scenario.currency,
      total: scenario.expected.totalAfterFill,
      available: scenario.expected.availableAfterFill,
      reserved: scenario.expected.reservedAfterFill,
    },
  ]);
  expect(afterPartialFill.positions).toEqual([
    {
      marketCode: scenario.market,
      symbol: scenario.symbol,
      total: scenario.fillQuantity,
      available: scenario.fillQuantity,
      reserved: '0',
    },
  ]);
  expect(afterPartialFill.fills).toEqual([
    {
      orderId,
      side: 'BUY',
      currency: scenario.currency,
      marketCode: scenario.market,
      symbol: scenario.symbol,
      price: scenario.limitPrice,
      quantity: scenario.fillQuantity,
      fee: scenario.expected.fillFee,
    },
  ]);
  expect(format(cashOutflow(afterPartialFill.fills[0] as FillLedgerRow))).toBe(
    scenario.expected.cashOut,
  );
  expect(afterPartialFill.orders).toEqual([
    {
      ...orderIdentity,
      filledQuantity: scenario.fillQuantity,
      status: 'PARTIALLY_FILLED',
    },
  ]);
  expect(afterPartialFill.reservations).toEqual([
    {
      ...cashReservationIdentity,
      amount: scenario.expected.reservedAfterFill,
      released: false,
    },
  ]);
  expect(afterPartialFill.auditEventTypes).toEqual([
    'ORDER_RESERVED',
    'ORDER_PARTIALLY_FILLED',
  ]);

  expect(afterCancel.wallets).toEqual([
    {
      currency: scenario.currency,
      total: scenario.expected.totalAfterFill,
      available: scenario.expected.availableAfterCancel,
      reserved: '0',
    },
  ]);
  expect(afterCancel.positions).toEqual(afterPartialFill.positions);
  expect(afterCancel.fills).toEqual(afterPartialFill.fills);
  expect(afterCancel.orders).toEqual([
    {
      ...orderIdentity,
      filledQuantity: scenario.fillQuantity,
      status: 'CANCELLED',
    },
  ]);
  expect(afterCancel.reservations).toEqual([
    {
      ...cashReservationIdentity,
      amount: scenario.expected.reservedAfterFill,
      released: true,
    },
  ]);
  expect(afterCancel.auditEventTypes).toEqual([
    'ORDER_RESERVED',
    'ORDER_PARTIALLY_FILLED',
    'ORDER_CANCELLED',
  ]);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);
  await ensureAuditPartitions(db, new Date('2026-08-22T00:00:00.000Z'));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

afterEach(async () => {
  await sql`truncate table anonymous_sessions cascade`.execute(db);
  await sql`truncate table audit_events`.execute(db);
});

// ---------------------------------------------------------------------------
// 3. The contract
// ---------------------------------------------------------------------------

function runLedgerContract(
  name: string,
  driverFactory: (target: Database) => LedgerScenarioDriver,
): void {
  describe(name, () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      it(
        `preserves the independent ledger equation across reserve, partial fill, and cancel in ${scenario.name}`,
        async () => {
          const account = await seedAccount(scenario);
          const driver = driverFactory(db);

          const before = await readAccountLedger(db, account.sessionId);
          const legs = await exerciseReservePartialFillAndCancel(
            driver,
            account,
            scenario,
          );

          expectGoldenLegSnapshots(scenario, legs);

          expect(brokenEquations(before, legs.afterReserve)).toEqual([]);
          expect(
            brokenEquations(legs.afterReserve, legs.afterPartialFill),
          ).toEqual([]);
          expect(
            brokenEquations(legs.afterPartialFill, legs.afterCancel),
          ).toEqual([]);

          expect(brokenEquations(before, legs.afterCancel)).toEqual([]);
          expect(independentLedgerEquation(before, legs.afterCancel)).toEqual({
            balanced: true,
            delta: '0',
          });
        },
        TEST_TIMEOUT_MS,
      );
    }
  });
}

runLedgerContract('the Plan 1 ledger contract', createPlan1Driver);
