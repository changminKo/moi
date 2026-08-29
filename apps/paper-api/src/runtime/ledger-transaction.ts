import { randomUUID } from 'node:crypto';
import { DomainError } from '@moi/trading-core';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.js';

type Trx = Database extends {
  transaction(): { execute<T>(cb: (trx: infer X) => Promise<T>): Promise<T> };
}
  ? X
  : Transaction<unknown>;
export type LedgerTrx = Trx;

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

function sqlState(error: unknown): string | undefined {
  return typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

/**
 * Runs engine-side ledger persistence (fills, triggers) as one transaction
 * that first pins the owning session row `for key share`. That is the same
 * discipline the UnitOfWork keeps for request mutations: account sequences are
 * allocated only while the session is held, so two markets filling for one
 * account, or a fill racing a placement, serialise on the session instead of
 * colliding on `account_sequences`' unique key. Serialization failures and
 * deadlocks (40001 / 40P01) are retried a bounded number of times; anything
 * else propagates to the caller, which owns the engine-state rollback.
 */
export async function runSessionTransaction<T>(
  db: Database,
  sessionId: string,
  work: (trx: LedgerTrx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction().execute(async (trx) => {
        // FOR UPDATE, not FOR KEY SHARE: key-share holders are mutually
        // compatible and would not serialise two markets filling for one
        // account, whose sequence allocation relies on the session being held
        // exclusively (lock-order.ts).
        const pinned = await sql<{ id: string }>`
          select id::text from anonymous_sessions where id = ${sessionId}::uuid for update
        `.execute(trx);
        if (pinned.rows.length === 0)
          throw new DomainError(
            'ACCOUNT_READ_ONLY',
            `session ${sessionId} no longer exists`,
          );
        return work(trx as LedgerTrx);
      });
    } catch (error) {
      const state = sqlState(error);
      if (
        state === undefined ||
        !RETRYABLE_SQLSTATES.has(state) ||
        attempt >= MAX_ATTEMPTS
      )
        throw error;
    }
  }
}

/** Next `account_sequence` for the session; the caller holds the session row. */
export async function allocateAccountSequence(
  trx: LedgerTrx,
  sessionId: string,
  mutationKind: string,
): Promise<string> {
  const result = await sql<{ sequence: string }>`
    insert into account_sequences (id, session_id, account_sequence, mutation_kind)
    select ${randomUUID()}::uuid, ${sessionId}::uuid, coalesce(max(account_sequence), 0) + 1, ${mutationKind}
    from account_sequences where session_id = ${sessionId}::uuid
    returning account_sequence::text as sequence
  `.execute(trx);
  const sequence = result.rows[0]?.sequence;
  if (sequence === undefined)
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'account sequence allocation returned no row',
    );
  return sequence;
}
