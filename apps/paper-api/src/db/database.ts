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

export function createDatabase(url: string): Database {
  return new Kysely<LedgerDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url }),
    }),
  });
}
