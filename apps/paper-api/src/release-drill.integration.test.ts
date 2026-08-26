import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarketHealthMachine } from './market-data/health-machine.js';
import { LeaderLease } from './market-data/leader-lease.js';
import { expireInactiveSessions } from './modules/session/session-cleanup.js';
import { OutboxPublisher } from './modules/stream/outbox-publisher.js';
import { LayeredRateLimiter } from './plugins/rate-limits.js';

const workspaceRoot = resolve(import.meta.dirname, '../../..');

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to allocate a loopback port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await once(child, 'exit');
  clearTimeout(timer);
}

async function runProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number | null; readonly output: string }> {
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  await once(child, 'exit');
  return { exitCode: child.exitCode, output };
}

async function waitForLive(
  origin: string,
  child: ChildProcess,
  output: () => string,
): Promise<Response> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`paper-api exited before liveness:\n${output()}`);
    }
    try {
      const response = await fetch(`${origin}/health/live`);
      if (response.ok) return response;
    } catch {
      // Startup readiness is polled; no fixed delay decides success.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`paper-api did not become live:\n${output()}`);
}

async function startReleaseServer(
  databaseUrl = postgres.getConnectionUri(),
  marketDataAdapter: 'fake' | 'unavailable' = 'fake',
): Promise<{
  readonly child: ChildProcess;
  readonly origin: string;
}> {
  const port = await unusedPort();
  let output = '';
  const child = spawn(process.execPath, ['apps/paper-api/dist/main.js'], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      DATABASE_URL: databaseUrl,
      REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      SESSION_HASH_KEYS: 'release-session-hash-key-32-bytes',
      CSRF_SECRET: 'release-csrf-secret-at-least-32-bytes',
      ADMIN_API_KEY: 'release-admin-key-at-least-32-bytes',
      MARKET_DATA_ADAPTER: marketDataAdapter === 'fake' ? 'fake' : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const origin = `http://127.0.0.1:${port}`;
  await waitForLive(origin, child, () => output);
  return { child, origin };
}

async function queryRows<T extends Record<string, unknown>>(
  databaseUrl: string,
  statement: string,
): Promise<readonly T[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(statement)).rows;
  } finally {
    await client.end();
  }
}

async function seedAuditEvent(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `insert into audit_events
        (id, session_reference, event_type, payload, occurred_at)
       values ($1, $2, 'RELEASE_DRILL', $3::jsonb, now())`,
      [randomUUID(), 'release-drill', JSON.stringify({ source: 'task-9' })],
    );
  } finally {
    await client.end();
  }
}

async function releaseCounts(
  databaseUrl: string,
): Promise<Record<string, string>> {
  const rows = await queryRows<{ relation: string; count: string }>(
    databaseUrl,
    `select 'anonymous_sessions' as relation, count(*)::text as count from anonymous_sessions
     union all select 'wallets', count(*)::text from wallets
     union all select 'positions', count(*)::text from positions
     union all select 'orders', count(*)::text from orders
     union all select 'fills', count(*)::text from fills
     union all select 'audit_events', count(*)::text from audit_events
     union all select 'outbox_events', count(*)::text from outbox_events
     order by relation`,
  );
  return Object.fromEntries(rows.map((row) => [row.relation, row.count]));
}

async function invariantViolations(databaseUrl: string): Promise<{
  readonly wallets: string;
  readonly positions: string;
  readonly orders: string;
}> {
  const [row] = await queryRows<{
    wallets: string;
    positions: string;
    orders: string;
  }>(
    databaseUrl,
    `select
       (select count(*)::text from wallets
        where total < 0 or available < 0 or reserved < 0
           or total <> available + reserved) as wallets,
       (select count(*)::text from positions
        where total_quantity < 0 or available_quantity < 0
           or reserved_quantity < 0
           or total_quantity <> available_quantity + reserved_quantity) as positions,
       (select count(*)::text from orders
        where quantity <= 0 or filled_quantity < 0
           or filled_quantity > quantity) as orders`,
  );
  if (row === undefined) throw new Error('invariant query returned no row');
  return row;
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('redis:7.4.4-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.all([redis?.stop(), postgres?.stop()]);
});

