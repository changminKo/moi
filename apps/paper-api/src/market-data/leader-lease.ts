import { randomUUID } from 'node:crypto';
import type { Market } from '@skipjack/trading-core';
import { Client, type PoolClient } from 'pg';

export interface LeaseConnection {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
  end?(): Promise<void>;
  release?(): void;
}

export interface LeaderLeaseOptions {
  readonly connectionString?: string;
  readonly leaderId?: string;
  readonly clientFactory?: () => Promise<LeaseConnection>;
}

type LeaseDatabase = {
  readonly __leaderLeaseClientFactory?: () => Promise<LeaseConnection>;
};

/** A process-local admission latch backed by one PostgreSQL session. */
export class LeaderLease {
  readonly market: Market;
  readonly epoch: bigint;
  readonly fencingToken: bigint;
  readonly connection: LeaseConnection;
  #held = true;
  #released = false;

  private constructor(
    market: Market,
    epoch: bigint,
    token: bigint,
    connection: LeaseConnection,
  ) {
    this.market = market;
    this.epoch = epoch;
    this.fencingToken = token;
    this.connection = connection;
    const loseLease = (): void => {
      this.#held = false;
    };
    connection.on('error', loseLease);
    connection.on('end', loseLease);
  }

  get isHeld(): boolean {
    return this.#held && !this.#released;
  }

  static async acquire(
    market: Market,
    options?: LeaderLeaseOptions,
  ): Promise<LeaderLease>;
  static async acquire(
    _db: unknown,
    market: Market,
    options?: LeaderLeaseOptions,
  ): Promise<LeaderLease>;
  static async acquire(
    marketOrDb: Market | unknown,
    optionsOrMarket: LeaderLeaseOptions | Market = {},
    maybeOptions: LeaderLeaseOptions = {},
  ): Promise<LeaderLease> {
    const market = (
      typeof marketOrDb === 'string' ? marketOrDb : optionsOrMarket
    ) as Market;
    const options =
      typeof marketOrDb === 'string'
        ? (optionsOrMarket as LeaderLeaseOptions)
        : maybeOptions;
    const databaseFactory =
      typeof marketOrDb === 'string'
        ? undefined
        : (marketOrDb as LeaseDatabase).__leaderLeaseClientFactory;
    const connection = await openConnection(options, databaseFactory);
    try {
      await connection.query('begin');
      await connection.query('select pg_advisory_lock(hashtext($1))', [market]);
      const result = await connection.query(
        `insert into leader_epochs (id, market_code, epoch, fencing_token, leader_id)
         values ($1, $2, 1, 1, $3)
         on conflict (market_code) do update set
           epoch = leader_epochs.epoch + 1,
           fencing_token = leader_epochs.fencing_token + 1,
           leader_id = excluded.leader_id,
           acquired_at = now(), version = leader_epochs.version + 1
         returning epoch, fencing_token`,
        [randomUUID(), market, options.leaderId ?? randomUUID()],
      );
      await connection.query('commit');
      const row = result.rows[0];
      if (row === undefined)
        throw new Error('leader epoch update returned no row');
      return new LeaderLease(
        market,
        BigInt(String(row.epoch)),
        BigInt(String(row.fencing_token)),
        connection,
      );
    } catch (error) {
      try {
        await connection.query('rollback');
      } catch {
        /* preserve acquisition failure */
      }
      await closeConnection(connection);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.#held = false;
    try {
      await this.connection.query('select pg_advisory_unlock(hashtext($1))', [
        this.market,
      ]);
    } finally {
      await closeConnection(this.connection);
    }
  }
}

async function openConnection(
  options: LeaderLeaseOptions,
  databaseFactory?: () => Promise<LeaseConnection>,
): Promise<LeaseConnection> {
  if (databaseFactory !== undefined) return databaseFactory();
  if (options.clientFactory !== undefined) return options.clientFactory();
  const client = new Client({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
  });
  await client.connect();
  return client as unknown as LeaseConnection;
}

async function closeConnection(connection: LeaseConnection): Promise<void> {
  if (connection.end !== undefined) await connection.end();
  else connection.release?.();
}

export type { PoolClient };
