import { sql } from 'kysely';
import type { Database } from '../db/database.js';
import type {
  DurableAccountEvent,
  DurableEventSource,
} from '../modules/stream/stream-session.js';

/** Durable per-session event source over `outbox_events` / `account_sequences`. */
export function createOutboxEventSource(db: Database): DurableEventSource {
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
      return result.rows;
    },
  };
}
