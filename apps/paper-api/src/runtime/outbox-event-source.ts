import { sql } from 'kysely';
import type { Database } from '../db/database.js';
import type {
  DurableAccountEvent,
  DurableEventSource,
} from '../modules/stream/stream-session.js';

export interface OutboxEventSourceOptions {
  /**
   * Adds the session's portfolio snapshot to a replayed event's payload, the
   * same enrichment the live publisher applies, so a reconnecting browser can
   * patch its state from replay exactly as it would from live delivery.
   */
  readonly enrich?: (sessionId: string, payload: unknown) => Promise<unknown>;
}

/** Durable per-session event source over `outbox_events` / `account_sequences`. */
export function createOutboxEventSource(
  db: Database,
  options: OutboxEventSourceOptions = {},
): DurableEventSource {
  return {
    async latest(sessionId) {
      const result = await sql<{ latest: string }>`
        select coalesce(max(account_sequence), 0)::text as latest
        from account_sequences where session_id = ${sessionId}::uuid
      `.execute(db);
      return result.rows[0]?.latest ?? '0';
    },
    async oldest(sessionId) {
      const result = await sql<{ oldest: string | null }>`
        select min(stream_sequence)::text as oldest from outbox_events where session_id = ${sessionId}::uuid
      `.execute(db);
      return result.rows[0]?.oldest ?? undefined;
    },
    async replay(sessionId, afterSequence) {
      const after = afterSequence === undefined ? 0n : BigInt(afterSequence);
      const result = await sql<DurableAccountEvent>`
        select id::text, event_id::text as "eventId", session_id::text as "sessionId",
          stream_sequence::text as "accountSequence", event_type as "eventType",
          payload, created_at::text as "createdAt"
        from outbox_events
        where session_id = ${sessionId}::uuid and stream_sequence > ${after}
        order by stream_sequence
      `.execute(db);
      if (options.enrich === undefined) return result.rows;
      const enriched: DurableAccountEvent[] = [];
      for (const row of result.rows)
        enriched.push({
          ...row,
          payload: await options.enrich(sessionId, row.payload),
        });
      return enriched;
    },
  };
}
