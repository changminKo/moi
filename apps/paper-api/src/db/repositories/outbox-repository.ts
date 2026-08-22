import { sql } from 'kysely';
import { snapshotInput, toJsonText } from '../database.js';
import { compositeLockKey, sequenceLockKey } from '../lock-order.js';
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
 *
 * The table is append-only and nothing ever locks a row in it, but the insert's
 * foreign key still takes a `for key share` lock on the session row, so that
 * lock is declared — and `(session_id, stream_sequence)` is a key two concurrent
 * requests for one session can legitimately compute, so the index entry is
 * claimed too. Without that claim a transaction holding a wallet could wait on
 * another transaction's uncommitted event while that one waits for the wallet:
 * a wait on a transaction id, which no row-lock order can see. The sequence is
 * rendered zero-padded so the claim keys of one session sort numerically.
 *
 * `event_id` is a fresh uuid per event, so two concurrent requests never
 * compute the same one and it needs no claim (see LEDGER_UNIQUE_INDEXES).
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
    payload: toJsonText(input.payload, 'the outbox payload'),
  });
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: event.sessionId,
    strength: 'KEY_SHARE',
  });
  connection.claimUniqueKey({
    table: 'outbox_events',
    key: compositeLockKey(
      event.sessionId,
      sequenceLockKey(event.streamSequence),
    ),
    index: 'outbox_events_session_id_stream_sequence_key',
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
