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
import {
  LEASE_POLL_INTERVAL_MS,
  LeaderLease,
  type LeaseAuditPort,
  type LeaseConnection,
} from '../market-data/leader-lease.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { leaseAuditPort } from './lease-audit.js';
import {
  LeaseLostError,
  LeaseNotHeldError,
  LeaseRegistry,
} from './lease-registry.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const ROUND_TRIP_SLACK_MS = 400;

let container: StartedPostgreSqlContainer;
let connectionString: string;
let database: Database;
let observer: Client;
const registries: LeaseRegistry[] = [];

interface Tracked {
  readonly log: string[];
  readonly clients: Client[];
  factory: () => Promise<LeaseConnection>;
}

/** Every connection the registry opens is tagged so the global query order is visible. */
function trackedFactory(): Tracked {
  const log: string[] = [];
  const clients: Client[] = [];
  const tracked: Tracked = {
    log,
    clients,
    factory: async () => {
      const client = new Client({ connectionString });
      await client.connect();
      clients.push(client);
      const index = clients.length;
      return {
        query: async (text, values) => {
          const market =
            Array.isArray(values) && typeof values[0] === 'string'
              ? values[0]
              : '';
          log.push(
            `${index}:${text.trim().split(/\s+/).slice(0, 3).join(' ')}:${market}`,
          );
          const result = await client.query(text, values as unknown[]);
          return { rows: result.rows };
        },
        on: (event, listener) => client.on(event, listener),
        end: async () => {
          await client.end();
        },
      };
    },
  };
  return tracked;
}

function registry(
  options: {
    tracked?: Tracked;
    audit?: LeaseAuditPort;
    onLostHeld?: (market: 'KR' | 'US') => void;
    phase?: () => 'SERVING' | 'RECOVERING' | 'ACQUIRING';
    metrics?: MetricsRegistry;
    leaderId?: string;
  } = {},
) {
  const tracked = options.tracked ?? trackedFactory();
  const onLostHeld = options.onLostHeld ?? vi.fn();
  const metrics = options.metrics ?? new MetricsRegistry();
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const r = new LeaseRegistry({
    connectionString,
    leaderId: options.leaderId ?? randomUUID(),
    audit: options.audit ?? leaseAuditPort,
    onLostHeld,
    phase: options.phase ?? (() => 'SERVING'),
    metrics,
    log: (event, fields) => logs.push({ event, fields }),
    clientFactory: tracked.factory,
  });
  registries.push(r);
  return { r, tracked, onLostHeld, metrics, logs };
}

const auditRows = async () =>
  (
    await observer.query(
      "select event_type, payload from audit_events where event_type like 'LEADER_%' order by occurred_at, id",
    )
  ).rows as { event_type: string; payload: Record<string, unknown> }[];
const advisoryLocks = async () =>
  Number(
    (
      await observer.query(
        "select count(*)::int as n from pg_locks where locktype = 'advisory'",
      )
    ).rows[0].n,
  );
const epochOf = async (market: string) =>
  (
    await observer.query(
      'select epoch::text from leader_epochs where market_code = $1',
      [market],
    )
  ).rows[0]?.epoch;
const backendPids = async () =>
  (
    await observer.query(
      "select pid from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'",
    )
  ).rows.map((r) => Number(r.pid));
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
  for (const r of registries.splice(0)) {
    await r.abortPending().catch(() => undefined);
    await r.releaseAll().catch(() => undefined);
  }
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

