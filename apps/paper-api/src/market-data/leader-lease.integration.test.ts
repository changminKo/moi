import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDatabase, type Database } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { leaseAuditPort } from '../runtime/lease-audit.js';
import {
  LeaderLease,
  type LeaseAuditPort,
  type LeaseConnection,
} from './leader-lease.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;

let container: StartedPostgreSqlContainer;
let connectionString: string;
let database: Database;
let observer: Client;
const openLeases: LeaderLease[] = [];

const POLL_QUERY = 'select pg_try_advisory_lock';
const UNLOCK_QUERY = 'select pg_advisory_unlock';

type TimelinePhase = 'issued' | 'settled';

/**
 * One observed moment of one query on one connection. Every recorder writes
 * into the same array, so `seq` is a total order over what this process did —
 * which is what lets a test state "A happened before B" without measuring how
 * long either took. A loaded runner reorders nothing; it only makes the gaps
 * bigger.
 */
interface TimelineEntry {
  readonly seq: number;
  readonly label: string;
  readonly query: string;
  readonly phase: TimelinePhase;
}

let timeline: TimelineEntry[] = [];
let timelineSeq = 0;
let connectionCount = 0;

interface Recorder {
  readonly label: string;
  readonly queries: string[];
  readonly connection: LeaseConnection;
  readonly pid: () => Promise<number>;
  ended: boolean;
}

/** Wraps a pg Client so tests can assert the exact query order and hook the lock result. */
async function recordingConnection(
  options: { onLockAcquired?: () => void; label?: string } = {},
): Promise<Recorder> {
  const client = new Client({ connectionString });
  await client.connect();
  const pidRow = await client.query('select pg_backend_pid() as pid');
  const pid = Number(pidRow.rows[0].pid);
  connectionCount += 1;
  const label = options.label ?? `conn-${connectionCount}`;
  const recorder: Recorder = {
    label,
    queries: [],
    ended: false,
    pid: async () => pid,
    connection: {
      query: async (text, values) => {
        const query = text.trim().split(/\s+/).slice(0, 3).join(' ');
        recorder.queries.push(query);
        timelineSeq += 1;
        timeline.push({ seq: timelineSeq, label, query, phase: 'issued' });
        const result = await client.query(text, values as unknown[]);
        timelineSeq += 1;
        timeline.push({ seq: timelineSeq, label, query, phase: 'settled' });
        if (
          /pg_try_advisory_lock/.test(text) &&
          result.rows[0]?.pg_try_advisory_lock === true
        )
          options.onLockAcquired?.();
        return { rows: result.rows };
      },
      on: (event, listener) => client.on(event, listener),
      end: async () => {
        recorder.ended = true;
        await client.end();
      },
    },
  };
  return recorder;
}

const pollsOf = (recorder: Recorder): number =>
  recorder.queries.filter((query) => query.startsWith(POLL_QUERY)).length;

function findEntry(
  entries: readonly TimelineEntry[],
  label: string,
  prefix: string,
  phase: TimelinePhase,
): TimelineEntry | undefined {
  return entries.find(
    (entry) =>
      entry.label === label &&
      entry.phase === phase &&
      entry.query.startsWith(prefix),
  );
}

function acquire(
  market: 'KR' | 'US',
  recorder: Recorder,
  extra: {
    leaderId?: string;
    signal?: AbortSignal;
    audit?: LeaseAuditPort;
    onLost?: (market: 'KR' | 'US') => void;
    log?: (event: string, fields: Record<string, unknown>) => void;
  } = {},
): Promise<LeaderLease> {
  const leaderId = extra.leaderId ?? randomUUID();
  const promise = LeaderLease.acquire(market, {
    leaderId,
    clientFactory: async () => recorder.connection,
    audit: extra.audit ?? leaseAuditPort,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.onLost ? { onLost: extra.onLost } : {}),
    ...(extra.log ? { log: extra.log } : {}),
  });
  void promise.then((lease) => openLeases.push(lease)).catch(() => undefined);
  return promise;
}

const epochRows = async (market: string) =>
  (
    await observer.query(
      'select epoch::text, leader_id, released_at from leader_epochs where market_code = $1',
      [market],
    )
  ).rows as { epoch: string; leader_id: string; released_at: Date | null }[];
const auditRows = async (type?: string) =>
  (
    await observer.query(
      `select event_type, payload, occurred_at from audit_events where event_type like 'LEADER_%' ${type ? 'and event_type = $1' : ''} order by occurred_at, id`,
      type ? [type] : [],
    )
  ).rows as {
    event_type: string;
    payload: Record<string, unknown>;
    occurred_at: Date;
  }[];
