import { randomUUID } from 'node:crypto';
import { FakeConnectionLedger } from '@moi/market-data';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import WebSocket from 'ws';
import type { AppConfig } from '../config.js';
import { DEFAULT_FEE_SCHEDULES, ZERO_FEE_SCHEDULES } from '../config.js';
import { OutboxPublisherLoop } from '../modules/stream/outbox-publisher-loop.js';
import {
  ProductionRuntime,
  type RuntimePhaseSpy,
} from './production-runtime.js';
import {
  createFakeProviderBundle,
  type FakeProviderBundle,
} from './provider-bundle.js';

const OutboxPublisherLoopPrototype = OutboxPublisherLoop.prototype;

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 90_000;

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let observer: Client;
let databaseUrl: string;
const running: ProductionRuntime[] = [];

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:0',
    databaseUrl,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    sessionHashKeys: ['runtime-session-hash-key-32-bytes!'],
    csrfSecret: 'runtime-csrf-secret-at-least-32-bytes',
    adminApiKey: 'runtime-admin-key-at-least-32-bytes!',
    marketDataAdapter: 'fake',
    shutdownDrainDeadlineMs: 5_000,
    recoveryStabilityMs: 0,
    fees: ZERO_FEE_SCHEDULES,
    ...overrides,
  };
}

interface Started {
  runtime: ProductionRuntime;
  bundle: FakeProviderBundle;
  origin: string;
  phases: string[];
  logs: { event: string; fields: Record<string, unknown> }[];
  deferSnapshots?: Deferred;
}

async function start(
  options: {
    config?: Partial<AppConfig>;
    deferSnapshots?: boolean;
    bundle?: FakeProviderBundle;
    awaitServing?: boolean;
    verifyInvariants?: () => Promise<void>;
  } = {},
): Promise<Started> {
  const phases: string[] = [];
  const logs: Started['logs'] = [];
  const bundle = options.bundle ?? createFakeProviderBundle();
  const deferSnapshots = options.deferSnapshots ? new Deferred() : undefined;
  if (deferSnapshots) bundle.snapshots.gate = deferSnapshots.promise;
  const spy: RuntimePhaseSpy = (phase) => phases.push(phase);
  const runtime = new ProductionRuntime({
    config: config(options.config ?? {}),
    bundle,
    signals: false,
    log: (event, fields) => logs.push({ event, fields }),
    phaseSpy: spy,
    ...(options.verifyInvariants
      ? { verifyInvariants: options.verifyInvariants }
      : {}),
  });
  running.push(runtime);
  const started = runtime.start();
  if (options.awaitServing === false) {
    await runtime.listening;
  } else {
    await started;
  }
  const origin = `http://127.0.0.1:${runtime.port}`;
  return {
    runtime,
    bundle,
    origin,
    phases,
    logs,
    ...(deferSnapshots ? { deferSnapshots } : {}),
  };
}

const json = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
};
const auditRows = async (like: string) =>
  (
    await observer.query(
      'select event_type, payload from audit_events where event_type like $1 order by occurred_at, id',
      [like],
    )
  ).rows as { event_type: string; payload: Record<string, unknown> }[];
const epochs = async () =>
  Object.fromEntries(
    (
      await observer.query(
        'select market_code, epoch::text, leader_id, released_at from leader_epochs order by market_code',
      )
    ).rows.map((r) => [r.market_code, r]),
  );
const leaseBackendPid = async (leaderId: string, market: string) =>
  Number(
    (
      await observer.query(
        'select pid from pg_stat_activity where application_name = $1',
        [`moi-lease-${market}-${leaderId}`],
      )
    ).rows[0]?.pid,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function anonymousSession(origin: string) {
  const response = await fetch(`${origin}/api/v1/sessions/anonymous`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:0' },
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] as string;
  const body = (await response.json()) as {
    csrfToken: string;
    session: { id: string };
  };
  return { cookie, csrf: body.csrfToken, id: body.session.id };
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  databaseUrl = postgres.getConnectionUri();
  observer = new Client({ connectionString: databaseUrl });
  await observer.connect();
}, CONTAINER_TIMEOUT_MS);

afterEach(async () => {
  for (const runtime of running.splice(0))
    await runtime.stop().catch(() => undefined);
  await observer.query('select pg_advisory_unlock_all()');
  await observer.query('delete from safety_incidents');
  await observer.query('delete from leader_epochs');
  await observer.query(
    "delete from audit_events where event_type like 'LEADER_%' or event_type like 'RUNTIME_%' or event_type like 'RECOVERY_%'",
  );
});

afterAll(async () => {
  await observer?.end();
  await redis?.stop();
  await postgres?.stop();
});

