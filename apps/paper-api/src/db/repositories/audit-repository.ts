import { sql } from 'kysely';
import { snapshotInput } from '../database.js';
import type { LedgerConnection } from '../unit-of-work.js';

export interface AuditEventInput {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
  /** Pseudonymous session reference: audit history outlives the session. */
  readonly sessionReference?: string;
  readonly orderId?: string;
}

export interface AuditRepository {
  append(input: AuditEventInput): Promise<void>;
}

/**
 * Appends one audit row on the caller's transaction.
 *
 * `audit_events` is append-only and carries no version, so there is nothing to
 * lock and nothing to order: it only ever gains rows, and it gains them inside
 * the same transaction as the business mutation they describe.
 */
export async function appendAuditEvent(
  connection: LedgerConnection,
  input: AuditEventInput,
): Promise<void> {
  const event = snapshotInput({
    id: input.id,
    eventType: input.eventType,
    payload: JSON.stringify(input.payload),
    occurredAt: input.occurredAt,
    sessionReference: input.sessionReference ?? null,
    orderId: input.orderId ?? null,
  });

  await sql`
    insert into audit_events (
      id, session_reference, order_id, event_type, payload, occurred_at
    ) values (
      ${event.id}, ${event.sessionReference}, ${event.orderId},
      ${event.eventType}, ${event.payload}::jsonb, ${event.occurredAt}
    )
  `.execute(connection.executor);
}

export function createAuditRepository(
  connection: LedgerConnection,
): AuditRepository {
  return Object.freeze({
    append: (input: AuditEventInput) => appendAuditEvent(connection, input),
  });
}
