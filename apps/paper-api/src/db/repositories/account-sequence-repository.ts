import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { snapshotInput } from '../database.js';
import type { LedgerConnection } from '../unit-of-work.js';

export interface AllocateAccountSequenceInput {
  readonly sessionId: string;
  readonly mutationKind: string;
}

export interface AccountSequenceRepository {
  allocate(input: AllocateAccountSequenceInput): Promise<bigint>;
}

/** Allocates and records the next account sequence on the caller's transaction. */
export async function allocateAccountSequence(
  connection: LedgerConnection,
  input: AllocateAccountSequenceInput,
): Promise<bigint> {
  const request = snapshotInput({
    sessionId: input.sessionId,
    mutationKind: input.mutationKind,
  });

  // The mutation already holds this row FOR UPDATE. That serialises allocation
  // for one account and makes both unique-index entries uncontended.
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: request.sessionId,
    strength: 'KEY_SHARE',
  });
  const result = await sql<{ account_sequence: string }>`
    insert into account_sequences (
      id, session_id, account_sequence, mutation_kind
    )
    select
      ${randomUUID()}, ${request.sessionId},
      coalesce(max(account_sequence), 0) + 1, ${request.mutationKind}
    from account_sequences
    where session_id = ${request.sessionId}
    returning account_sequence::text as account_sequence
  `.execute(connection.executor);
  const sequence = result.rows[0]?.account_sequence;
  if (sequence === undefined) {
    throw new Error('account sequence allocation returned no row');
  }
  return BigInt(sequence);
}

export function createAccountSequenceRepository(
  connection: LedgerConnection,
): AccountSequenceRepository {
  return Object.freeze({
    allocate: (input: AllocateAccountSequenceInput) =>
      allocateAccountSequence(connection, input),
  });
}
