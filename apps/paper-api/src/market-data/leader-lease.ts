import { randomUUID } from 'node:crypto';
import type { Market } from '@skipjack/trading-core';
import { Client, type PoolClient } from 'pg';
import type { MetricsRegistry } from '../observability/metrics.js';

export interface LeaseConnection {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
  end?(): Promise<void>;
  release?(): void;
}

export type LeaseState =
  | 'ACQUIRING'
  | 'HELD'
  | 'RELEASING'
  | 'RELEASED'
  | 'LOST';

export interface LeaseAuditContext {
  readonly market: Market;
  readonly epoch: bigint;
  readonly fencingToken: bigint;
  readonly leaderId: string;
}

export interface LeaseAuditPort {
  recordAcquired(
    query: LeaseConnection['query'],
    ctx: LeaseAuditContext,
  ): Promise<void>;
  recordReleased(
    query: LeaseConnection['query'],
    ctx: LeaseAuditContext,
  ): Promise<void>;
}

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface LeaderLeaseOptions {
  readonly connectionString?: string;
  readonly leaderId?: string;
  readonly clientFactory?: () => Promise<LeaseConnection>;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly audit?: LeaseAuditPort;
  readonly onLost?: (market: Market) => void;
  readonly log?: LogFn;
  readonly metrics?: MetricsRegistry;
}

/** Fixed, jitter-free polling period for `pg_try_advisory_lock` (§5.4). */
export const LEASE_POLL_INTERVAL_MS = 250;
const WAITING_LOG_EVERY_MS = 10_000;

export class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'lease acquisition aborted') {
    super(message);
  }
}

