import { DomainError } from '@moi/trading-core';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
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
 * The Kysely handle bound to one open transaction. This is a persistence-layer
 * type: repositories receive it, and no application service ever does. The unit
 * of work is what keeps it that way.
 */
export type LedgerTransaction = Transaction<LedgerDatabase>;

/**
 * Copies a caller-supplied input into a frozen, null-prototype object.
 *
 * Repository inputs cross an untrusted boundary: a caller may hand over an
 * object whose fields are accessors, a Proxy, or a plain object inheriting
 * values from a polluted `Object.prototype`. Reading each field exactly once
 * into a data property means the value a repository validated is the value it
 * writes, and the null prototype means an absent field cannot be inherited
 * from anywhere. Call it once, at the top of the function, and read only the
 * result afterwards.
 */
export function snapshotInput<T extends object>(fields: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, fields));
}

/**
 * Turns "the versioned update matched no row" into the shared domain error, and
 * returns the row it did match.
 *
 * Every versioned update is written as `... where id = $1 and version = $2
 * returning version`, so an empty result means the row was concurrently
 * modified, deleted, or never existed. All three are the same answer to the
 * caller: the state it planned against is gone. Returning the row means a
 * caller never needs a fallback for a case this function has already ruled out.
 */
export function assertVersionedUpdate<T>(
  rows: readonly T[],
  subject: string,
): T {
  const row = rows[0];
  if (row === undefined) {
    throw new DomainError(
      'ORDER_STATE_CONFLICT',
      `${subject} was not updated at its expected version`,
    );
  }
  return row;
}

/**
 * Renders a caller-supplied value as the JSON text a `jsonb` column stores.
 *
 * `unknown` at a boundary includes values JSON cannot represent: `undefined` and
 * a function both stringify to `undefined` rather than to text, and a circular
 * structure or a bigint throws. None of those is a database failure, so none of
 * them should reach the driver — a caller that supplies one gets the same domain
 * error it would get for any other unusable input, and the value is read exactly
 * once on the way there.
 */
export function toJsonText(value: unknown, subject: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `${subject} cannot be represented as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (text === undefined) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `${subject} cannot be represented as JSON`,
    );
  }
  return text;
}

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
  // `pg` reports the same failure through two paths, and each covers a window
  // the other does not:
  //
  //   * The pool reports a client that died while it was checked in. That is
  //     the only path `pg-pool` provides, and it is not enough: `pg-pool`
  //     removes its own client listener on acquire and restores it on release,
  //     so a client that dies mid-query has no listener at all. The in-flight
  //     query does receive the failure, but the socket's close event arrives
  //     afterwards, by which time the pool has discarded the client — and `pg`
  //     then emits 'error' on a client nobody listens to, which Node turns into
  //     an uncaught exception and a dead process.
  //   * A listener attached on connect is never removed by the pool, so it
  //     closes exactly that window.
  //
  // Both paths carry the same Error instance, so identity is what
  // distinguishes "the other path already reported this" from a second, real
  // failure: the reporter sees every failure exactly once.
  const reported = new WeakSet<Error>();
  const reportOnce = (error: Error): void => {
    if (reported.has(error)) {
      return;
    }
    reported.add(error);
    onPoolError(error);
  };

  pool.on('error', reportOnce);
  pool.on('connect', (client) => {
    client.on('error', reportOnce);
  });

  const database = new Kysely<LedgerDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
  // A lease must pin one physical client for the lifetime of an advisory
  // lock. Keep the pool private to the DB abstraction while exposing only the
  // narrow factory used by the market-data lease.
  Object.defineProperty(database, '__leaderLeaseClientFactory', {
    value: () => pool.connect(),
    enumerable: false,
  });
  return database;
}
