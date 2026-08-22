import { DomainError } from '@skipjack/trading-core';
import { sql } from 'kysely';
import { assertVersionedUpdate, snapshotInput } from '../database.js';
import type { LedgerConnection } from '../unit-of-work.js';

export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface SessionRecord {
  readonly id: string;
  readonly status: SessionStatus;
  readonly expiresAt: Date;
  readonly version: bigint;
}

export interface TouchSessionInput {
  readonly sessionId: string;
  readonly expectedVersion: bigint;
  readonly lastSeenAt: Date;
}

export interface SessionRepository {
  find(sessionId: string): Promise<SessionRecord | undefined>;
  lock(sessionId: string): Promise<SessionRecord | undefined>;
  touch(input: TouchSessionInput): Promise<bigint>;
}

interface SessionRow {
  readonly id: string;
  readonly status: string;
  readonly expires_at: Date;
  readonly version: string;
}

const SESSION_STATUSES = new Set<string>(['ACTIVE', 'EXPIRED', 'REVOKED']);

function toSessionRecord(row: SessionRow): SessionRecord {
  const status = row.status;
  if (!SESSION_STATUSES.has(status)) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `session status ${status} is not a known status`,
    );
  }
  return {
    id: row.id,
    status: status as SessionStatus,
    expiresAt: row.expires_at,
    version: BigInt(row.version),
  };
}

/** Reads a session without locking it. */
export async function findSession(
  connection: LedgerConnection,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const result = await sql<SessionRow>`
    select id, status, expires_at, version
    from anonymous_sessions
    where id = ${sessionId}
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toSessionRecord(row);
}

/**
 * Locks the session row, the first rank of the global lock order. Every
 * mutation of a session's ledger starts here, which is what makes the rest of
 * the order reachable without a cycle.
 */
export async function lockSession(
  connection: LedgerConnection,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  connection.acquireLock({ table: 'anonymous_sessions', key: sessionId });
  const result = await sql<SessionRow>`
    select id, status, expires_at, version
    from anonymous_sessions
    where id = ${sessionId}
    for update
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toSessionRecord(row);
}

export async function touchSession(
  connection: LedgerConnection,
  input: TouchSessionInput,
): Promise<bigint> {
  const touch = snapshotInput({
    sessionId: input.sessionId,
    expectedVersion: input.expectedVersion,
    lastSeenAt: input.lastSeenAt,
  });

  const result = await sql<{ version: string }>`
    update anonymous_sessions
    set last_seen_at = ${touch.lastSeenAt}, version = version + 1
    where id = ${touch.sessionId} and version = ${touch.expectedVersion}
    returning version
  `.execute(connection.executor);
  assertVersionedUpdate(result.rows, `session ${touch.sessionId}`);
  return BigInt(result.rows[0]?.version ?? '0');
}

export function createSessionRepository(
  connection: LedgerConnection,
): SessionRepository {
  return Object.freeze({
    find: (sessionId: string) => findSession(connection, sessionId),
    lock: (sessionId: string) => lockSession(connection, sessionId),
    touch: (input: TouchSessionInput) => touchSession(connection, input),
  });
}
