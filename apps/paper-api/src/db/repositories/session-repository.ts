import { randomUUID } from 'node:crypto';
import { DomainError } from '@moi/trading-core';
import { sql } from 'kysely';
import { assertVersionedUpdate, snapshotInput } from '../database.js';
import type { LedgerConnection } from '../unit-of-work.js';

export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface SessionRecord {
  readonly id: string;
  readonly status: SessionStatus;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly version: bigint;
}

export interface TouchSessionInput {
  readonly sessionId: string;
  readonly expectedVersion: bigint;
  readonly lastSeenAt: Date;
}

export interface SessionRepository {
  find(sessionId: string): Promise<SessionRecord | undefined>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  lock(sessionId: string): Promise<SessionRecord | undefined>;
  touch(input: TouchSessionInput): Promise<bigint>;
  bootstrap(input: {
    id: string;
    tokenHash: string;
    now: Date;
    expiresAt: Date;
  }): Promise<SessionRecord>;
  expire(sessionId: string, now: Date): Promise<void>;
}

interface SessionRow {
  readonly id: string;
  readonly status: string;
  readonly expires_at: Date;
  readonly last_seen_at: Date;
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
    lastSeenAt: row.last_seen_at,
    version: BigInt(row.version),
  };
}

/** Reads a session without locking it. */
export async function findSession(
  connection: LedgerConnection,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const result = await sql<SessionRow>`
    select id, status, expires_at, last_seen_at, version
    from anonymous_sessions
    where id = ${sessionId}
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toSessionRecord(row);
}

export async function findSessionByTokenHash(
  connection: LedgerConnection,
  tokenHash: string,
): Promise<SessionRecord | undefined> {
  const result =
    await sql<SessionRow>`select id, status, expires_at, last_seen_at, version from anonymous_sessions where token_hash = ${tokenHash}`.execute(
      connection.executor,
    );
  return result.rows[0] === undefined
    ? undefined
    : toSessionRecord(result.rows[0]);
}

export async function bootstrapSession(
  connection: LedgerConnection,
  input: { id: string; tokenHash: string; now: Date; expiresAt: Date },
): Promise<SessionRecord> {
  const result = await sql<SessionRow>`
    insert into anonymous_sessions (id, token_hash, created_at, expires_at, last_seen_at)
    values (${input.id}, ${input.tokenHash}, ${input.now}, ${input.expiresAt}, ${input.now})
    on conflict (token_hash) do update set token_hash = excluded.token_hash
    returning id, status, expires_at, last_seen_at, version
  `.execute(connection.executor);
  const row = result.rows[0];
  if (!row) throw new Error('session bootstrap did not return a row');
  await sql`
    insert into wallets (id, session_id, currency, total, available, reserved)
    values (${randomUUID()}, ${row.id}, 'KRW', 10000000, 10000000, 0),
           (${randomUUID()}, ${row.id}, 'USD', 0, 0, 0)
    on conflict (session_id, currency) do nothing
  `.execute(connection.executor);
  return toSessionRecord(row);
}

export async function expireSession(
  connection: LedgerConnection,
  sessionId: string,
  now: Date,
): Promise<void> {
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: sessionId,
    strength: 'NO_KEY_UPDATE',
  });
  await sql`update anonymous_sessions set status = 'EXPIRED', expires_at = ${now}, version = version + 1 where id = ${sessionId} and status = 'ACTIVE'`.execute(
    connection.executor,
  );
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
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: sessionId,
    strength: 'UPDATE',
  });
  const result = await sql<SessionRow>`
    select id, status, expires_at, last_seen_at, version
    from anonymous_sessions
    where id = ${sessionId}
    for update
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toSessionRecord(row);
}

/**
 * Records that the session was seen.
 *
 * The `update` takes a `for no key update` lock on the session row whether or
 * not the caller locked it first, so it declares that lock: an undeclared
 * implicit lock is exactly as capable of inverting the global order as an
 * explicit one.
 */
export async function touchSession(
  connection: LedgerConnection,
  input: TouchSessionInput,
): Promise<bigint> {
  const touch = snapshotInput({
    sessionId: input.sessionId,
    expectedVersion: input.expectedVersion,
    lastSeenAt: input.lastSeenAt,
  });
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: touch.sessionId,
    strength: 'NO_KEY_UPDATE',
  });

  const result = await sql<{ version: string }>`
    update anonymous_sessions
    set last_seen_at = ${touch.lastSeenAt}, version = version + 1
    where id = ${touch.sessionId} and version = ${touch.expectedVersion}
    returning version
  `.execute(connection.executor);
  return BigInt(
    assertVersionedUpdate(result.rows, `session ${touch.sessionId}`).version,
  );
}

export function createSessionRepository(
  connection: LedgerConnection,
): SessionRepository {
  return Object.freeze({
    find: (sessionId: string) => findSession(connection, sessionId),
    findByTokenHash: (tokenHash: string) =>
      findSessionByTokenHash(connection, tokenHash),
    lock: (sessionId: string) => lockSession(connection, sessionId),
    touch: (input: TouchSessionInput) => touchSession(connection, input),
    bootstrap: (input: {
      id: string;
      tokenHash: string;
      now: Date;
      expiresAt: Date;
    }) => bootstrapSession(connection, input),
    expire: (sessionId: string, now: Date) =>
      expireSession(connection, sessionId, now),
  });
}
