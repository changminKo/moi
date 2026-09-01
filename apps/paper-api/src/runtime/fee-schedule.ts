import { randomUUID } from 'node:crypto';
import {
  createFeeModel,
  currencyFor,
  DomainError,
  type FeeModel,
  type Market,
} from '@moi/trading-core';
import { sql } from 'kysely';
import type { FeeSchedules } from '../config.js';
import type { Database } from '../db/database.js';

/** KRW has no sub-unit; USD fees settle to cents. */
const ROUNDING_DECIMALS: Record<Market, number> = { KR: 0, US: 2 };
const ROUNDING_MODE = 'HALF_UP' as const;

export const feeModelVersionName = (version: number): string =>
  `fees-v${version}`;

/** The engine's fee model for one market, derived from the configured schedule. */
export function feeModelFor(fees: FeeSchedules, market: Market): FeeModel {
  const rates = fees[market];
  return createFeeModel({
    version: feeModelVersionName(fees.version),
    market,
    currency: currencyFor(market),
    commissionRate: rates.commissionRate,
    sellTaxRate: rates.sellTaxRate,
    roundingDecimals: ROUNDING_DECIMALS[market],
    roundingMode: ROUNDING_MODE,
  });
}

type Schedule = ReturnType<typeof scheduleFor>;

function sameSchedule(stored: unknown, expected: Schedule): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  const row = stored as Record<string, unknown>;
  return (
    row.commissionRate === expected.commissionRate &&
    row.sellTaxRate === expected.sellTaxRate &&
    row.currency === expected.currency &&
    row.roundingDecimals === expected.roundingDecimals
  );
}

function scheduleFor(fees: FeeSchedules, market: Market) {
  return {
    commissionRate: fees[market].commissionRate,
    sellTaxRate: fees[market].sellTaxRate,
    currency: currencyFor(market),
    roundingDecimals: ROUNDING_DECIMALS[market],
  };
}

/**
 * Records the configured schedule as a PUBLISHED `fee_model_versions` row per
 * market (idempotent) and returns the row ids fills reference. A configured
 * version number that already exists with *different* rates is refused: rate
 * changes are audited as a new version (architecture §fees), never rewritten.
 */
export async function publishFeeModelVersions(
  db: Database,
  fees: FeeSchedules,
): Promise<ReadonlyMap<Market, string>> {
  const ids = new Map<Market, string>();
  for (const market of ['KR', 'US'] as const) {
    const schedule = scheduleFor(fees, market);
    // Insert-or-ignore first, then validate whatever row now exists — the
    // winner's or ours — so two processes booting together (a leader handoff)
    // with different rates under one version cannot both proceed.
    await sql`
      insert into fee_model_versions (id, market_code, version_number, status, schedule, rounding_mode, published_at)
      values (${randomUUID()}::uuid, ${market}, ${fees.version}, 'PUBLISHED', ${JSON.stringify(schedule)}::jsonb, ${ROUNDING_MODE}, now())
      on conflict (market_code, version_number) do nothing
    `.execute(db);
    const row = (
      await sql<{
        id: string;
        schedule: unknown;
        status: string;
        rounding_mode: string;
      }>`
        select id::text, schedule, status, rounding_mode from fee_model_versions
        where market_code = ${market} and version_number = ${fees.version}
      `.execute(db)
    ).rows[0];
    if (row === undefined)
      throw new DomainError(
        'INVARIANT_VIOLATION',
        `fee schedule row for ${market} vanished`,
      );
    if (
      !sameSchedule(row.schedule, schedule) ||
      row.rounding_mode !== ROUNDING_MODE
    )
      throw new DomainError(
        'INVARIANT_VIOLATION',
        `fee schedule ${feeModelVersionName(fees.version)} for ${market} is already published with different rates; bump FEE_SCHEDULE_VERSION`,
      );
    if (row.status !== 'PUBLISHED')
      await sql`
        update fee_model_versions set status = 'PUBLISHED', published_at = now(), version = version + 1
        where id = ${row.id}::uuid and status <> 'PUBLISHED'
      `.execute(db);
    ids.set(market, row.id);
  }
  return ids;
}
