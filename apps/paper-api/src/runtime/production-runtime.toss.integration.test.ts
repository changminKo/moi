import { FakeTossRestServer, FakeTossWsServer } from '@moi/market-data/testing';
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
import type { AppConfig } from '../config.js';
import { ZERO_FEE_SCHEDULES } from '../config.js';
import { ProductionRuntime } from './production-runtime.js';
import { createTossProviderBundle } from './provider-bundle.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 90_000;
const SYMBOLS = { KR: ['005930'], US: ['AAPL'] } as const;

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let observer: Client;
let rest: FakeTossRestServer;
let ws: FakeTossWsServer;
const running: ProductionRuntime[] = [];

function config(credentials: {
  clientId: string;
  clientSecret: string;
}): AppConfig {
  return {
    nodeEnv: 'production',
    host: '127.0.0.1',
    port: 0,
    publicOrigin: 'https://app.moi.test',
    databaseUrl: postgres.getConnectionUri(),
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    sessionHashKeys: ['runtime-session-hash-key-32-bytes!'],
    csrfSecret: 'runtime-csrf-secret-at-least-32-bytes',
    adminApiKey: 'runtime-admin-key-at-least-32-bytes!',
    marketDataAdapter: 'toss',
    toss: { ...credentials, restBaseUrl: rest.baseUrl, wsUrl: ws.url },
    shutdownDrainDeadlineMs: 5_000,
    trustProxy: false,
    rateLimitsEnabled: false,
    recoveryStabilityMs: 0,
    fees: ZERO_FEE_SCHEDULES,
  };
}

const json = async (url: string) =>
  (await fetch(url)).json() as Promise<Record<string, unknown>>;
const auditRows = async (like: string) =>
  (
    await observer.query(
      'select event_type, payload, occurred_at from audit_events where event_type like $1 order by occurred_at, id',
      [like],
    )
  ).rows as {
    event_type: string;
    payload: Record<string, unknown>;
    occurred_at: Date;
  }[];

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  observer = new Client({ connectionString: postgres.getConnectionUri() });
  await observer.connect();
}, CONTAINER_TIMEOUT_MS);

afterEach(async () => {
  for (const runtime of running.splice(0))
    await runtime.stop().catch(() => undefined);
  await ws?.stop();
  await rest?.stop();
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

async function startToss(): Promise<{
  runtime: ProductionRuntime;
  logs: string[];
  origin: string;
  tokenRefreshes: string[];
  credentials: { clientId: string; clientSecret: string };
}> {
  rest = new FakeTossRestServer();
  ws = new FakeTossWsServer();
  await rest.start();
  await ws.start();
  const credentials = rest.issueCredentials();
  rest.seedSnapshot('KR', '005930', '70000', {
    asks: [{ price: '70100', volume: '10' }],
    bids: [{ price: '70000', volume: '10' }],
  });
  rest.seedSnapshot('US', 'AAPL', '190.25', {
    asks: [{ price: '190.30', volume: '10' }],
    bids: [{ price: '190.20', volume: '10' }],
  });
  rest.seedInstrument('KR', '005930', '삼성전자');
  rest.seedInstrument('US', 'AAPL', '애플');
  const tokenRefreshes: string[] = [];
  const bundle = createTossProviderBundle(config(credentials), {
    symbols: SYMBOLS,
    onTokenRefresh: (r) => tokenRefreshes.push(r),
  });
  // The fake WS accepts whatever token the fake REST issued.
  const originalGet = bundle.tokenProvider.getAccessToken.bind(
    bundle.tokenProvider,
  );
  bundle.tokenProvider.getAccessToken = async (signal) => {
    const token = await originalGet(signal);
    ws.allowToken(token);
    return token;
  };
  const logs: string[] = [];
  const runtime = new ProductionRuntime({
    config: config(credentials),
    bundle,
    signals: false,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  });
  running.push(runtime);
  await runtime.start();
  return {
    runtime,
    logs,
    origin: `http://127.0.0.1:${runtime.port}`,
    tokenRefreshes,
    credentials,
  };
}

describe('ProductionRuntime with the toss bundle (B7/B8)', () => {
  it(
    'boots to SERVING through fake OAuth/REST/WS, issuing the token only after both leases',
    async () => {
      const { runtime, origin, tokenRefreshes } = await startToss();
      expect(runtime.state.current).toBe('SERVING');
      expect(await json(`${origin}/health/market-data`)).toMatchObject({
        KR: { state: 'NORMAL' },
        US: { state: 'NORMAL' },
      });
      expect(ws.connections).toBe(2);
      expect(ws.peakConcurrentConnections).toBe(2);
      expect(ws.evictions).toBe(0);
      expect(rest.tokenRequests()).toBe(1);
      expect(tokenRefreshes).toEqual(['ok']);
      expect(
        await json(
          `${origin}/api/v1/instruments?q=${encodeURIComponent('ㅅㅅㅈㅈ')}`,
        ),
      ).toEqual([
        expect.objectContaining({
          market: 'KR',
          symbol: '005930',
          name: '삼성전자',
        }),
      ]);
      const acquired = await auditRows('LEADER_ACQUIRED');
      expect(acquired).toHaveLength(2);
      const tokenLog = rest.requests().find((r) => r.path === '/oauth2/token');
      expect(tokenLog).toBeDefined();
      const instrumentLog = rest
        .requests()
        .find((r) => r.path === '/api/v1/stocks/all');
      expect(instrumentLog).toBeDefined();
      const leasesAcquiredAt = Math.max(
        ...acquired.map((row) => row.occurred_at.getTime()),
      );
      expect(instrumentLog?.at).toBeGreaterThanOrEqual(leasesAcquiredAt);
      const snapshotCalls = rest
        .requests()
        .filter(
          (r) => r.path === '/api/v1/prices' || r.path === '/api/v1/orderbook',
        );
      expect(snapshotCalls.length).toBeGreaterThanOrEqual(4);
      const metrics = await (await fetch(`${origin}/metrics`)).text();
      expect(metrics).toContain('provider_connections_open 2');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'recovers after a server-shutdown frame and never opens a third connection',
    async () => {
      const { origin } = await startToss();
      ws.announceShutdownAndClose();
      await vi.waitFor(
        async () => {
          const health = await json(`${origin}/health/market-data`);
          expect(health.KR).toMatchObject({ state: 'NORMAL' });
          expect(health.US).toMatchObject({ state: 'NORMAL' });
        },
        { timeout: 20_000, interval: 200 },
      );
      await vi.waitFor(() => expect(ws.connections).toBe(2), {
        timeout: 5_000,
      });
      expect(ws.peakConcurrentConnections).toBe(2);
      expect(ws.evictions).toBe(0);
      const metrics = await (await fetch(`${origin}/metrics`)).text();
      expect(metrics).toMatch(/feed_reconnect_total\{market="(KR|US)"\} 1/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'B8: no bearer token, client secret, or issued token value appears in any log line',
    async () => {
      const { runtime, logs, credentials } = await startToss();
      await runtime.stop();
      const text = logs.join('\n');
      expect(text).not.toMatch(/Bearer\s+\S+/);
      expect(text).not.toMatch(/client_secret=/);
      expect(text).not.toContain(credentials.clientSecret);
      expect(text).not.toContain(credentials.clientId);
      for (const record of rest.requests())
        expect(JSON.stringify(record)).not.toMatch(/Bearer/);
      expect(ws.connections).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