const noopAudit: LeaseAuditPort = {
  recordAcquired: async () => undefined,
  recordReleased: async () => undefined,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * One fenced leader lease for one market, backed by one dedicated PostgreSQL
 * session holding a session-level advisory lock (§5.4).
 *
 * - Acquisition polls `pg_try_advisory_lock` every 250 ms and is cancellable
 *   through `signal`; the blocking `pg_advisory_lock` is never used.
 * - The `leader_epochs` upsert and the LEADER_ACQUIRED audit commit in one
 *   transaction before `acquire` resolves.
 * - `release()` marks `released_at` and writes LEADER_RELEASED under the lock,
 *   then unlocks in `finally`.
 * - Unintentional connection loss is reported once, only from HELD.
 */
export class LeaderLease {
  readonly market: Market;
  readonly epoch: bigint;
  readonly fencingToken: bigint;
  readonly leaderId: string;
  readonly connection: LeaseConnection;
  readonly #audit: LeaseAuditPort;
  readonly #log: LogFn | undefined;
  readonly #onLost: ((market: Market) => void) | undefined;
  #state: LeaseState = 'HELD';

  private constructor(
    ctx: LeaseAuditContext,
    connection: LeaseConnection,
    options: LeaderLeaseOptions,
  ) {
    this.market = ctx.market;
    this.epoch = ctx.epoch;
    this.fencingToken = ctx.fencingToken;
    this.leaderId = ctx.leaderId;
    this.connection = connection;
    this.#audit = options.audit ?? noopAudit;
    this.#log = options.log;
    this.#onLost = options.onLost;
    const reportLost = (): void => this.#reportLost();
    connection.on('error', reportLost);
    connection.on('end', reportLost);
  }

  get state(): LeaseState {
    return this.#state;
  }

  get isHeld(): boolean {
    return this.#state === 'HELD';
  }

  static async acquire(
    market: Market,
    options: LeaderLeaseOptions = {},
  ): Promise<LeaderLease> {
    const leaderId = options.leaderId ?? randomUUID();
    const signal = options.signal;
    const pollMs = options.pollIntervalMs ?? LEASE_POLL_INTERVAL_MS;
    const audit = options.audit ?? noopAudit;
    if (signal?.aborted) throw new AbortError();
    const connection = await openConnection(market, options);
    const startedAt = Date.now();
    let polls = 0;
    let lastWaitingLog = 0;
    try {
      // Phase 1: cancellable polling for the session-level advisory lock.
      for (;;) {
        if (signal?.aborted) throw new AbortError();
        const result = await connection.query(
          'select pg_try_advisory_lock(hashtext($1))',
          [market],
        );
        polls += 1;
        options.metrics?.counter('leader_lease_poll_total', { market });
        const locked = result.rows[0]?.pg_try_advisory_lock === true;
        if (locked) break;
        const waitedMs = Date.now() - startedAt;
        options.metrics?.gauge('leader_lease_wait_seconds', waitedMs / 1000, {
          market,
        });
        if (
          lastWaitingLog === 0 ||
          Date.now() - lastWaitingLog >= WAITING_LOG_EVERY_MS
        ) {
          lastWaitingLog = Date.now();
          options.log?.('lease.waiting', { market, leaderId, waitedMs, polls });
        }
        await sleep(pollMs, signal);
      }
      // Phase 2: abort/lock race — unlock immediately, write nothing.
      if (signal?.aborted) {
        await connection.query('select pg_advisory_unlock(hashtext($1))', [
          market,
        ]);
        options.log?.('lease.acquire_aborted', {
          market,
          leaderId,
          lockedThenUnlocked: true,
        });
        throw new AbortError();
      }
      // Phase 3: epoch upsert + LEADER_ACQUIRED in one transaction.
      let ctx: LeaseAuditContext;
      try {
        await connection.query('begin');
        const result = await connection.query(
          `insert into leader_epochs (id, market_code, epoch, fencing_token, leader_id, released_at)
           values ($1, $2, 1, 1, $3, null)
           on conflict (market_code) do update set
             epoch = leader_epochs.epoch + 1,
             fencing_token = leader_epochs.fencing_token + 1,
             leader_id = excluded.leader_id,
             acquired_at = now(),
             released_at = null,
             version = leader_epochs.version + 1
           returning epoch, fencing_token`,
          [randomUUID(), market, leaderId],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error('leader epoch update returned no row');
        ctx = {
          market,
          epoch: BigInt(String(row.epoch)),
          fencingToken: BigInt(String(row.fencing_token)),
          leaderId,
        };
        await audit.recordAcquired(
          (text, values) => connection.query(text, values),
          ctx,
        );
        await connection.query('commit');
      } catch (error) {
        try {
          await connection.query('rollback');
        } catch {
          /* preserve acquisition failure */
        }
        try {
          await connection.query('select pg_advisory_unlock(hashtext($1))', [
            market,
          ]);
        } catch {
          /* connection may already be dead */
        }
        throw error;
      }
      options.metrics?.gauge('leader_lease_held', 1, { market });
      options.metrics?.gauge('leader_epoch', Number(ctx.epoch), { market });
      options.log?.('lease.acquired', {
        market,
        leaderId,
        epoch: ctx.epoch.toString(),
        waitedMs: Date.now() - startedAt,
        polls,
      });
      return new LeaderLease(ctx, connection, options);
    } catch (error) {
      await closeConnection(connection);
      throw error;
    }
  }

  /**
   * Under the still-held lock: begin → released_at → LEADER_RELEASED → commit;
   * then unlock; then close. Unlock and close always run.
   */
  async release(): Promise<void> {
    if (this.#state !== 'HELD') {
      if (this.#state === 'LOST') await closeConnection(this.connection);
      return;
    }
    this.#state = 'RELEASING';
    let auditPersisted = false;
    try {
      try {
        await this.connection.query('begin');
        await this.connection.query(
          `update leader_epochs set released_at = now()
           where market_code = $1 and leader_id = $2 and released_at is null`,
          [this.market, this.leaderId],
        );
        await this.#audit.recordReleased(
          (text, values) => this.connection.query(text, values),
          {
            market: this.market,
            epoch: this.epoch,
            fencingToken: this.fencingToken,
            leaderId: this.leaderId,
          },
        );
        await this.connection.query('commit');
        auditPersisted = true;
      } catch (error) {
        try {
          await this.connection.query('rollback');
        } catch {
          /* connection may already be dead */
        }
        this.#log?.('lease.release_mark_failed', {
          market: this.market,
          epoch: this.epoch.toString(),
          leaderId: this.leaderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      try {
        await this.connection.query('select pg_advisory_unlock(hashtext($1))', [
          this.market,
        ]);
      } catch {
        /* the lock dies with the session anyway */
      }
      this.#state = 'RELEASED';
      await closeConnection(this.connection);
    }
    this.#log?.('lease.released', {
      market: this.market,
      epoch: this.epoch.toString(),
      leaderId: this.leaderId,
      auditPersisted,
    });
  }

  /** Single sink for connection `error`/`end`; promotes to LOST only from HELD. */
  #reportLost(): void {
    if (this.#state !== 'HELD') return;
    this.#state = 'LOST';
    this.#log?.('lease.lost', {
      market: this.market,
      epoch: this.epoch.toString(),
      leaderId: this.leaderId,
    });
    this.#onLost?.(this.market);
  }
}

async function openConnection(
  market: Market,
  options: LeaderLeaseOptions,
): Promise<LeaseConnection> {
  if (options.clientFactory !== undefined) return options.clientFactory();
  const client = new Client({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
    application_name: `skipjack-lease-${market}-${options.leaderId ?? 'unknown'}`,
  });
  await client.connect();
  return client as unknown as LeaseConnection;
}

async function closeConnection(connection: LeaseConnection): Promise<void> {
  try {
    if (connection.end !== undefined) await connection.end();
    else connection.release?.();
  } catch {
    /* already closed */
  }
}

export type { PoolClient };