describe('ProductionRuntime', () => {
  it(
    'A1: boots to SERVING with both markets NORMAL, two leases, and placement enabled',
    async () => {
      const { runtime, origin, bundle, phases } = await start();
      expect(runtime.state.current).toBe('SERVING');
      expect(phases).toEqual([
        'BOOTING',
        'RESTORING',
        'ACQUIRING_LEASES',
        'RECOVERING',
        'SERVING',
      ]);
      const ready = await json(`${origin}/health/ready`);
      expect(ready.status).toBe(200);
      const market = await json(`${origin}/health/market-data`);
      expect(market.body).toMatchObject({
        KR: { state: 'NORMAL' },
        US: { state: 'NORMAL' },
      });
      const trading = await json(`${origin}/api/v1/health/trading`);
      expect(trading.body).toMatchObject({
        placement: true,
        cancellation: true,
        fx: true,
        reasons: [],
      });
      const rows = await epochs();
      expect(rows.KR?.epoch).toBe('1');
      expect(rows.US?.epoch).toBe('1');
      expect(rows.KR?.released_at).toBeNull();
      expect(bundle.connectionsOpen()).toBe(2);
      expect(
        (await auditRows('RUNTIME_STATE_CHANGED')).some(
          (a) => a.payload.to === 'SERVING',
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A2: a transport close degrades one market only and recovers automatically',
    async () => {
      const { origin, bundle } = await start();
      bundle.streamFor('KR').emitTransportClosed('provider closed');
      await vi.waitFor(async () => {
        const market = await json(`${origin}/health/market-data`);
        expect(market.body.KR).toMatchObject({
          state: expect.stringMatching(/DEGRADED|RECOVERING/),
        });
        expect(market.body.US).toMatchObject({ state: 'NORMAL' });
      });
      await vi.waitFor(async () => {
        const during = await json(`${origin}/api/v1/health/trading`);
        expect(during.body.placement).toBe(true);
        expect(during.body.reasons).toContain('MARKET_DEGRADED:KR');
      });
      await vi.waitFor(
        async () => {
          expect(
            (await json(`${origin}/health/market-data`)).body.KR,
          ).toMatchObject({ state: 'NORMAL' });
        },
        { timeout: 10_000 },
      );
      expect((await json(`${origin}/metrics`)).status).toBe(200);
      const metrics = await (await fetch(`${origin}/metrics`)).text();
      expect(metrics).toContain('feed_reconnect_total{market="KR"} 1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A4: losing the KR lease re-elects globally, tears down both markets, and comes back SERVING',
    async () => {
      const { runtime, origin, bundle, phases, logs } = await start();
      const pauseSpy = vi.spyOn(runtime.publisher, 'pauseScheduling');
      const drainSpy = vi.spyOn(runtime.publisher, 'shutdownDrain');
      const reelectSpy = vi.spyOn(runtime, 'reelect');
      const closeKr = vi.spyOn(bundle.streamFor('KR'), 'close');
      const closeUs = vi.spyOn(bundle.streamFor('US'), 'close');
      const pid = await leaseBackendPid(runtime.leaderId, 'KR');
      expect(pid).toBeGreaterThan(0);
      // Hold the re-acquired bundle in RECOVERING so the closed gate is observable.
      const gate = new Deferred();
      bundle.snapshots.gate = gate.promise;
      let runningAtPause: boolean | undefined;
      pauseSpy.mockImplementation(function (this: unknown) {
        const result = OutboxPublisherLoopPrototype.pauseScheduling.call(
          runtime.publisher,
        );
        runningAtPause = runtime.publisher.isRunning();
        return result;
      });
      await observer.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => expect(phases).toContain('RE_ELECTING'), {
        timeout: 2_000,
      });
      await vi.waitFor(() => {
        expect(closeKr).toHaveBeenCalled();
        expect(closeUs).toHaveBeenCalled();
      });
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(runningAtPause).toBe(false);
      await vi.waitFor(() => expect(runtime.state.current).toBe('RECOVERING'), {
        timeout: 10_000,
      });
      expect(runtime.publisher.isRunning()).toBe(false);
      const upgrade = new WebSocket(
        `ws://127.0.0.1:${runtime.port}/api/v1/stream`,
        { headers: { origin: 'http://127.0.0.1:0' } },
      );
      const status = await new Promise<number>((resolve) => {
        upgrade.on('unexpected-response', (_r, res) =>
          resolve(res.statusCode ?? 0),
        );
        upgrade.on('error', () => undefined);
      });
      expect(status).toBe(503);
      gate.resolve();
      await vi.waitFor(() => expect(runtime.state.current).toBe('SERVING'), {
        timeout: 15_000,
      });
      expect(drainSpy).not.toHaveBeenCalled();
      expect(reelectSpy).toHaveBeenCalledTimes(1);
      const released = await auditRows('LEADER_RELEASED');
      expect(released.filter((a) => a.payload.market === 'US')).toHaveLength(1);
      expect(released.filter((a) => a.payload.market === 'KR')).toHaveLength(0);
      const incidents = (
        await observer.query(
          'select cause_code, scope_id from safety_incidents order by activated_at',
        )
      ).rows;
      expect(incidents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cause_code: 'LEADER_LEASE_LOST',
            scope_id: 'KR',
          }),
          expect.objectContaining({
            cause_code: 'LEADER_BUNDLE_BROKEN',
            scope_id: 'US',
          }),
        ]),
      );
      const rows = await epochs();
      expect(Number(rows.KR?.epoch)).toBeGreaterThan(1);
      expect(Number(rows.US?.epoch)).toBeGreaterThan(1);
      expect(
        (await auditRows('RUNTIME_STATE_CHANGED')).filter(
          (a) => a.payload.to === 'SERVING',
        ),
      ).toHaveLength(2);
      expect(logs.filter((l) => l.event === 'runtime.reelect')).toHaveLength(1);
      const metrics = await (await fetch(`${origin}/metrics`)).text();
      expect(metrics).toContain('leader_reelection_total{market="KR"} 1');
      expect(runtime.publisher.isRunning()).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A5: stop() follows the §6.6 order, drains the outbox, releases leases, and exits cleanly',
    async () => {
      const { runtime, phases, logs, origin, bundle } = await start();
      const order: string[] = [];
      const record = (name: string) => () => {
        order.push(name);
      };
      runtime.shutdownSpy = record;
      const session = await anonymousSession(origin);
      const stopped = await runtime.stop();
      expect(stopped.forced).toBe(false);
      expect(order).toEqual([
        'cancelOnly',
        'gate.close',
        'gate.drain',
        'uow.drain',
        'pendingPoll',
        'shutdownDrain',
        'closeSockets',
        'abortPending',
        'releaseAll',
      ]);
      expect(phases.slice(-2)).toEqual(['DRAINING', 'STOPPED']);
      expect(bundle.connectionsOpen()).toBe(0);
      const audits = (await auditRows('RUNTIME_%')).map((a) => a.event_type);
      expect(audits).toContain('RUNTIME_DRAINING');
      expect(audits.at(-1)).toBe('RUNTIME_STOPPED');
      expect(await auditRows('LEADER_RELEASED')).toHaveLength(2);
      expect(logs.filter((l) => l.event === 'outbox.drain')).toHaveLength(1);
      expect(
        logs.find((l) => l.event === 'outbox.drain')?.fields,
      ).toMatchObject({ skipped: false });
      expect(
        Object.values(await epochs()).every(
          (r) => (r as { released_at: unknown }).released_at !== null,
        ),
      ).toBe(true);
      expect(session.id).toBeTypeOf('string');
      expect(
        (
          await observer.query(
            'select count(*)::int as n from outbox_events where published_at is null',
          )
        ).rows[0].n,
      ).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A5b/A15: stopping while waiting for leases makes zero provider calls and exits within 2 s',
    async () => {
      await observer.query("select pg_try_advisory_lock(hashtext('KR'))");
      const { runtime, bundle, logs, origin } = await start({
        awaitServing: false,
      });
      await vi.waitFor(() =>
        expect(runtime.state.current).toBe('ACQUIRING_LEASES'),
      );
      await vi.waitFor(() =>
        expect(
          logs.some(
            (l) => l.event === 'lease.waiting' && l.fields.market === 'KR',
          ),
        ).toBe(true),
      );
      const trading = await json(`${origin}/api/v1/health/trading`);
      expect(trading.body).toMatchObject({
        placement: false,
        cancellation: true,
        fx: false,
        reasons: ['CANCEL_ONLY', 'ACQUIRING_LEASES'],
      });
      expect((await json(`${origin}/health/ready`)).status).toBe(200);
      expect((await json(`${origin}/health/market-data`)).body).toMatchObject({
        KR: { state: 'RECOVERING', reasons: ['LEADER_LEASE_PENDING'] },
      });
      const startSpy = vi.spyOn(runtime.publisher, 'start');
      const drainSpy = vi.spyOn(runtime.publisher, 'shutdownDrain');
      const startedAt = Date.now();
      const result = await runtime.stop();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.forced).toBe(false);
      expect(bundle.connectCalls()).toBe(0);
      expect(bundle.snapshotCalls()).toBe(0);
      expect(startSpy).not.toHaveBeenCalled();
      expect(drainSpy).not.toHaveBeenCalled();
      expect(
        logs.find((l) => l.event === 'outbox.drain')?.fields,
      ).toMatchObject({ skipped: true, leftFrom: 'ACQUIRING_LEASES' });
      expect(await auditRows('LEADER_ACQUIRED')).toHaveLength(0);
      expect((await auditRows('RUNTIME_%')).map((a) => a.event_type)).toEqual(
        expect.arrayContaining(['RUNTIME_DRAINING', 'RUNTIME_STOPPED']),
      );
      await observer.query("select pg_advisory_unlock(hashtext('KR'))");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A17: the stream gate and publisher flip together; RECOVERING neither publishes nor accepts upgrades',
    async () => {
      const { runtime, origin, deferSnapshots, bundle } = await start({
        deferSnapshots: true,
        awaitServing: false,
      });
      await vi.waitFor(() => expect(runtime.state.current).toBe('RECOVERING'), {
        timeout: 10_000,
      });
      expect(runtime.publisher.isRunning()).toBe(false);
      const claimSpy = vi.spyOn(runtime, 'claimOutboxForTest');
      const session = await anonymousSession(origin);
      const rejected = new WebSocket(
        `ws://127.0.0.1:${runtime.port}/api/v1/stream`,
        { headers: { origin: 'http://127.0.0.1:0', cookie: session.cookie } },
      );
      const status = await new Promise<number>((resolve) => {
        rejected.on('unexpected-response', (_r, res) =>
          resolve(res.statusCode ?? 0),
        );
        rejected.on('error', () => undefined);
      });
      expect(status).toBe(503);
      await sleep(300);
      expect(claimSpy).not.toHaveBeenCalled();
      let observedMismatch = 0;
      const observe = () => {
        if (runtime.state.gate().isOpen() !== runtime.publisher.isRunning())
          observedMismatch += 1;
      };
      const interval = setInterval(observe, 1);
      deferSnapshots?.resolve();
      await vi.waitFor(() => expect(runtime.state.current).toBe('SERVING'), {
        timeout: 10_000,
      });
      clearInterval(interval);
      expect(observedMismatch).toBe(0);
      expect(runtime.publisher.isRunning()).toBe(true);
      const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/api/v1/stream`, {
        headers: { origin: 'http://127.0.0.1:0', cookie: session.cookie },
      });
      const messages: Record<string, unknown>[] = [];
      ws.on('message', (d) => messages.push(JSON.parse(String(d))));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      await vi.waitFor(() =>
        expect(messages.some((m) => m.type === 'ready')).toBe(true),
      );
      // A6: an outbox row appended in a transaction reaches the live socket
      await observer.query(
        `insert into account_sequences (id, session_id, account_sequence, mutation_kind) values ($1, $2, 1, 'TEST')`,
        [randomUUID(), session.id],
      );
      await observer.query(
        `insert into outbox_events (id, event_id, session_id, stream_sequence, event_type, payload) values ($1, $2, $3, 1, 'TEST_EVENT', '{"hello":true}')`,
        [randomUUID(), randomUUID(), session.id],
      );
      await vi.waitFor(
        () =>
          expect(
            messages.some(
              (m) => m.type === 'event' && m.eventType === 'TEST_EVENT',
            ),
          ).toBe(true),
        { timeout: 2_000 },
      );
      ws.send('{"afterSequence":"1"}');
      const code = await new Promise<number>((resolve) =>
        ws.once('close', (c) => resolve(c)),
      );
      expect(code).toBe(1003);
      expect(bundle.connectionsOpen()).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A7: a failing invariant check records a manual GLOBAL incident and rejects startup',
    async () => {
      const runtime = new ProductionRuntime({
        config: config(),
        bundle: createFakeProviderBundle(),
        signals: false,
        verifyInvariants: async () => {
          throw new Error('ledger broken');
        },
      });
      running.push(runtime);
      await expect(runtime.start()).rejects.toThrow('ledger broken');
      expect(runtime.state.current).toBe('FAILED_CLOSED');
      const incidents = (
        await observer.query(
          'select scope_type, source, cause_code, status from safety_incidents',
        )
      ).rows;
      expect(incidents).toEqual([
        expect.objectContaining({
          scope_type: 'GLOBAL',
          source: 'MANUAL',
          cause_code: 'STARTUP_INVARIANT_OR_AUDIT_FAILURE',
          status: 'ACTIVE',
        }),
      ]);
      await runtime.stop();
      // restart: the persisted incident keeps trading CANCEL_ONLY
      const { origin } = await start();
      const trading = await json(`${origin}/api/v1/health/trading`);
      expect(trading.body.placement).toBe(false);
      expect(trading.body.reasons).toContain(
        'GLOBAL_INCIDENT:STARTUP_INVARIANT_OR_AUDIT_FAILURE',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A16b: losing KR during a partial bundle aborts the generation without re-election and retries',
    async () => {
      await observer.query("select pg_try_advisory_lock(hashtext('US'))");
      const { runtime, bundle, logs, phases } = await start({
        awaitServing: false,
      });
      const reelectSpy = vi.spyOn(runtime, 'reelect');
      await vi.waitFor(() => expect(runtime.leases.pending).toBe('US'), {
        timeout: 5_000,
      });
      const pid = await leaseBackendPid(runtime.leaderId, 'KR');
      await observer.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(
        () =>
          expect(
            logs.filter(
              (l) => l.event === 'lease.acquired' && l.fields.market === 'KR',
            ).length,
          ).toBeGreaterThanOrEqual(2),
        { timeout: 5_000 },
      );
      await vi.waitFor(() => expect(runtime.leases.pending).toBe('US'), {
        timeout: 5_000,
      });
      expect(phases).not.toContain('RE_ELECTING');
      expect(reelectSpy).not.toHaveBeenCalled();
      expect(bundle.connectCalls()).toBe(0);
      await observer.query("select pg_advisory_unlock(hashtext('US'))");
      await vi.waitFor(() => expect(runtime.state.current).toBe('SERVING'), {
        timeout: 15_000,
      });
      const rows = await epochs();
      expect(rows.KR?.epoch).toBe('2');
      expect(rows.US?.epoch).toBe('1');
      const metrics = await (
        await fetch(`http://127.0.0.1:${runtime.port}/metrics`)
      ).text();
      expect(metrics).toContain(
        'lease_lost_total{market="KR",phase="ACQUIRING"} 1',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A15 variant 2: SIGTERM during RECOVERING aborts recovery with no new provider calls and exits cleanly',
    async () => {
      const { runtime, bundle, logs } = await start({
        deferSnapshots: true,
        awaitServing: false,
      });
      await vi.waitFor(() => expect(runtime.state.current).toBe('RECOVERING'), {
        timeout: 10_000,
      });
      const startSpy = vi.spyOn(runtime.publisher, 'start');
      const connectsBefore = bundle.connectCalls();
      const snapshotsBefore = bundle.snapshotCalls();
      const startedAt = Date.now();
      const result = await runtime.stop();
      expect(result.forced).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(bundle.connectCalls()).toBe(connectsBefore);
      expect(bundle.snapshotCalls()).toBe(snapshotsBefore);
      expect(startSpy).not.toHaveBeenCalled();
      expect(logs.filter((l) => l.event === 'recovery.complete')).toHaveLength(
        0,
      );
      expect(await auditRows('RECOVERY_COMPLETED')).toHaveLength(0);
      expect(await auditRows('LEADER_RELEASED')).toHaveLength(2);
      expect(
        logs.find((l) => l.event === 'outbox.drain')?.fields,
      ).toMatchObject({ skipped: true, leftFrom: 'RECOVERING' });
      expect(bundle.connectionsOpen()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A4b: losing a lease while RECOVERING re-elects once, aborts the in-flight recovery, then reaches SERVING',
    async () => {
      const { runtime, bundle, logs, phases, deferSnapshots } = await start({
        deferSnapshots: true,
        awaitServing: false,
      });
      await vi.waitFor(() => expect(runtime.state.current).toBe('RECOVERING'), {
        timeout: 10_000,
      });
      const reelectSpy = vi.spyOn(runtime, 'reelect');
      const pid = await leaseBackendPid(runtime.leaderId, 'KR');
      const connectsAtLoss = bundle.connectCalls();
      await observer.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => expect(phases).toContain('RE_ELECTING'), {
        timeout: 3_000,
      });
      expect(logs.filter((l) => l.event === 'recovery.complete')).toHaveLength(
        0,
      );
      expect(reelectSpy).toHaveBeenCalledTimes(1);
      // Nothing new is requested from the provider until the bundle is re-acquired.
      await sleep(300);
      expect(bundle.connectCalls()).toBe(connectsAtLoss);
      deferSnapshots?.resolve();
      await vi.waitFor(() => expect(runtime.state.current).toBe('SERVING'), {
        timeout: 20_000,
      });
      expect(reelectSpy).toHaveBeenCalledTimes(1);
      expect(
        (await auditRows('LEADER_RELEASED')).filter(
          (a) => a.payload.market === 'US',
        ),
      ).toHaveLength(1);
      const rows = await epochs();
      expect(Number(rows.KR?.epoch)).toBeGreaterThan(1);
      expect(Number(rows.US?.epoch)).toBeGreaterThan(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'A16: a waiting second runtime wins the bundle after the leader loses one lease; no split bundle is ever observed',
    async () => {
      const ledger = new FakeConnectionLedger();
      const r1 = await start({ bundle: createFakeProviderBundle({ ledger }) });
      const r2 = await start({
        bundle: createFakeProviderBundle({ ledger }),
        awaitServing: false,
      });
      await vi.waitFor(() =>
        expect(r2.runtime.state.current).toBe('ACQUIRING_LEASES'),
      );
      await vi.waitFor(() => expect(r2.runtime.leases.pending).toBe('KR'), {
        timeout: 5_000,
      });
      let splitObserved = 0;
      const poll = setInterval(() => {
        void observer
          .query(
            'select leader_id from leader_epochs where released_at is null',
          )
          .then((r) => {
            const ids = new Set(r.rows.map((row) => row.leader_id));
            if (r.rows.length === 2 && ids.size === 2) splitObserved += 1;
          })
          .catch(() => undefined);
      }, 100);
      const pid = await leaseBackendPid(r1.runtime.leaderId, 'KR');
      await observer.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => expect(r1.phases).toContain('RE_ELECTING'), {
        timeout: 3_000,
      });
      await vi.waitFor(() => expect(r2.runtime.state.current).toBe('SERVING'), {
        timeout: 15_000,
      });
      clearInterval(poll);
      expect(splitObserved).toBe(0);
      expect(ledger.peak).toBeLessThanOrEqual(2);
      const rows = await epochs();
      expect(rows.KR?.leader_id).toBe(r2.runtime.leaderId);
      expect(rows.US?.leader_id).toBe(r2.runtime.leaderId);
      expect(Number(rows.KR?.epoch)).toBeGreaterThan(1);
      expect(Number(rows.US?.epoch)).toBeGreaterThan(1);
      expect(
        (await auditRows('LEADER_RELEASED'))
          .filter((a) => a.payload.leaderId === r1.runtime.leaderId)
          .map((a) => a.payload.market),
      ).toEqual(['US']);
      // R1 keeps polling while R2 is alive, then stops fast with no provider calls.
      await vi.waitFor(
        () => expect(r1.runtime.state.current).toBe('ACQUIRING_LEASES'),
        { timeout: 5_000 },
      );
      const connectsBefore = r1.bundle.connectCalls();
      const startedAt = Date.now();
      await r1.runtime.stop();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(r1.bundle.connectCalls()).toBe(connectsBefore);
      expect(r2.runtime.state.current).toBe('SERVING');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'RESTORING loads open and pending-trigger orders into the engine so a new leader keeps matching them (§6.1)',
    async () => {
      const first = await start();
      const client = await anonymousSession(first.origin);
      const headers = {
        origin: 'http://127.0.0.1:0',
        cookie: client.cookie,
        'x-csrf-token': client.csrf,
        'content-type': 'application/json',
      };
      const place = async (body: Record<string, unknown>) =>
        json(`${first.origin}/api/v1/orders`, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          body: JSON.stringify(body),
        });
      // A resting LIMIT far below the book and a pending STOP.
      first.bundle.streamFor('US').emitOrderBook({
        market: 'US',
        symbol: 'AAPL',
        book: {
          market: 'US',
          symbol: 'AAPL',
          currency: 'USD',
          asks: [{ price: '190.30', volume: '100' }],
          bids: [{ price: '190.20', volume: '100' }],
        },
        sourceTimestamp: null,
      });
      await sleep(200);
      const fxQuote = await json(`${first.origin}/api/v1/fx/quotes`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ from: 'KRW', to: 'USD', amount: '10000000' }),
      });
      expect(fxQuote.status, JSON.stringify(fxQuote.body)).toBeLessThan(300);
      const fxDone = await json(`${first.origin}/api/v1/fx/conversions`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ quoteId: fxQuote.body.quoteId }),
      });
      expect(fxDone.status, JSON.stringify(fxDone.body)).toBeLessThan(300);
      const limit = await place({
        market: 'US',
        symbol: 'AAPL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '2',
        limitPrice: '100.00',
      });
      expect(limit.status, JSON.stringify(limit.body)).toBeLessThan(300);
      const stop = await place({
        market: 'US',
        symbol: 'AAPL',
        side: 'BUY',
        type: 'STOP',
        quantity: '1',
        stopPrice: '300.00',
      });
      expect(stop.status, JSON.stringify(stop.body)).toBeLessThan(300);
      const limitId = String((limit.body as { id?: string }).id);
      const stopId = String((stop.body as { id?: string }).id);
      expect(
        (
          await observer.query('select status from orders where id = $1', [
            limitId,
          ])
        ).rows[0]?.status,
      ).toBe('OPEN');
      expect(
        (
          await observer.query('select status from orders where id = $1', [
            stopId,
          ])
        ).rows[0]?.status,
      ).toBe('PENDING_TRIGGER'); // a single STOP waits for its trigger in the engine
      await first.runtime.stop();

      const second = await start();
      const engine = second.runtime.engineFor('US');
      expect(engine.getOrder(limitId)).toMatchObject({
        status: 'OPEN',
        type: 'LIMIT',
        quantity: '2',
        filledQuantity: '0',
      });
      expect(engine.getOrder(stopId)).toMatchObject({
        status: 'PENDING_TRIGGER',
        type: 'STOP',
      });
      // A crossing book on the new leader fills the restored LIMIT under epoch 2.
      second.bundle.streamFor('US').emitOrderBook({
        market: 'US',
        symbol: 'AAPL',
        book: {
          market: 'US',
          symbol: 'AAPL',
          currency: 'USD',
          asks: [{ price: '99.00', volume: '100' }],
          bids: [{ price: '98.00', volume: '100' }],
        },
        sourceTimestamp: null,
      });
      await vi.waitFor(
        async () => {
          const row = (
            await observer.query(
              'select status, filled_quantity::text as filled from orders where id = $1',
              [limitId],
            )
          ).rows[0];
          expect(row).toMatchObject({ status: 'FILLED', filled: '2' });
        },
        { timeout: 5_000 },
      );
      const fills = (
        await observer.query(
          'select recovery_epoch::text as epoch from fills where order_id = $1',
          [limitId],
        )
      ).rows;
      expect(fills.length).toBeGreaterThanOrEqual(1);
      expect(fills.every((f) => f.epoch === '2')).toBe(true);
      // Cancelling the restored STOP through the new leader works.
      const cancel = await json(`${second.origin}/api/v1/orders/${stopId}`, {
        method: 'DELETE',
        headers: {
          origin: 'http://127.0.0.1:0',
          cookie: client.cookie,
          'x-csrf-token': client.csrf,
          'idempotency-key': randomUUID(),
        },
      });
      expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);
      expect(engine.getOrder(stopId)?.status).toBe('CANCELLED');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serves instrument search, quotes, and virtual FX in production; FX is refused while not SERVING',
    async () => {
      await observer.query("select pg_try_advisory_lock(hashtext('KR'))");
      const waiting = await start({ awaitServing: false });
      await vi.waitFor(() =>
        expect(waiting.runtime.state.current).toBe('ACQUIRING_LEASES'),
      );
      const client = await anonymousSession(waiting.origin);
      const headers = (extra: Record<string, string> = {}) => ({
        origin: 'http://127.0.0.1:0',
        cookie: client.cookie,
        'x-csrf-token': client.csrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        ...extra,
      });
      const search = await json(`${waiting.origin}/api/v1/instruments?q=AAPL`);
      expect(search.status).toBe(200);
      expect(search.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            market: 'US',
            symbol: 'AAPL',
            tradable: true,
          }),
        ]),
      );
      const blocked = await json(`${waiting.origin}/api/v1/fx/quotes`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ from: 'KRW', to: 'USD', amount: '10000' }),
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CANCEL_ONLY');
      await observer.query("select pg_advisory_unlock(hashtext('KR'))");
      await vi.waitFor(
        () => expect(waiting.runtime.state.current).toBe('SERVING'),
        { timeout: 15_000 },
      );

      waiting.bundle.streamFor('US').emitOrderBook({
        market: 'US',
        symbol: 'AAPL',
        book: {
          market: 'US',
          symbol: 'AAPL',
          currency: 'USD',
          asks: [{ price: '190.30', volume: '100' }],
          bids: [{ price: '190.20', volume: '100' }],
        },
        sourceTimestamp: null,
      });
      await vi.waitFor(async () => {
        const quote = await json(
          `${waiting.origin}/api/v1/markets/US/symbols/AAPL/quote`,
        );
        expect(quote.body).toMatchObject({
          market: 'US',
          symbol: 'AAPL',
          price: '190.30',
          health: 'HEALTHY',
        });
      });
      const quote = await json(`${waiting.origin}/api/v1/fx/quotes`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ from: 'KRW', to: 'USD', amount: '10000' }),
      });
      expect(quote.status, JSON.stringify(quote.body)).toBeLessThan(300);
      const conversion = await json(`${waiting.origin}/api/v1/fx/conversions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ quoteId: quote.body.quoteId }),
      });
      expect(conversion.status, JSON.stringify(conversion.body)).toBeLessThan(
        300,
      );
      const wallets = (
        await observer.query(
          'select currency, total::text as total, available::text as available from wallets where session_id = $1 order by currency',
          [client.id],
        )
      ).rows;
      expect(wallets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            currency: 'KRW',
            total: '9990000',
            available: '9990000',
          }),
          expect.objectContaining({
            currency: 'USD',
            total: '7',
            available: '7',
          }),
        ]),
      );
      const outbox = (
        await observer.query(
          "select event_type from outbox_events where session_id = $1 and event_type = 'FX_CONVERTED'",
          [client.id],
        )
      ).rows;
      expect(outbox).toHaveLength(1);
      expect(
        (
          await observer.query(
            "select count(*)::int as n from audit_events where event_type = 'FX_CONVERTED' and session_reference = $1",
            [client.id],
          )
        ).rows[0]?.n,
      ).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'persists STOP triggers and resolves OCO groups from the production engine (Codex BLOCKER)',
    async () => {
      const { runtime, origin, bundle } = await start();
      const client = await anonymousSession(origin);
      const headers = () => ({
        origin: 'http://127.0.0.1:0',
        cookie: client.cookie,
        'x-csrf-token': client.csrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      });
      const place = (body: Record<string, unknown>) =>
        json(`${origin}/api/v1/orders`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });
      const book = (ask: string, bid: string) =>
        bundle.streamFor('US').emitOrderBook({
          market: 'US',
          symbol: 'AAPL',
          book: {
            market: 'US',
            symbol: 'AAPL',
            currency: 'USD',
            asks: [{ price: ask, volume: '100' }],
            bids: [{ price: bid, volume: '100' }],
          },
          sourceTimestamp: null,
        });
      book('190.30', '190.20');
      await sleep(200);
      const fx = await json(`${origin}/api/v1/fx/quotes`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ from: 'KRW', to: 'USD', amount: '10000000' }),
      });
      expect(fx.status, JSON.stringify(fx.body)).toBeLessThan(300);
      const conversion = await json(`${origin}/api/v1/fx/conversions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ quoteId: fx.body.quoteId }),
      });
      expect(conversion.status, JSON.stringify(conversion.body)).toBeLessThan(
        300,
      );
      // Single STOP BUY above the market.
      const stop = await place({
        market: 'US',
        symbol: 'AAPL',
        side: 'BUY',
        type: 'STOP',
        quantity: '1',
        stopPrice: '200.00',
      });
      expect(stop.status, JSON.stringify(stop.body)).toBeLessThan(300);
      const stopId = String((stop.body as { id?: string }).id);
      // OCO BUY: TAKE_PROFIT leg (LIMIT 180) + STOP leg (200).
      const oco = await place({
        market: 'US',
        symbol: 'AAPL',
        side: 'BUY',
        type: 'OCO',
        quantity: '1',
        legs: [
          {
            market: 'US',
            symbol: 'AAPL',
            side: 'BUY',
            type: 'LIMIT',
            quantity: '1',
            limitPrice: '180.00',
          },
          {
            market: 'US',
            symbol: 'AAPL',
            side: 'BUY',
            type: 'STOP',
            quantity: '1',
            stopPrice: '200.00',
          },
        ],
      });
      expect(oco.status, JSON.stringify(oco.body)).toBeLessThan(300);
      const ocoLegId = String((oco.body as { id?: string }).id);
      const group = (
        await observer.query(
          'select oco_group_id::text as g from orders where id = $1',
          [ocoLegId],
        )
      ).rows[0]?.g as string;
      expect(group).toBeTypeOf('string');

      bundle.streamFor('US').emitTrade({
        market: 'US',
        symbol: 'AAPL',
        price: '201.00',
        volume: '5',
        sourceTimestamp: null,
      });
      await vi.waitFor(
        async () => {
          const row = (
            await observer.query(
              'select status, filled_quantity::text as filled from orders where id = $1',
              [stopId],
            )
          ).rows[0];
          expect(row).toMatchObject({ status: 'FILLED', filled: '1' });
        },
        { timeout: 5_000 },
      );
      const fill = (
        await observer.query(
          'select price::text as price, recovery_epoch::text as epoch from fills where order_id = $1',
          [stopId],
        )
      ).rows[0];
      expect(fill).toMatchObject({ price: '201.00', epoch: '1' });
      expect(runtime.engineFor('US').getOrder(stopId)?.status).toBe(
        'TRIGGERED',
      );

      await vi.waitFor(
        async () => {
          const legs = (
            await observer.query(
              'select order_type, status, is_oco_winner from orders where oco_group_id = $1 order by order_type',
              [group],
            )
          ).rows;
          expect(legs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                order_type: 'STOP',
                status: 'FILLED',
                is_oco_winner: true,
              }),
              expect.objectContaining({
                order_type: 'LIMIT',
                status: 'CANCELLED',
                is_oco_winner: false,
              }),
            ]),
          );
        },
        { timeout: 5_000 },
      );
      expect(
        (
          await observer.query('select status from oco_groups where id = $1', [
            group,
          ])
        ).rows[0]?.status,
      ).toBe('RESOLVED');
      expect(
        (
          await observer.query(
            'select count(*)::int as n from reservations where oco_group_id = $1 and released = false',
            [group],
          )
        ).rows[0]?.n,
      ).toBe(0);
      const events = (
        await observer.query(
          'select event_type from outbox_events where session_id = $1 order by stream_sequence',
          [client.id],
        )
      ).rows.map((r) => r.event_type);
      expect(events.filter((e) => e === 'ORDER_FILLED')).toHaveLength(2);
      expect(events).toContain('ORDER_CANCELLED');
      expect(events).toContain('OCO_RESOLVED');
      // The audit trail names each fill and the cancelled sibling.
      expect(
        (
          await observer.query(
            "select count(*)::int as n from audit_events where session_reference = $1 and event_type in ('ORDER_FILLED','ORDER_CANCELLED','OCO_RESOLVED')",
            [client.id],
          )
        ).rows[0]?.n,
      ).toBe(4);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reserves cash for single orders, settles fills against the wallet, and releases on cancel',
    async () => {
      const { runtime, origin, bundle } = await start();
      const client = await anonymousSession(origin);
      const headers = () => ({
        origin: 'http://127.0.0.1:0',
        cookie: client.cookie,
        'x-csrf-token': client.csrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      });
      const place = (body: Record<string, unknown>) =>
        json(`${origin}/api/v1/orders`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        });
      const wallet = async (currency: string) =>
        (
          await observer.query(
            'select total::text as total, available::text as available, reserved::text as reserved from wallets where session_id = $1 and currency = $2',
            [client.id, currency],
          )
        ).rows[0];
      bundle.streamFor('KR').emitOrderBook({
        market: 'KR',
        symbol: '005930',
        book: {
          market: 'KR',
          symbol: '005930',
          currency: 'KRW',
          asks: [{ price: '70000', volume: '10' }],
          bids: [{ price: '69900', volume: '10' }],
        },
        sourceTimestamp: null,
      });
      await sleep(200);

      // A resting LIMIT BUY below the ask reserves its notional.
      const resting = await place({
        market: 'KR',
        symbol: '005930',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '2',
        limitPrice: '69000',
      });
      expect(resting.status, JSON.stringify(resting.body)).toBe(201);
      const restingId = String((resting.body as { id?: string }).id);
      expect(await wallet('KRW')).toEqual({
        total: '10000000',
        available: '9862000',
        reserved: '138000',
      });
      expect(
        (
          await observer.query(
            'select kind, amount::text as amount, released from reservations where order_id = $1',
            [restingId],
          )
        ).rows,
      ).toEqual([{ kind: 'CASH', amount: '138000', released: false }]);

      // Selling without a position is refused before anything is written.
      const shortSell = await place({
        market: 'KR',
        symbol: '005930',
        side: 'SELL',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '71000',
      });
      expect(shortSell.status).toBe(409);
      expect(shortSell.body.code).toBe('INSUFFICIENT_AVAILABLE_POSITION');

      // A marketable LIMIT BUY fills at the ask and settles: cash leaves total,
      // the reservation is consumed and released, the position carries its cost.
      const filled = await place({
        market: 'KR',
        symbol: '005930',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '70000',
      });
      expect(filled.status, JSON.stringify(filled.body)).toBe(201);
      const filledId = String((filled.body as { id?: string }).id);
      await vi.waitFor(
        async () => {
          expect(
            (
              await observer.query('select status from orders where id = $1', [
                filledId,
              ])
            ).rows[0]?.status,
          ).toBe('FILLED');
        },
        { timeout: 5_000 },
      );
      expect(await wallet('KRW')).toEqual({
        total: '9930000',
        available: '9792000',
        reserved: '138000',
      });
      expect(
        (
          await observer.query(
            'select released from reservations where order_id = $1',
            [filledId],
          )
        ).rows[0]?.released,
      ).toBe(true);
      expect(
        (
          await observer.query(
            'select total_quantity::text as q, available_quantity::text as a, average_cost::text as c from positions where session_id = $1 and symbol = $2',
            [client.id, '005930'],
          )
        ).rows[0],
      ).toEqual({ q: '1', a: '1', c: '70000' });

      // Cancelling the resting order hands its reservation back.
      const { 'content-type': _json, ...cancelHeaders } = headers();
      const cancel = await json(`${origin}/api/v1/orders/${restingId}`, {
        method: 'DELETE',
        headers: cancelHeaders,
      });
      expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);
      expect(await wallet('KRW')).toEqual({
        total: '9930000',
        available: '9930000',
        reserved: '0',
      });
      expect(
        (
          await observer.query(
            'select count(*)::int as n from reservations where session_id = $1 and released = false',
            [client.id],
          )
        ).rows[0]?.n,
      ).toBe(0);

      // A SELL now reserves the position and, when filled at the bid, credits proceeds.
      const sell = await place({
        market: 'KR',
        symbol: '005930',
        side: 'SELL',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '69900',
      });
      expect(sell.status, JSON.stringify(sell.body)).toBe(201);
      const sellId = String((sell.body as { id?: string }).id);
      await vi.waitFor(
        async () => {
          expect(
            (
              await observer.query('select status from orders where id = $1', [
                sellId,
              ])
            ).rows[0]?.status,
          ).toBe('FILLED');
        },
        { timeout: 5_000 },
      );
      expect(await wallet('KRW')).toEqual({
        total: '9999900',
        available: '9999900',
        reserved: '0',
      });
      expect(
        (
          await observer.query(
            'select total_quantity::text as q, reserved_quantity::text as r from positions where session_id = $1 and symbol = $2',
            [client.id, '005930'],
          )
        ).rows[0],
      ).toEqual({ q: '0', r: '0' });
      expect(runtime.engineFor('KR').getOrder(sellId)?.status).toBe('FILLED');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cancelling one OCO leg cancels the bracket, resolves the group, and releases the shared reservation',
    async () => {
      const { origin, bundle } = await start();
      const client = await anonymousSession(origin);
      const headers = () => ({
        origin: 'http://127.0.0.1:0',
        cookie: client.cookie,
        'x-csrf-token': client.csrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      });
      bundle.streamFor('KR').emitOrderBook({
        market: 'KR',
        symbol: '005930',
        book: {
          market: 'KR',
          symbol: '005930',
          currency: 'KRW',
          asks: [{ price: '70000', volume: '10' }],
          bids: [{ price: '69900', volume: '10' }],
        },
        sourceTimestamp: null,
      });
      await sleep(200);
      const oco = await json(`${origin}/api/v1/orders`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          market: 'KR',
          symbol: '005930',
          side: 'BUY',
          type: 'OCO',
          quantity: '1',
          legs: [
            {
              market: 'KR',
              symbol: '005930',
              side: 'BUY',
              type: 'LIMIT',
              quantity: '1',
              limitPrice: '60000',
            },
            {
              market: 'KR',
              symbol: '005930',
              side: 'BUY',
              type: 'STOP',
              quantity: '1',
              stopPrice: '80000',
            },
          ],
        }),
      });
      expect(oco.status, JSON.stringify(oco.body)).toBe(201);
      const legId = String((oco.body as { id?: string }).id);
      const group = (
        await observer.query(
          'select oco_group_id::text as g from orders where id = $1',
          [legId],
        )
      ).rows[0]?.g as string;
      const before = (
        await observer.query(
          'select reserved::text as reserved from wallets where session_id = $1 and currency = $2',
          [client.id, 'KRW'],
        )
      ).rows[0];
      expect(Number(before?.reserved)).toBeGreaterThan(0);

      const { 'content-type': _json, ...cancelHeaders } = headers();
      const cancel = await json(`${origin}/api/v1/orders/${legId}`, {
        method: 'DELETE',
        headers: cancelHeaders,
      });
      expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);

      const legs = (
        await observer.query(
          'select status from orders where oco_group_id = $1',
          [group],
        )
      ).rows.map((r) => r.status);
      expect(legs).toEqual(['CANCELLED', 'CANCELLED']);
      expect(
        (
          await observer.query('select status from oco_groups where id = $1', [
            group,
          ])
        ).rows[0]?.status,
      ).toBe('RESOLVED');
      expect(
        (
          await observer.query(
            'select count(*)::int as n from reservations where oco_group_id = $1 and released = false',
            [group],
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await observer.query(
            'select reserved::text as reserved, total::text as total, available::text as available from wallets where session_id = $1 and currency = $2',
            [client.id, 'KRW'],
          )
        ).rows[0],
      ).toEqual({ reserved: '0', total: '10000000', available: '10000000' });
      const events = (
        await observer.query(
          "select event_type, payload from outbox_events where session_id = $1 and event_type = 'ORDER_CANCELLED'",
          [client.id],
        )
      ).rows;
      expect(events).toHaveLength(2);
      expect(
        events.map((e) => (e.payload as { reason?: string }).reason).sort(),
      ).toEqual(['OCO_SIBLING_CANCELLED', 'USER']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'publishes the configured fee schedule, charges fees on fills, and refuses a silently changed rate',
    async () => {
      const { origin, bundle } = await start({
        config: { fees: DEFAULT_FEE_SCHEDULES },
      });
      const versions = (
        await observer.query(
          'select market_code, version_number::text as v, status, schedule from fee_model_versions where version_number = 1 order by market_code',
        )
      ).rows;
      expect(versions).toEqual([
        expect.objectContaining({
          market_code: 'KR',
          v: '1',
          status: 'PUBLISHED',
          schedule: expect.objectContaining({
            commissionRate: '0.00015',
            sellTaxRate: '0.0015',
          }),
        }),
        expect.objectContaining({
          market_code: 'US',
          v: '1',
          status: 'PUBLISHED',
          schedule: expect.objectContaining({
            commissionRate: '0.0025',
            sellTaxRate: '0',
          }),
        }),
      ]);
      const client = await anonymousSession(origin);
      const headers = () => ({
        origin: 'http://127.0.0.1:0',
        cookie: client.cookie,
        'x-csrf-token': client.csrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      });
      bundle.streamFor('KR').emitOrderBook({
        market: 'KR',
        symbol: '005930',
        book: {
          market: 'KR',
          symbol: '005930',
          currency: 'KRW',
          asks: [{ price: '70000', volume: '10' }],
          bids: [{ price: '69900', volume: '10' }],
        },
        sourceTimestamp: null,
      });
      await sleep(200);
      const buy = await json(`${origin}/api/v1/orders`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          market: 'KR',
          symbol: '005930',
          side: 'BUY',
          type: 'LIMIT',
          quantity: '1',
          limitPrice: '70000',
        }),
      });
      expect(buy.status, JSON.stringify(buy.body)).toBe(201);
      const buyId = String((buy.body as { id?: string }).id);
      await vi.waitFor(
        async () => {
          expect(
            (
              await observer.query('select status from orders where id = $1', [
                buyId,
              ])
            ).rows[0]?.status,
          ).toBe('FILLED');
        },
        { timeout: 5_000 },
      );
      // 70000 × 0.015% = 10.5 → 11 KRW (HALF_UP, whole won); the fill names its schedule.
      const fill = (
        await observer.query(
          'select fee::text as fee, fee_model_version_id is not null as versioned from fills where order_id = $1',
          [buyId],
        )
      ).rows[0];
      expect(fill).toEqual({ fee: '11', versioned: true });
      expect(
        (
          await observer.query(
            'select total::text as total, reserved::text as reserved from wallets where session_id = $1 and currency = $2',
            [client.id, 'KRW'],
          )
        ).rows[0],
      ).toEqual({ total: '9929989', reserved: '0' });
      // SELL 1 @ 69900: commission 10.485 → 10, sell tax 104.85 → 105 ⇒ fee 115, proceeds 69785.
      const sell = await json(`${origin}/api/v1/orders`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          market: 'KR',
          symbol: '005930',
          side: 'SELL',
          type: 'LIMIT',
          quantity: '1',
          limitPrice: '69900',
        }),
      });
      expect(sell.status, JSON.stringify(sell.body)).toBe(201);
      const sellId = String((sell.body as { id?: string }).id);
      await vi.waitFor(
        async () => {
          expect(
            (
              await observer.query('select status from orders where id = $1', [
                sellId,
              ])
            ).rows[0]?.status,
          ).toBe('FILLED');
        },
        { timeout: 5_000 },
      );
      expect(
        (
          await observer.query(
            'select fee::text as fee from fills where order_id = $1',
            [sellId],
          )
        ).rows[0]?.fee,
      ).toBe('115');
      expect(
        (
          await observer.query(
            'select total::text as total from wallets where session_id = $1 and currency = $2',
            [client.id, 'KRW'],
          )
        ).rows[0]?.total,
      ).toBe('9999774');

      // A changed rate under the same version number must not boot.
      for (const runtime of running.splice(0))
        await runtime.stop().catch(() => undefined);
      await observer.query('select pg_advisory_unlock_all()');
      const drifted = {
        ...DEFAULT_FEE_SCHEDULES,
        KR: { commissionRate: '0.0003', sellTaxRate: '0.0015' },
      };
      const attempt = new ProductionRuntime({
        config: config({ fees: drifted }),
        bundle: createFakeProviderBundle(),
        signals: false,
        log: () => undefined,
      });
      running.push(attempt);
      await expect(attempt.start()).rejects.toThrow(
        /already published with different rates/,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
