import { sql } from 'kysely';
import type { LedgerTransaction } from '../../db/database.js';
import type { MetricsRegistry } from '../../observability/metrics.js';
import type { DurableAccountEvent } from './stream-session.js';

export type OutboxPollMode = 'periodic' | 'shutdown_drain';

export interface OutboxStore {
  claim(limit: number): Promise<readonly DurableAccountEvent[]>;
  markPublished(id: string): Promise<void>;
}
export interface OutboxPublisherOptions extends OutboxStore {
  readonly publish: (event: DurableAccountEvent) => Promise<void>;
  readonly batchSize?: number;
  readonly metrics?: MetricsRegistry;
}

export class OutboxPublisher {
  readonly #store: OutboxPublisherOptions;
  constructor(options: OutboxPublisherOptions) {
    this.#store = options;
  }
  /**
   * The claim is issued synchronously before the first `await`, and the
   * `outbox_claims_total{mode}` counter moves in the same synchronous step, so
   * a poll captured by `pauseScheduling()` can never claim again in its tail.
   */
  async pollOnce(
    options: { readonly mode: OutboxPollMode } = { mode: 'periodic' },
  ): Promise<{
    claimed: number;
    published: number;
    failed: number;
  }> {
    const claim = this.#store.claim(this.#store.batchSize ?? 100);
    this.#store.metrics?.counter('outbox_claims_total', { mode: options.mode });
    const rows = await claim;
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.#store.publish(row);
        await this.#store.markPublished(row.id);
        published += 1;
      } catch {
        failed += 1;
      }
    }
    return { claimed: rows.length, published, failed };
  }
}

/** Claiming is deliberately a short transaction: row locks are released before fan-out,
 * allowing a crash to redeliver and giving consumers the required at-least-once contract. */
export async function claimPendingOutbox(
  executor: LedgerTransaction,
  limit = 100,
): Promise<DurableAccountEvent[]> {
  const result = await sql<DurableAccountEvent>`
    select id::text, event_id::text as "eventId", session_id::text as "sessionId",
      stream_sequence::text as "accountSequence", event_type as "eventType",
      payload, created_at::text as "createdAt"
    from outbox_events where published_at is null
    order by created_at, id for update skip locked limit ${limit}
  `.execute(executor);
  return result.rows;
}

export async function markOutboxPublished(
  executor: LedgerTransaction,
  id: string,
): Promise<void> {
  await sql`update outbox_events set published_at = now() where id = ${id}::uuid and published_at is null`.execute(
    executor,
  );
}

export async function prunePublishedOutbox(
  executor: LedgerTransaction,
  batchSize = 1000,
): Promise<void> {
  await sql`delete from outbox_events where id in (select id from outbox_events where published_at < now() - interval '24 hours' order by published_at limit ${batchSize})`.execute(
    executor,
  );
}
