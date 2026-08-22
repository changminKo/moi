import { randomUUID } from 'node:crypto';
import { DomainError } from '@skipjack/trading-core';
import { sql } from 'kysely';
import {
  assertVersionedUpdate,
  snapshotInput,
  toJsonText,
} from '../database.js';
import type { LedgerConnection } from '../unit-of-work.js';

export interface IdempotencyKey {
  readonly sessionId: string;
  readonly key: string;
}

export interface BeginIdempotentRequestInput extends IdempotencyKey {
  readonly requestHash: string;
}

export interface CompleteIdempotentRequestInput extends IdempotencyKey {
  readonly statusCode: number;
  readonly body: unknown;
}

export interface RecordedResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export type BeginIdempotentRequestOutcome =
  /** This transaction owns the key and must now do the work. */
  | { readonly state: 'STARTED' }
  /** Another request owns the key and has not finished. */
  | { readonly state: 'IN_PROGRESS' }
  /** The key already has a recorded result; replay it. */
  | ({ readonly state: 'COMPLETED' } & RecordedResponse);

export interface IdempotencyRepository {
  begin(
    input: BeginIdempotentRequestInput,
  ): Promise<BeginIdempotentRequestOutcome>;
  find(key: IdempotencyKey): Promise<BeginIdempotentRequestOutcome | undefined>;
  complete(input: CompleteIdempotentRequestInput): Promise<void>;
}

interface RequestRow {
  readonly request_hash: string;
  readonly status: string;
  readonly response_status_code: number | null;
  readonly response_body: unknown;
}

function toOutcome(
  row: RequestRow,
  expectedHash: string | undefined,
): BeginIdempotentRequestOutcome {
  if (expectedHash !== undefined && row.request_hash !== expectedHash) {
    throw new DomainError(
      'IDEMPOTENCY_CONFLICT',
      'the idempotency key was already used for a different request',
    );
  }
  const statusCode = row.response_status_code;
  if (row.status !== 'COMPLETED' || statusCode === null) {
    return { state: 'IN_PROGRESS' };
  }
  return { state: 'COMPLETED', statusCode, body: row.response_body };
}

async function readRequest(
  connection: LedgerConnection,
  key: IdempotencyKey,
): Promise<RequestRow | undefined> {
  const result = await sql<RequestRow>`
    select request_hash, status, response_status_code, response_body
    from idempotency_requests
    where session_id = ${key.sessionId} and idempotency_key = ${key.key}
  `.execute(connection.executor);
  return result.rows[0];
}

/**
 * Claims an idempotency key for this transaction.
 *
 * The unique `(session_id, idempotency_key)` index is the arbiter, not a
 * read-then-write check: `on conflict do nothing` either inserts the claim or
 * reports that someone else holds it. A conflict whose row is then invisible
 * means the holder is an uncommitted concurrent request, which is reported as
 * IN_PROGRESS — the one answer that is true whichever way that request ends.
 *
 * The insert takes no lock on its own invisible new row, but its foreign key
 * pins the session row `for key share`, so that lock is declared. The conflict
 * path can still wait on a concurrent inserter of the same key — that is a wait
 * on a transaction id rather than on a row, and it cannot join a cycle, because
 * two requests carrying one key carry one session and are therefore already
 * serialised by the rank-0 session row.
 */
export async function beginIdempotentRequest(
  connection: LedgerConnection,
  input: BeginIdempotentRequestInput,
): Promise<BeginIdempotentRequestOutcome> {
  const request = snapshotInput({
    sessionId: input.sessionId,
    key: input.key,
    requestHash: input.requestHash,
  });
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: request.sessionId,
    strength: 'KEY_SHARE',
  });

  const claim = await sql<{ id: string }>`
    insert into idempotency_requests (
      id, session_id, idempotency_key, request_hash, status
    ) values (
      ${randomUUID()}, ${request.sessionId}, ${request.key},
      ${request.requestHash}, 'IN_PROGRESS'
    )
    on conflict (session_id, idempotency_key) do nothing
    returning id
  `.execute(connection.executor);
  if (claim.rows.length > 0) {
    return { state: 'STARTED' };
  }

  const existing = await readRequest(connection, request);
  if (existing === undefined) {
    return { state: 'IN_PROGRESS' };
  }
  return toOutcome(existing, request.requestHash);
}

export async function findIdempotentRequest(
  connection: LedgerConnection,
  key: IdempotencyKey,
): Promise<BeginIdempotentRequestOutcome | undefined> {
  const wanted = snapshotInput({ sessionId: key.sessionId, key: key.key });
  const existing = await readRequest(connection, wanted);
  return existing === undefined ? undefined : toOutcome(existing, undefined);
}

export async function completeIdempotentRequest(
  connection: LedgerConnection,
  input: CompleteIdempotentRequestInput,
): Promise<void> {
  const completion = snapshotInput({
    sessionId: input.sessionId,
    key: input.key,
    statusCode: input.statusCode,
    body: toJsonText(input.body, 'the recorded response body'),
  });
  // The `update` takes a `for no key update` lock on the request row, the last
  // rank of the lock order: a mutation reaches it only once everything else it
  // touches is already held.
  connection.acquireLock({
    table: 'idempotency_requests',
    key: `${completion.sessionId}:${completion.key}`,
    strength: 'NO_KEY_UPDATE',
  });

  // `status = 'IN_PROGRESS'` is this table's expected version: it has no
  // version column because a completed request is never updated again.
  const result = await sql<{ id: string }>`
    update idempotency_requests
    set status = 'COMPLETED',
        response_status_code = ${completion.statusCode},
        response_body = ${completion.body}::jsonb,
        completed_at = now()
    where session_id = ${completion.sessionId}
      and idempotency_key = ${completion.key}
      and status = 'IN_PROGRESS'
    returning id
  `.execute(connection.executor);
  assertVersionedUpdate(
    result.rows,
    `idempotency key ${completion.key} of session ${completion.sessionId}`,
  );
}

export function createIdempotencyRepository(
  connection: LedgerConnection,
): IdempotencyRepository {
  return Object.freeze({
    begin: (input: BeginIdempotentRequestInput) =>
      beginIdempotentRequest(connection, input),
    find: (key: IdempotencyKey) => findIdempotentRequest(connection, key),
    complete: (input: CompleteIdempotentRequestInput) =>
      completeIdempotentRequest(connection, input),
  });
}
