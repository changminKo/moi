import { randomUUID } from 'node:crypto';
import { DomainError } from '@moi/trading-core';
import { sql } from 'kysely';
import {
  assertVersionedUpdate,
  snapshotInput,
  toJsonText,
} from '../database.js';
import { compositeLockKey } from '../lock-order.js';
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
 * The insert takes no lock on its own invisible new row, but it does take two
 * that can wait. The conflict path waits on a concurrent inserter of the same
 * key, and that is a wait on a transaction id rather than on a row: nothing
 * about the session row prevents it, because two concurrent requests carrying
 * one key both pin the session `for key share` and two shared holders do not
 * serialise with one another. So the index entry is declared as a claim, at the
 * rank of `idempotency_requests` itself, and the ordering discipline covers the
 * wait. That is what makes this the second lock a mutation takes rather than the
 * last: a transaction that claimed the key and then waits for a wallet is in
 * order, and one that holds a wallet and then claims a key is refused.
 *
 * The claim is declared before the session pin because that is the order
 * PostgreSQL takes them in: the speculative index entry is written while the
 * statement runs and the foreign-key check is an AFTER ROW trigger of it. A
 * rank-0 pin after a rank-1 claim is a descent no ranking can absorb, so the
 * guard refuses it unless the session row is already held — which makes the pin
 * acquire nothing, and therefore unable to wait. Claiming a key without pinning
 * the session first deadlocked two guard-clean transactions on this index; it is
 * now inexpressible.
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
  connection.claimUniqueKey({
    table: 'idempotency_requests',
    key: compositeLockKey(request.sessionId, request.key),
    index: 'idempotency_requests_session_id_idempotency_key_key',
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
  // The `update` takes a `for no key update` lock on the request row, at the
  // same position in the order as the claim `begin` took: they are the same
  // resource, which is why a mutation records its result immediately after
  // claiming the key rather than at the end.
  connection.acquireLock({
    table: 'idempotency_requests',
    key: compositeLockKey(completion.sessionId, completion.key),
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
