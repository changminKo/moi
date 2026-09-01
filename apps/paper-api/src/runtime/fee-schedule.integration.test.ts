import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FEE_SCHEDULES } from '../config.js';
import { createDatabase, type Database } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { publishFeeModelVersions } from './fee-schedule.js';

/**
 * `publishFeeModelVersions` compares the schedule it would publish against the
 * row already in `fee_model_versions`, and refuses to start when a version
 * number is republished with different rates (rule 6). The `currency` it
 * derives from the market is one of the compared fields.
 *
 * That comparison is about to be re-pointed at a shared `currencyFor`. The
 * value will not change, but "the value does not change" is not the property
 * that matters here: what matters is that a row *already written to a real
 * database by the current code* is still accepted afterwards. If it is not,
 * the process refuses to boot and the release is blocked — which is why this
 * path gets a container and a stored row rather than two functions compared in
 * memory.
 *
 * The second test is what keeps the first honest. A positive-only check would
 * pass even if `sameSchedule` ignored `currency` altogether, and would then be
 * proving nothing about the field the refactor touches.
 */

const CONTAINER_TIMEOUT_MS = 180_000;

let container: StartedPostgreSqlContainer;
let database: Database;

/** The schedule shape as the current code writes it, spelled out rather than
 *  produced by the code under test: a test that re-derives the value it is
 *  checking cannot notice the derivation changing. */
const STORED_TODAY = {
  KR: {
    commissionRate: DEFAULT_FEE_SCHEDULES.KR.commissionRate,
    sellTaxRate: DEFAULT_FEE_SCHEDULES.KR.sellTaxRate,
    currency: 'KRW',
    roundingDecimals: 0,
  },
  US: {
    commissionRate: DEFAULT_FEE_SCHEDULES.US.commissionRate,
    sellTaxRate: DEFAULT_FEE_SCHEDULES.US.sellTaxRate,
    currency: 'USD',
    roundingDecimals: 2,
  },
} as const;

async function storeVersion(
  version: number,
  schedules: Readonly<Record<'KR' | 'US', unknown>>,
): Promise<Record<'KR' | 'US', string>> {
  const ids: Record<string, string> = {};
  for (const market of ['KR', 'US'] as const) {
    const id = randomUUID();
    ids[market] = id;
    await sql`
      insert into fee_model_versions (id, market_code, version_number, status, schedule, rounding_mode, published_at)
      values (${id}::uuid, ${market}, ${version}, 'PUBLISHED', ${JSON.stringify(schedules[market])}::jsonb, 'HALF_UP', now())
    `.execute(database);
  }
  return ids as Record<'KR' | 'US', string>;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  database = createDatabase(container.getConnectionUri());
  await migrateToLatest(database);
}, CONTAINER_TIMEOUT_MS);

// No cleanup between tests: a PUBLISHED row is immutable by database trigger
// ("published fee_model_versions rows are immutable"), which is the same rule
// 6 guarantee this path exists to uphold. Each test claims its own unused
// version number instead.

afterAll(async () => {
  await database?.destroy();
  await container?.stop();
});

describe('a fee schedule already published to a real database', () => {
  it('is accepted unchanged, and its rows are the ones fills go on referencing', async () => {
    const fees = { ...DEFAULT_FEE_SCHEDULES, version: 9001 };
    const stored = await storeVersion(fees.version, {
      KR: STORED_TODAY.KR,
      US: STORED_TODAY.US,
    });

    const ids = await publishFeeModelVersions(database, fees);

    // Not merely "did not throw": the same row ids come back, so fills keep
    // referencing the version that was already published rather than a new one.
    expect(ids.get('KR')).toBe(stored.KR);
    expect(ids.get('US')).toBe(stored.US);
  });

  it('is refused when the stored currency is not the one the market settles in', async () => {
    const fees = { ...DEFAULT_FEE_SCHEDULES, version: 9002 };
    await storeVersion(fees.version, {
      KR: { ...STORED_TODAY.KR, currency: 'USD' },
      US: STORED_TODAY.US,
    });

    await expect(publishFeeModelVersions(database, fees)).rejects.toThrow(
      /already published with different rates/,
    );
  });
});
