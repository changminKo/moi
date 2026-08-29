import { DomainError } from '@moi/trading-core';
import { sql } from 'kysely';
import type { Database } from '../db/database.js';

export interface LedgerInvariantCounts {
  readonly wallets: number;
  readonly positions: number;
  readonly orders: number;
  readonly reservations: number;
}

/**
 * §6.1 RESTORING invariant check. Runs the same wallet / position / order
 * checks the release drill uses, plus the reconciliation the schema cannot
 * express: every wallet's `reserved` equals the sum of its unreleased CASH
 * reservations, and every position's `reserved_quantity` the sum of its
 * unreleased POSITION reservations. Any violation is an `INVARIANT_VIOLATION`
 * and any query failure propagates — this check never degrades to a no-op.
 */
export async function verifyLedgerInvariants(
  db: Database,
): Promise<LedgerInvariantCounts> {
  const result = await sql<{
    wallets: number;
    positions: number;
    orders: number;
    reservations: number;
  }>`
    select
      (select count(*)::int from wallets
        where total < 0 or available < 0 or reserved < 0
           or total <> available + reserved) as wallets,
      (select count(*)::int from positions
        where total_quantity < 0 or available_quantity < 0 or reserved_quantity < 0
           or total_quantity <> available_quantity + reserved_quantity) as positions,
      (select count(*)::int from orders
        where quantity <= 0 or filled_quantity < 0 or filled_quantity > quantity) as orders,
      (
        (select count(*)::int from wallets w
          where w.reserved <> coalesce((
            select sum(r.amount) from reservations r
            where r.session_id = w.session_id and r.kind = 'CASH'
              and r.currency = w.currency and r.released = false), 0))
        +
        (select count(*)::int from positions p
          where p.reserved_quantity <> coalesce((
            select sum(r.amount) from reservations r
            where r.session_id = p.session_id and r.kind = 'POSITION'
              and r.market_code = p.market_code and r.symbol = p.symbol
              and r.released = false), 0))
      ) as reservations
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined)
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'invariant query returned no row',
    );
  const counts: LedgerInvariantCounts = {
    wallets: Number(row.wallets),
    positions: Number(row.positions),
    orders: Number(row.orders),
    reservations: Number(row.reservations),
  };
  const broken = Object.entries(counts).filter(([, n]) => n > 0);
  if (broken.length > 0)
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `ledger invariants violated: ${broken.map(([k, n]) => `${k}=${n}`).join(', ')}`,
    );
  return counts;
}
