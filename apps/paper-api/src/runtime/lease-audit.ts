import { randomUUID } from 'node:crypto';
import type {
  LeaseAuditContext,
  LeaseAuditPort,
  LeaseConnection,
} from '../market-data/leader-lease.js';

const INSERT = `insert into audit_events (
      id, session_reference, order_id, event_type, payload, occurred_at
    ) values ($1, null, null, $2, $3::jsonb, now())`;

async function insert(
  query: LeaseConnection['query'],
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(INSERT, [randomUUID(), eventType, JSON.stringify(payload)]);
}

/**
 * Writes LEADER_ACQUIRED / LEADER_RELEASED on the lease connection itself so the
 * audit row and the `leader_epochs` change commit in one PostgreSQL transaction
 * (§5.4). Same columns and JSON rules as `appendAuditEvent`; no token or client
 * id ever enters the payload.
 */
export const leaseAuditPort: LeaseAuditPort = {
  recordAcquired: (query, ctx: LeaseAuditContext) =>
    insert(query, 'LEADER_ACQUIRED', {
      market: ctx.market,
      epoch: ctx.epoch.toString(),
      fencingToken: ctx.fencingToken.toString(),
      leaderId: ctx.leaderId,
    }),
  recordReleased: (query, ctx: LeaseAuditContext) =>
    insert(query, 'LEADER_RELEASED', {
      market: ctx.market,
      epoch: ctx.epoch.toString(),
      leaderId: ctx.leaderId,
    }),
};
