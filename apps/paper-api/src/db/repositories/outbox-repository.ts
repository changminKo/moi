import { sql } from 'kysely';
import { snapshotInput } from '../database.js';
import type { LedgerConnection } from '../unit-of-work.js';

export interface OutboxEventInput {
  readonly id: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly streamSequence: bigint;
  readonly eventType: string;
  readonly payload: unknown;
}

export interface OutboxRepository {
  append(input: OutboxEventInput): Promise<void>;
}

/**
 * Appends one outbox row on the caller's transaction.
 *
 * The outbox is what makes "publish an event" part of the business mutation
 * instead of a second, unsynchronised write: the row is committed by the same
 * transaction, or it is not committed at all. `(session_id, stream_sequence)`
 * and `event_id` are unique in the schema, so a duplicate publish is refused by
 * PostgreSQL rather than by a check the application could forget.
 */
export async function appendOutboxEvent(
  connection: LedgerConnection,
  input: OutboxEventInput,
): Promise<void> {
  const event = snapshotInput({
    id: input.id,
    eventId: input.eventId,
    sessionId: input.sessionId,
    streamSequence: input.streamSequence,
    eventType: input.eventType,
    payload: JSON.stringify(input.payload),
  });

  await sql`
    insert into outbox_events (
      id, event_id, session_id, stream_sequence, event_type, payload
    ) values (
      ${event.id}, ${event.eventId}, ${event.sessionId},
      ${event.streamSequence}, ${event.eventType}, ${event.payload}::jsonb
    )
  `.execute(connection.executor);
}

export function createOutboxRepository(
  connection: LedgerConnection,
): OutboxRepository {
  return Object.freeze({
    append: (input: OutboxEventInput) => appendOutboxEvent(connection, input),
  });
}
