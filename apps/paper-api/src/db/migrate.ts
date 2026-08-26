import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Kysely, sql } from 'kysely';
import {
  type Migration,
  type MigrationResult,
  Migrator,
} from 'kysely/migration';
import type { Database, LedgerDatabase } from './database.js';

const MIGRATION_NAMES = ['001_ledger', '002_audit_partitions'] as const;

const MIGRATIONS_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);
const SOURCE_MIGRATIONS_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'db',
  'migrations',
);

async function readMigration(name: string): Promise<string> {
  try {
    return await readFile(join(MIGRATIONS_DIRECTORY, `${name}.sql`), 'utf8');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    return await readFile(
      join(SOURCE_MIGRATIONS_DIRECTORY, `${name}.sql`),
      'utf8',
    );
  }
}

function sqlFileMigration(name: string): Migration {
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      const statements = await readMigration(name);
      await sql.raw(statements).execute(db);
    },
  };
}

/**
 * Applies every migration that the target database has not recorded yet.
 *
 * Idempotence is a property of the runner, not of the SQL: Kysely records each
 * applied migration, so a second call observes the recorded names and executes
 * nothing. The returned array therefore lists only migrations executed by this
 * call, and is empty when the database is already up to date.
 */
export async function migrateToLatest(
  db: Database,
): Promise<readonly MigrationResult[]> {
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: async () =>
        Object.fromEntries(
          MIGRATION_NAMES.map((name) => [name, sqlFileMigration(name)]),
        ),
    },
  });

  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    throw error;
  }
  return results ?? [];
}

function monthStart(date: Date, monthOffset: number): string {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthOffset, 1),
  );
  return start.toISOString().slice(0, 10);
}

async function ensurePartition(
  db: Kysely<LedgerDatabase>,
  month: string,
): Promise<string> {
  const result = await sql<{ ensure_audit_partition: string }>`
    select ensure_audit_partition(${month}::date)
  `.execute(db);
  const name = result.rows[0]?.ensure_audit_partition;
  if (name === undefined) {
    throw new Error(`ensure_audit_partition(${month}) returned no partition`);
  }
  return name;
}

/**
 * Creates the monthly `audit_events` partitions for `now` and the following
 * month. Both partitions are created inside one transaction, so a failure on
 * either month leaves the schema untouched, and an already-present partition is
 * left alone, which makes repeated calls no-ops.
 */
export async function ensureAuditPartitions(
  db: Database,
  now: Date,
): Promise<readonly string[]> {
  return await db.transaction().execute(async (trx) => {
    const current = await ensurePartition(trx, monthStart(now, 0));
    const next = await ensurePartition(trx, monthStart(now, 1));
    return [current, next];
  });
}