describe('public release drill', () => {
  it('rejects a load smoke run without its isolated test inputs', async () => {
    const environment = { ...process.env };
    delete environment.LOAD_BASE_URL;
    delete environment.LOAD_DURATION_SECONDS;
    delete environment.LOAD_ADMIN_TOKEN;
    const result = await runProcess(
      process.execPath,
      ['scripts/load-smoke.mjs'],
      environment,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('LOAD_BASE_URL is required');
  });

  it('starts the production entrypoint and serves liveness', async () => {
    const server = await startReleaseServer();

    try {
      const response = await fetch(`${server.origin}/health/live`);
      await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
    } finally {
      await stopChild(server.child);
    }
  });

  it('exposes server-observed command duration without client clock skew', async () => {
    const server = await startReleaseServer();
    try {
      const response = await fetch(`${server.origin}/health/live`);
      expect(response.headers.get('server-timing')).toMatch(
        /^app;dur=\d+(?:\.\d{1,3})?$/,
      );
    } finally {
      await stopChild(server.child);
    }
  });

  it('serves an anonymous wallet through the production composition', async () => {
    const server = await startReleaseServer();
    try {
      const bootstrap = await fetch(
        `${server.origin}/api/v1/sessions/anonymous`,
        {
          method: 'POST',
          headers: { origin: server.origin },
        },
      );
      expect(bootstrap.status).toBe(200);
      const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
      expect(cookie).toMatch(/^skipjack_session=/);

      const portfolio = await fetch(`${server.origin}/api/v1/portfolio`, {
        headers: { cookie: cookie as string },
      });
      expect(portfolio.status).toBe(200);
      await expect(portfolio.json()).resolves.toMatchObject({
        wallets: [
          { currency: 'KRW', total: '10000000', available: '10000000' },
          { currency: 'USD', total: '0', available: '0' },
        ],
      });
    } finally {
      await stopChild(server.child);
    }
  });

  it('fails closed when the production market-data adapter is unavailable', async () => {
    const server = await startReleaseServer(
      postgres.getConnectionUri(),
      'unavailable',
    );
    try {
      const bootstrap = await fetch(
        `${server.origin}/api/v1/sessions/anonymous`,
        {
          method: 'POST',
          headers: { origin: server.origin },
        },
      );
      const body = (await bootstrap.json()) as { csrfToken: string };
      const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
      expect(bootstrap.status).toBe(200);
      expect(cookie).toMatch(/^skipjack_session=/);

      const trading = await fetch(`${server.origin}/api/v1/health/trading`);
      await expect(trading.json()).resolves.toMatchObject({
        placement: false,
        cancellation: true,
        reasons: ['CANCEL_ONLY'],
      });

      const placement = await fetch(`${server.origin}/api/v1/orders`, {
        method: 'POST',
        headers: {
          origin: server.origin,
          cookie: cookie as string,
          'x-csrf-token': body.csrfToken,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          market: 'KR',
          symbol: '005930',
          side: 'BUY',
          type: 'LIMIT',
          quantity: '1',
          limitPrice: '1',
        }),
      });
      expect(placement.status).toBe(409);
      await expect(placement.json()).resolves.toMatchObject({
        code: 'CANCEL_ONLY',
      });
    } finally {
      await stopChild(server.child);
    }
  });

  it('runs the bounded load smoke and restores NORMAL with no open test orders', async () => {
    const server = await startReleaseServer();
    try {
      const result = await runProcess(
        process.execPath,
        ['scripts/load-smoke.mjs'],
        {
          ...process.env,
          LOAD_BASE_URL: server.origin,
          LOAD_DURATION_SECONDS: '0.25',
          LOAD_ADMIN_TOKEN: 'release-admin-key-at-least-32-bytes',
        },
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(JSON.parse(result.output.trim())).toMatchObject({
        placementSamples: expect.any(Number),
        cancellationSamples: expect.any(Number),
      });

      const trading = await fetch(`${server.origin}/api/v1/health/trading`);
      await expect(trading.json()).resolves.toMatchObject({
        placement: true,
        cancellation: true,
        reasons: [],
      });
      const [openOrders] = await queryRows<{ count: string }>(
        postgres.getConnectionUri(),
        `select count(*)::text as count from orders
         where status not in ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')`,
      );
      expect(openOrders?.count).toBe('0');
    } finally {
      await stopChild(server.child);
    }
  }, 60_000);

  it('restores a pg_dump with ledger invariants and rollback reads intact', async () => {
    const source = await startReleaseServer();
    let cookie: string;
    try {
      const bootstrap = await fetch(
        `${source.origin}/api/v1/sessions/anonymous`,
        {
          method: 'POST',
          headers: { origin: source.origin },
        },
      );
      expect(bootstrap.status).toBe(200);
      cookie = bootstrap.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(cookie).toMatch(/^skipjack_session=/);
    } finally {
      await stopChild(source.child);
    }

    await seedAuditEvent(postgres.getConnectionUri());
    const sourceCounts = await releaseCounts(postgres.getConnectionUri());
    expect(await invariantViolations(postgres.getConnectionUri())).toEqual({
      wallets: '0',
      positions: '0',
      orders: '0',
    });

    const dump = await postgres.exec([
      'pg_dump',
      '--username',
      postgres.getUsername(),
      '--dbname',
      postgres.getDatabase(),
      '--format=custom',
      '--file=/tmp/skipjack-release.dump',
    ]);
    expect(dump.exitCode).toBe(0);

    const restored = await new PostgreSqlContainer(
      'postgres:17-alpine',
    ).start();
    try {
      const archiveStream = await postgres.copyArchiveFromContainer(
        '/tmp/skipjack-release.dump',
      );
      if (!(archiveStream instanceof Readable)) {
        throw new Error(
          'PostgreSQL dump archive is not a Node readable stream',
        );
      }
      await restored.copyArchiveToContainer(archiveStream, '/tmp');
      const restore = await restored.exec([
        'pg_restore',
        '--username',
        restored.getUsername(),
        '--dbname',
        restored.getDatabase(),
        '--no-owner',
        '--no-privileges',
        '/tmp/skipjack-release.dump',
      ]);
      expect(restore.exitCode, restore.stderr).toBe(0);

      expect(await releaseCounts(restored.getConnectionUri())).toEqual(
        sourceCounts,
      );
      expect(await invariantViolations(restored.getConnectionUri())).toEqual({
        wallets: '0',
        positions: '0',
        orders: '0',
      });

      // This query is the stable read surface used by the previous release.
      // Forward migrations stay applied; rollback means starting old code, not
      // attempting a destructive down migration.
      const previousReleaseRows = await queryRows<{
        currency: string;
        total: string;
        available: string;
        reserved: string;
      }>(
        restored.getConnectionUri(),
        `select currency, total::text, available::text, reserved::text
         from wallets order by currency`,
      );
      expect(previousReleaseRows.length).toBeGreaterThanOrEqual(2);

      const rollbackServer = await startReleaseServer(
        restored.getConnectionUri(),
      );
      try {
        const portfolio = await fetch(
          `${rollbackServer.origin}/api/v1/portfolio`,
          { headers: { cookie } },
        );
        expect(portfolio.status).toBe(200);
      } finally {
        await stopChild(rollbackServer.child);
      }
    } finally {
      await restored.stop();
    }
  }, 60_000);

  it('fails closed for deterministic dependency and feed failures', async () => {
    let loseLeader: (() => void) | undefined;
    const lease = await LeaderLease.acquire('US', {
      clientFactory: async () => ({
        query: async () => ({ rows: [{ epoch: '7', fencing_token: '11' }] }),
        on: (event, listener) => {
          if (event === 'end') loseLeader = () => listener();
        },
        release: () => undefined,
      }),
    });
    expect(lease.isHeld).toBe(true);
    loseLeader?.();
    expect(lease.isHeld).toBe(false);
    await lease.release();

    const redis = { available: true };
    const limiter = new LayeredRateLimiter({ redis });
    redis.available = false;
    expect(
      limiter.check({ kind: 'mutation', sessionId: 's', ip: '127.0.0.1' }),
    ).toEqual({ allowed: false, retryAfter: 1 });
    expect(
      limiter.check({ kind: 'cancel', sessionId: 's', ip: '127.0.0.1' }),
    ).toEqual({ allowed: true });

    let markedPublished = false;
    const publisher = new OutboxPublisher({
      claim: async () => [
        {
          id: randomUUID(),
          eventId: randomUUID(),
          sessionId: randomUUID(),
          accountSequence: '1',
          eventType: 'ORDER_ACCEPTED',
          payload: { status: 'OPEN' },
          createdAt: new Date(0).toISOString(),
        },
      ],
      publish: async () => {
        throw new Error('subscriber unavailable');
      },
      markPublished: async () => {
        markedPublished = true;
      },
    });
    expect(await publisher.pollOnce()).toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
    });
    expect(markedPublished).toBe(false);

    const causes: string[] = [];
    const feed = new MarketHealthMachine({
      market: 'US',
      incidents: {
        activate: async ({ causeCode }) => {
          causes.push(causeCode);
          return { incidentId: 'feed', version: 1n };
        },
      },
    });
    await feed.onClose('WEBSOCKET_DISCONNECTED');
    expect(feed.state).toBe('DEGRADED');
    expect(causes).toEqual(['WEBSOCKET_DISCONNECTED']);

    const expired: string[] = [];
    const cleanup = await expireInactiveSessions({
      now: () => new Date('2026-08-26T00:00:00.000Z'),
      inactivityMs: 1_000,
      retentionMs: 1_000,
      store: {
        findInactive: async () => [
          { id: 'expired-session', lastSeenAt: new Date(0) },
        ],
        expire: async ({ sessionId }) => {
          expired.push(sessionId);
        },
        deleteIdentifying: async () => 1,
      },
    });
    expect(cleanup).toEqual({ expired: 1, deleted: 1 });
    expect(expired).toEqual(['expired-session']);
  });

  it('detects two missed PONG windows by 120 seconds', async () => {
    let now = 0;
    let degradedAt: number | undefined;
    const feed = new MarketHealthMachine({
      market: 'US',
      clock: { now: () => now },
      incidents: {
        activate: async () => {
          degradedAt = now;
          return { incidentId: 'pong', version: 1n };
        },
      },
    });

    now = 60_000;
    await feed.onPong(false);
    expect(feed.state).toBe('HEALTHY');
    now = 120_000;
    await feed.onPong(false);

    expect(feed.state).toBe('DEGRADED');
    expect(degradedAt).toBeLessThanOrEqual(120_000);
  });

  it('recovers at least 95 of 100 deterministic transient incidents in 60 seconds', async () => {
    let elapsed = 0;
    let recovered = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const duration = attempt < 95 ? 59_000 : 61_000;
      const feed = new MarketHealthMachine({
        market: 'US',
        clock: { now: () => elapsed },
        incidents: {
          activate: async () => ({
            incidentId: `transient-${attempt}`,
            version: 1n,
          }),
          resolveCas: async () => elapsed <= 60_000,
        },
      });
      elapsed = 0;
      await feed.onClose('TRANSIENT_DISCONNECT');
      feed.beginRecovery();
      elapsed = duration;
      if (await feed.markHealthy(BigInt(attempt + 1))) recovered += 1;
    }
    expect(recovered).toBeGreaterThanOrEqual(95);
  });

  it('reports PostgreSQL outage as not ready without terminating liveness', async () => {
    const outageDatabase = await new PostgreSqlContainer(
      'postgres:17-alpine',
    ).start();
    const server = await startReleaseServer(outageDatabase.getConnectionUri());
    try {
      await outageDatabase.stop();
      const readiness = await fetch(`${server.origin}/health/ready`);
      expect(readiness.status).toBe(503);
      await expect(readiness.json()).resolves.toMatchObject({
        code: 'NOT_READY',
        retryable: true,
      });
      expect((await fetch(`${server.origin}/health/live`)).status).toBe(200);
    } finally {
      await stopChild(server.child);
    }
  }, 60_000);
});