const advisoryLocks = async () =>
  Number(
    (
      await observer.query(
        "select count(*)::int as n from pg_locks where locktype = 'advisory'",
      )
    ).rows[0].n,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  connectionString = container.getConnectionUri();
  database = createDatabase(connectionString);
  await migrateToLatest(database);
  observer = new Client({ connectionString });
  await observer.connect();
}, CONTAINER_TIMEOUT_MS);

afterEach(async () => {
  timeline = [];
  timelineSeq = 0;
  for (const lease of openLeases.splice(0))
    await lease.release().catch(() => undefined);
  await observer.query('select pg_advisory_unlock_all()');
  await observer.query('delete from leader_epochs');
  await observer.query(
    "delete from audit_events where event_type like 'LEADER_%'",
  );
});

afterAll(async () => {
  await observer?.end();
  await database?.destroy();
  await container?.stop();
});

describe('LeaderLease (§5.4)', () => {
  it(
    '1. first acquire: one row, epoch 1, audit in the same transaction, resolves after commit',
    async () => {
      const recorder = await recordingConnection();
      const leaderId = randomUUID();
      const lease = await acquire('KR', recorder, { leaderId });
      expect(lease.state).toBe('HELD');
      expect(lease.isHeld).toBe(true);
      expect(lease.epoch).toBe(1n);
      const rows = await epochRows('KR');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        epoch: '1',
        leader_id: leaderId,
        released_at: null,
      });
      const audits = await auditRows('LEADER_ACQUIRED');
      expect(audits).toHaveLength(1);
      expect(audits[0]?.payload).toEqual({
        market: 'KR',
        epoch: '1',
        fencingToken: '1',
        leaderId,
      });
      expect(recorder.queries).toEqual([
        'select pg_try_advisory_lock(hashtext($1))',
        'begin',
        'insert into leader_epochs',
        'insert into audit_events',
        'commit',
      ]);
      expect(recorder.queries.some((q) => /\bpg_advisory_lock\(/.test(q))).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '2. release: released_at set under the lock, one LEADER_RELEASED, then unlock and end',
    async () => {
      const recorder = await recordingConnection();
      const leaderId = randomUUID();
      const lease = await acquire('KR', recorder, { leaderId });
      recorder.queries.length = 0;
      await lease.release();
      expect(lease.state).toBe('RELEASED');
      expect(lease.isHeld).toBe(false);
      const [row] = await epochRows('KR');
      expect(row?.released_at).not.toBeNull();
      expect(row).toMatchObject({ epoch: '1', leader_id: leaderId });
      const audits = await auditRows('LEADER_RELEASED');
      expect(audits).toHaveLength(1);
      expect(audits[0]?.payload).toEqual({
        market: 'KR',
        epoch: '1',
        leaderId,
      });
      expect(recorder.queries).toEqual([
        'begin',
        'update leader_epochs set',
        'insert into audit_events',
        'commit',
        'select pg_advisory_unlock(hashtext($1))',
      ]);
      expect(recorder.ended).toBe(true);
      expect(await advisoryLocks()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '3. reacquire: epoch 2 with released_at reset to null, then released again',
    async () => {
      const first = await acquire('KR', await recordingConnection());
      await first.release();
      const second = await acquire('KR', await recordingConnection(), {
        leaderId: 'leader-2',
      });
      expect(second.epoch).toBe(2n);
      let [row] = await epochRows('KR');
      expect(row).toMatchObject({
        epoch: '2',
        leader_id: 'leader-2',
        released_at: null,
      });
      expect(
        (await auditRows('LEADER_ACQUIRED')).map((a) => a.payload.epoch),
      ).toEqual(['1', '2']);
      await second.release();
      [row] = await epochRows('KR');
      expect(row?.released_at).not.toBeNull();
      expect(
        (await auditRows('LEADER_RELEASED')).map((a) => a.payload.epoch),
      ).toEqual(['1', '2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '4. no race: a waiter acquires only after release, audits serialize under the lock',
    async () => {
      const p1 = await recordingConnection({ label: 'p1' });
      const lease1 = await acquire('KR', p1, { leaderId: 'p1' });
      const p2 = await recordingConnection({ label: 'p2' });
      let settled = false;
      const waiting = acquire('KR', p2, { leaderId: 'p2' }).then((lease) => {
        settled = true;
        return lease;
      });
      // (a) The waiter keeps polling and never opens a transaction while the
      // lock is held. Wait for the polls to happen rather than for a span of
      // time in which they ought to: a loaded runner fires the timers late
      // without breaking the rule under test.
      await vi.waitFor(() => expect(pollsOf(p2)).toBeGreaterThanOrEqual(3), {
        timeout: 10_000,
        interval: 25,
      });
      expect(settled).toBe(false);
      expect(p2.queries.some((q) => q === 'begin')).toBe(false);
      const fromRelease = timeline.length;
      const releasedAt = Date.now();
      const releasing = lease1.release();
      const [, lease2] = await Promise.all([releasing, waiting]);
      const after = timeline.slice(fromRelease);
      const seq = (
        label: string,
        prefix: string,
        phase: TimelinePhase,
      ): number => {
        const entry = findEntry(after, label, prefix, phase);
        if (entry === undefined)
          throw new Error(
            `expected ${label} to have ${phase} "${prefix}" after the release`,
          );
        return entry.seq;
      };
      // (b) LEADER_RELEASED commits — and is therefore visible to every other
      // session — before the waiter's own transaction begins. Stated as the
      // ordering fact it is, instead of racing an observer against P2.
      expect(seq('p1', 'commit', 'settled')).toBeLessThan(
        seq('p2', 'begin', 'issued'),
      );
      // (c) The waiter takes the lock on its first poll after the unlock: the
      // poll interval is fixed and there is no backoff. Counting polls says
      // that independently of how slowly the runner schedules them.
      const unlockSeq = seq('p1', UNLOCK_QUERY, 'settled');
      const pollsAfterUnlock = after.filter(
        (entry) =>
          entry.label === 'p2' &&
          entry.phase === 'issued' &&
          entry.query.startsWith(POLL_QUERY) &&
          entry.seq > unlockSeq,
      );
      expect(pollsAfterUnlock.length).toBeLessThanOrEqual(1);
      // Secondary margin, generous by design: (c) is the real assertion, this
      // only catches a regression to a wildly longer poll interval.
      expect(Date.now() - releasedAt).toBeLessThan(5_000);
      const [row] = await epochRows('KR');
      expect(row).toMatchObject({
        epoch: '2',
        leader_id: 'p2',
        released_at: null,
      });
      expect(
        (await auditRows()).map(
          (a) => `${a.event_type}:${a.payload.leaderId}:${a.payload.epoch}`,
        ),
      ).toEqual([
        'LEADER_ACQUIRED:p1:1',
        'LEADER_RELEASED:p1:1',
        'LEADER_ACQUIRED:p2:2',
      ]);
      for (let i = 0; i < 100; i += 1) {
        const [current] = await epochRows('KR');
        expect(
          current?.leader_id === 'p2' && current.released_at !== null,
        ).toBe(false);
      }
      expect(lease2.isHeld).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '5. release audit failure: rollback, no released_at, unlock still happens in finally',
    async () => {
      const logs: string[] = [];
      const failing: LeaseAuditPort = {
        recordAcquired: leaseAuditPort.recordAcquired,
        recordReleased: async () => {
          throw new Error('audit unavailable');
        },
      };
      const recorder = await recordingConnection();
      const lease = await acquire('KR', recorder, {
        audit: failing,
        log: (event) => logs.push(event),
      });
      await expect(lease.release()).resolves.toBeUndefined();
      const [row] = await epochRows('KR');
      expect(row?.released_at).toBeNull();
      expect(await auditRows('LEADER_RELEASED')).toHaveLength(0);
      expect(
        logs.filter((e) => e === 'lease.release_mark_failed'),
      ).toHaveLength(1);
      expect(recorder.queries.slice(-2)).toEqual([
        'rollback',
        'select pg_advisory_unlock(hashtext($1))',
      ]);
      expect(await advisoryLocks()).toBe(0);
      expect(recorder.ended).toBe(true);
      const next = await acquire('KR', await recordingConnection(), {
        leaderId: 'next',
      });
      expect(next.epoch).toBe(2n);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '6. acquire audit failure: rejected, no row, no audit, no lock, connection closed',
    async () => {
      const failing: LeaseAuditPort = {
        recordAcquired: async () => {
          throw new Error('audit unavailable');
        },
        recordReleased: leaseAuditPort.recordReleased,
      };
      const recorder = await recordingConnection();
      await expect(acquire('KR', recorder, { audit: failing })).rejects.toThrow(
        'audit unavailable',
      );
      expect(await epochRows('KR')).toHaveLength(0);
      expect(await auditRows()).toHaveLength(0);
      expect(await advisoryLocks()).toBe(0);
      expect(recorder.ended).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '7. abort while waiting: rejects within one poll interval, nothing written, holder untouched',
    async () => {
      const p1 = await recordingConnection();
      const holder = await acquire('KR', p1);
      const p2 = await recordingConnection({ label: 'waiter' });
      const controller = new AbortController();
      const waiting = acquire('KR', p2, { signal: controller.signal });
      await vi.waitFor(() => expect(pollsOf(p2)).toBeGreaterThanOrEqual(2), {
        timeout: 10_000,
        interval: 25,
      });
      // Read and abort with no await between them, so no timer can fire in the
      // gap and add a poll this count would then blame on the abort.
      const pollsBeforeAbort = pollsOf(p2);
      const abortedAt = Date.now();
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      // The abort interrupts the sleep instead of being noticed at the next
      // poll — so the waiter issues no further poll at all.
      expect(pollsOf(p2)).toBe(pollsBeforeAbort);
      // Secondary margin only; the poll count above is the real assertion.
      expect(Date.now() - abortedAt).toBeLessThan(5_000);
      expect(p2.ended).toBe(true);
      expect(await epochRows('KR')).toHaveLength(1);
      expect(await auditRows('LEADER_ACQUIRED')).toHaveLength(1);
      expect(holder.isHeld).toBe(true);
      expect(await advisoryLocks()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '8. abort/lock race: lock granted then aborted → immediate unlock, no begin/upsert/audit',
    async () => {
      const controller = new AbortController();
      const recorder = await recordingConnection({
        onLockAcquired: () => controller.abort(),
      });
      const logs: { event: string; fields: Record<string, unknown> }[] = [];
      await expect(
        acquire('KR', recorder, {
          signal: controller.signal,
          log: (event, fields) => logs.push({ event, fields }),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(recorder.queries).toEqual([
        'select pg_try_advisory_lock(hashtext($1))',
        'select pg_advisory_unlock(hashtext($1))',
      ]);
      expect(recorder.ended).toBe(true);
      expect(await advisoryLocks()).toBe(0);
      expect(await epochRows('KR')).toHaveLength(0);
      expect(await auditRows()).toHaveLength(0);
      expect(
        logs.find((l) => l.event === 'lease.acquire_aborted')?.fields,
      ).toMatchObject({ lockedThenUnlocked: true });
      const next = await recordingConnection();
      const lease = await acquire('KR', next);
      expect(
        next.queries.filter((q) => q.startsWith('select pg_try_advisory_lock')),
      ).toHaveLength(1);
      expect(lease.epoch).toBe(1n);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '11. intentional release, abort, and rollback never report loss',
    async () => {
      const onLost = vi.fn();
      const lease = await acquire('KR', await recordingConnection(), {
        onLost,
      });
      await lease.release();
      await sleep(50);
      expect(onLost).not.toHaveBeenCalled();
      expect(lease.state).toBe('RELEASED');
      // (b) abort while waiting
      const holder = await acquire('US', await recordingConnection());
      const controller = new AbortController();
      const waiting = acquire('US', await recordingConnection(), {
        signal: controller.signal,
        onLost,
      });
      await sleep(300);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      // (c) abort/lock race
      const race = new AbortController();
      await expect(
        acquire(
          'KR',
          await recordingConnection({ onLockAcquired: () => race.abort() }),
          { signal: race.signal, onLost },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // (d) audit failure rollback
      await expect(
        acquire('KR', await recordingConnection(), {
          onLost,
          audit: {
            recordAcquired: async () => {
              throw new Error('audit unavailable');
            },
            recordReleased: leaseAuditPort.recordReleased,
          },
        }),
      ).rejects.toThrow('audit unavailable');
      await sleep(50);
      expect(onLost).not.toHaveBeenCalled();
      await holder.release();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '12. loss is reported exactly once and a later release only closes the connection',
    async () => {
      const onLost = vi.fn();
      const recorder = await recordingConnection();
      const lease = await acquire('KR', recorder, { onLost });
      await observer.query('select pg_terminate_backend($1)', [
        await recorder.pid(),
      ]);
      await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await sleep(200);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost).toHaveBeenCalledWith('KR');
      expect(lease.state).toBe('LOST');
      expect(lease.isHeld).toBe(false);
      recorder.queries.length = 0;
      await expect(lease.release()).resolves.toBeUndefined();
      expect(recorder.queries).toEqual([]);
      expect(await auditRows('LEADER_RELEASED')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
