import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/**
 * The ledger schema is owned by the SQL migrations in `./migrations`. Task 7
 * exposes it to Kysely as an open table map: the migration runner and the
 * integration suite address tables through raw SQL, and the typed row
 * interfaces arrive with the repositories that consume this connection.
 */
export interface LedgerDatabase {
  readonly [table: string]: Record<string, unknown>;
}

export type Database = Kysely<LedgerDatabase>;

/**
 * Receives an error that belongs to no caller: a pooled client failed while it
 * was checked in. Task 8 passes the application logger; the default keeps the
 * error visible until one exists.
 */
export type PoolErrorReporter = (error: Error) => void;

const POOL_MAX_CONNECTIONS = 10;
const CONNECTION_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;

const reportToStandardError: PoolErrorReporter = (error) => {
  console.error('[paper-api] idle PostgreSQL client failed', error);
};

export function createDatabase(
  url: string,
  onPoolError: PoolErrorReporter = reportToStandardError,
): Database {
  const pool = new Pool({
    connectionString: url,
    max: POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
  });

  // `pg` emits 'error' on the pool when a client that is checked in dies: a
  // PostgreSQL restart, a failover, or a proxy reaping idle connections. With
  // no listener Node rethrows it as an uncaught exception and the process
  // exits, instead of letting the pool discard the dead client and reconnect on
  // the next query.
  pool.on('error', onPoolError);

  return new Kysely<LedgerDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
}