describe('LeaseRegistry (§5.4 bundle)', () => {
  it(
    '10. acquires KR then US sequentially, shares the in-flight promise, releases US then KR',
    async () => {
      const { r, tracked } = registry();
      const controller = new AbortController();
      const a = r.acquireAll(controller.signal);
      const b = r.acquireAll(controller.signal);
      expect(a).toBe(b);
      const bundle = await a;
      expect(bundle.KR.market).toBe('KR');
      expect(bundle.US.market).toBe('US');
      expect(bundle.KR.epoch).toBe(1n);
      expect(bundle.US.epoch).toBe(1n);
      const locks = tracked.log.filter((l) =>
        l.includes('pg_try_advisory_lock'),
      );
      expect(locks.map((l) => l.split(':').at(-1))).toEqual(['KR', 'US']);
      const krCommit = tracked.log.findIndex((l) => l.startsWith('1:commit'));
      const usFirstLock = tracked.log.findIndex((l) =>
        l.startsWith('2:select pg_try_advisory_lock'),
      );
      expect(krCommit).toBeGreaterThan(-1);
      expect(usFirstLock).toBeGreaterThan(krCommit);
      expect(r.held('KR')).toBe(bundle.KR);
      expect(r.pending).toBeNull();
      tracked.log.length = 0;
      await r.releaseAll();
      const unlocks = tracked.log.filter((l) =>
        l.includes('pg_advisory_unlock'),
      );
      expect(unlocks.map((l) => l.split(':').at(-1))).toEqual(['US', 'KR']);
      expect(
        (await auditRows()).map((a) => `${a.event_type}:${a.payload.market}`),
      ).toEqual([
        'LEADER_ACQUIRED:KR',
        'LEADER_ACQUIRED:US',
        'LEADER_RELEASED:US',
        'LEADER_RELEASED:KR',
      ]);
      expect(() => r.held('KR')).toThrow(LeaseNotHeldError);
      expect(await advisoryLocks()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it('held() throws before the bundle exists and never acquires', async () => {
    const { r } = registry();
    expect(() => r.held('KR')).toThrow(LeaseNotHeldError);
    expect(await epochOf('KR')).toBeUndefined();
    expect((r as unknown as Record<string, unknown>).acquire).toBeUndefined();
  });

  it(
    '9. partial acquisition is released in reverse order on abort and on audit failure',
    async () => {
      await observer.query("select pg_try_advisory_lock(hashtext('US'))");
      const { r, onLostHeld } = registry();
      const controller = new AbortController();
      const acquiring = r.acquireAll(controller.signal);
      await vi.waitFor(() => expect(r.pending).toBe('US'));
      expect(await epochOf('KR')).toBe('1');
      controller.abort();
      await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
      expect(
        (await auditRows()).map((a) => `${a.event_type}:${a.payload.market}`),
      ).toEqual(['LEADER_ACQUIRED:KR', 'LEADER_RELEASED:KR']);
      expect(await advisoryLocks()).toBe(1); // observer's US lock only
      expect(onLostHeld).not.toHaveBeenCalled();
      expect(() => r.held('KR')).toThrow(LeaseNotHeldError);

      // same scenario with a failing US audit
      await observer.query("select pg_advisory_unlock(hashtext('US'))");
      let calls = 0;
      const flakyAudit: LeaseAuditPort = {
        recordAcquired: async (query, ctx) => {
          calls += 1;
          if (ctx.market === 'US') throw new Error('audit unavailable');
          await leaseAuditPort.recordAcquired(query, ctx);
        },
        recordReleased: leaseAuditPort.recordReleased,
      };
      const second = registry({ audit: flakyAudit, onLostHeld });
      await expect(
        second.r.acquireAll(new AbortController().signal),
      ).rejects.toThrow('audit unavailable');
      expect(calls).toBe(2);
      const rows = (await auditRows()).map(
        (a) => `${a.event_type}:${a.payload.market}`,
      );
      expect(rows.slice(2)).toEqual([
        'LEADER_ACQUIRED:KR',
        'LEADER_RELEASED:KR',
      ]);
      expect(await advisoryLocks()).toBe(0);
      expect(onLostHeld).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '11. releaseAll and partial release never promote a loss',
    async () => {
      const { r, onLostHeld } = registry();
      await r.acquireAll(new AbortController().signal);
      await r.releaseAll();
      await sleep(100);
      expect(onLostHeld).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '12. losing both held leases in one tick promotes exactly one re-election',
    async () => {
      const before = new Set(await backendPids());
      const { r, onLostHeld, metrics, logs } = registry({
        phase: () => 'SERVING',
      });
      const bundle = await r.acquireAll(new AbortController().signal);
      const leasePids = (await backendPids()).filter((pid) => !before.has(pid));
      expect(leasePids).toHaveLength(2);
      await observer.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where pid = any($1::int[])',
        [leasePids],
      );
      await vi.waitFor(() => expect(onLostHeld).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await sleep(300);
      expect(onLostHeld).toHaveBeenCalledTimes(1);
      expect(bundle.KR.isHeld || bundle.US.isHeld).toBe(false);
      expect(metrics.metrics()).toMatch(
        /leader_reelection_total\{market="(KR|US)"\} 1/,
      );
      expect(metrics.metrics()).toMatch(
        /lease_lost_total\{market="(KR|US)",phase="SERVING"\} 1/,
      );
      expect(logs.filter((l) => l.event === 'lease.lost')).toHaveLength(2);
      await r.releaseAll();
      expect(
        (await auditRows()).filter((a) => a.event_type === 'LEADER_RELEASED'),
      ).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '13. losing the held KR lease while US is pending aborts the generation instead of re-electing',
    async () => {
      await observer.query("select pg_try_advisory_lock(hashtext('US'))");
      const before = new Set(await backendPids());
      const { r, onLostHeld, metrics, logs } = registry({
        phase: () => 'ACQUIRING',
      });
      const acquiring = r.acquireAll(new AbortController().signal);
      await vi.waitFor(() => expect(r.pending).toBe('US'));
      const generation = r.generation;
      const krPid = (await backendPids()).find(
        (pid) => !before.has(pid) && pid !== undefined,
      );
      const [krRow] = (
        await observer.query(
          "select pid from pg_locks where locktype = 'advisory' and pid = any($1::int[])",
          [(await backendPids()).filter((p) => !before.has(p))],
        )
      ).rows;
      const target = Number(krRow?.pid ?? krPid);
      const terminatedAt = Date.now();
      await observer.query('select pg_terminate_backend($1)', [target]);
      await expect(acquiring).rejects.toBeInstanceOf(LeaseLostError);
      await expect(acquiring).rejects.toMatchObject({ market: 'KR' });
      expect(Date.now() - terminatedAt).toBeLessThan(
        LEASE_POLL_INTERVAL_MS + ROUND_TRIP_SLACK_MS + 500,
      );
      expect(onLostHeld).not.toHaveBeenCalled();
      expect(metrics.metrics()).toContain(
        'lease_lost_total{market="KR",phase="ACQUIRING"} 1',
      );
      expect(metrics.metrics()).not.toContain('leader_reelection_total');
      expect(
        (await auditRows()).map((a) => `${a.event_type}:${a.payload.market}`),
      ).toEqual(['LEADER_ACQUIRED:KR']);
      expect(await advisoryLocks()).toBe(1); // observer only
      expect(r.pending).toBeNull();
      expect(logs.some((l) => l.event === 'lease.lost')).toBe(true);
      await observer.query("select pg_advisory_unlock(hashtext('US'))");
      const bundle = await r.acquireAll(new AbortController().signal);
      expect(r.generation).toBeGreaterThan(generation);
      expect(bundle.KR.epoch).toBe(2n);
      expect(bundle.US.epoch).toBe(1n);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'abortPending aborts a waiting generation and resolves after cleanup',
    async () => {
      await observer.query("select pg_try_advisory_lock(hashtext('KR'))");
      const { r } = registry();
      const acquiring = r.acquireAll(new AbortController().signal);
      await vi.waitFor(() => expect(r.pending).toBe('KR'));
      await r.abortPending();
      await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
      expect(r.pending).toBeNull();
      expect(await auditRows()).toHaveLength(0);
      await r.abortPending();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('LeaderLease.acquire is only reachable through the bundle', () => {
  it('registry exposes acquireAll but no per-market acquire', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('./lease-registry.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/acquireAll\(/);
    expect(source).not.toMatch(/^\s+acquire\(/m);
    expect(typeof LeaderLease.acquire).toBe('function');
  });
});
