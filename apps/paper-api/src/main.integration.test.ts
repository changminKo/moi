import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startProductionServer } from './main.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 90_000;

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await redis?.stop();
  await postgres?.stop();
});

describe('production entrypoint (A12)', () => {
  it(
    'boots through main.ts, serves an authenticated websocket with afterSequence, and rejects inbound frames',
    async () => {
      const runtime = await startProductionServer(
        {
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: '0',
          PUBLIC_ORIGIN: 'http://127.0.0.1:0',
          DATABASE_URL: postgres.getConnectionUri(),
          REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
          SESSION_HASH_KEYS: 'main-session-hash-key-32-bytes-long',
          CSRF_SECRET: 'main-csrf-secret-at-least-32-bytes!!',
          ADMIN_API_KEY: 'main-admin-key-at-least-32-bytes!!!!',
          MARKET_DATA_ADAPTER: 'fake',
          RECOVERY_STABILITY_MS: '0',
          SHUTDOWN_DRAIN_DEADLINE_MS: '5000',
        },
        { signals: false },
      );
      try {
        const origin = `http://127.0.0.1:${runtime.port}`;
        expect(runtime.state.current).toBe('SERVING');
        const bootstrap = await fetch(`${origin}/api/v1/sessions/anonymous`, {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:0' },
        });
        const cookie = bootstrap.headers
          .get('set-cookie')
          ?.split(';')[0] as string;
        const ws = new WebSocket(
          `ws://127.0.0.1:${runtime.port}/api/v1/stream?afterSequence=0`,
          { headers: { origin: 'http://127.0.0.1:0', cookie } },
        );
        const messages: Record<string, unknown>[] = [];
        ws.on('message', (d) => messages.push(JSON.parse(String(d))));
        await new Promise<void>((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        await vi.waitFor(() =>
          expect(messages[0]).toMatchObject({
            type: 'ready',
            accountSequence: '0',
          }),
        );
        ws.send(JSON.stringify({ afterSequence: '1' }));
        const code = await new Promise<number>((resolve) =>
          ws.once('close', (c) => resolve(c)),
        );
        expect(code).toBe(1003);
      } finally {
        await runtime.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails closed with a ConfigError when the toss adapter lacks credentials',
    async () => {
      await expect(
        startProductionServer(
          {
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: '0',
            PUBLIC_ORIGIN: 'https://app.skipjack.test',
            DATABASE_URL: postgres.getConnectionUri(),
            REDIS_URL: 'redis://127.0.0.1:6379',
            SESSION_HASH_KEYS: 'main-session-hash-key-32-bytes-long',
            CSRF_SECRET: 'main-csrf-secret-at-least-32-bytes!!',
            ADMIN_API_KEY: 'main-admin-key-at-least-32-bytes!!!!',
            MARKET_DATA_ADAPTER: 'toss',
          },
          { signals: false },
        ),
      ).rejects.toMatchObject({ name: 'ConfigError' });
    },
    TEST_TIMEOUT_MS,
  );
});
