import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { TOSS_SYMBOL_WHITELIST } from '@moi/market-data';
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
import WebSocket from 'ws';

export const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../../../..');
export const ENTRYPOINT = 'apps/paper-api/dist/main.js';
export const PUBLIC_ORIGIN = 'https://app.moi.test';
const OBSERVE_INTERVAL_MS = 100;

export interface LogLine {
  readonly t: number;
  readonly event?: string;
  readonly raw: string;
  readonly fields: Record<string, unknown>;
}
export interface Observation {
  readonly t: number;
  readonly process: string;
  readonly endpoint: string;
  readonly status: number;
  readonly body: unknown;
}
export interface JsonResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('no port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One spawned `node dist/main.js` process with parsed stdout and an exit promise. */
export class ApiProcess {
  readonly name: string;
  readonly port: number;
  readonly origin: string;
  readonly child: ChildProcess;
  readonly logs: LogLine[] = [];
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  readonly startedAt = Date.now();
  #buffer = '';

  constructor(name: string, port: number, child: ChildProcess) {
    this.name = name;
    this.port = port;
    this.origin = `http://127.0.0.1:${port}`;
    this.child = child;
    const onChunk = (chunk: Buffer): void => {
      this.#buffer += chunk.toString();
      const lines = this.#buffer.split('\n');
      this.#buffer = lines.pop() ?? '';
      for (const raw of lines) {
        if (raw.trim() === '') continue;
        let fields: Record<string, unknown> = {};
        try {
          fields = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          fields = {};
        }
        this.logs.push({
          t: Date.now(),
          raw,
          fields,
          ...(typeof fields.event === 'string' ? { event: fields.event } : {}),
        });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    this.exited = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
  }

  get leaderId(): string {
    const line = this.logs.find((l) => typeof l.fields.leaderId === 'string');
    if (!line) throw new Error(`${this.name} has not logged a leaderId yet`);
    return line.fields.leaderId as string;
  }
  events(name: string): LogLine[] {
    return this.logs.filter((l) => l.event === name);
  }
  stateLog(to: string): LogLine | undefined {
    return this.logs.find(
      (l) => l.event === 'runtime.state' && l.fields.to === to,
    );
  }
  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }
  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }
}

export interface DrillClient {
  readonly cookie: string;
  readonly csrf: string;
  readonly id: string;
}

/** Collects user-stream frames from any number of sockets, deduplicated by eventId. */
export class StreamCollector {
  readonly frames: {
    t: number;
    socket: string;
    frame: Record<string, unknown>;
  }[] = [];
  readonly sockets: WebSocket[] = [];
  readonly #seen = new Map<string, number>();

  eventsById(): Map<string, number> {
    return new Map(this.#seen);
  }
  uniqueEvents(): Record<string, unknown>[] {
    const out = new Map<string, Record<string, unknown>>();
    for (const { frame } of this.frames)
      if (
        frame.type === 'event' &&
        typeof frame.eventId === 'string' &&
        !out.has(frame.eventId)
      )
        out.set(frame.eventId, frame);
    return [...out.values()];
  }
  async connect(
    origin: string,
    client: DrillClient,
    label: string,
    afterSequence?: string,
  ): Promise<{ status: number; ws?: WebSocket }> {
    const url = new URL('/api/v1/stream', origin.replace('http', 'ws'));
    if (afterSequence !== undefined)
      url.searchParams.set('afterSequence', afterSequence);
    const ws = new WebSocket(url, {
      headers: { origin: PUBLIC_ORIGIN, cookie: client.cookie },
    });
    ws.on('error', () => undefined);
    return new Promise((resolveConnect) => {
      ws.once('unexpected-response', (_r, res) => {
        res.resume();
        ws.terminate();
        resolveConnect({ status: res.statusCode ?? 0 });
      });
      ws.once('open', () => {
        this.sockets.push(ws);
        ws.on('message', (data) => {
          const frame = JSON.parse(String(data)) as Record<string, unknown>;
          this.frames.push({ t: Date.now(), socket: label, frame });
          if (frame.type === 'event' && typeof frame.eventId === 'string')
            this.#seen.set(
              frame.eventId,
              (this.#seen.get(frame.eventId) ?? 0) + 1,
            );
        });
        resolveConnect({ status: 101, ws });
      });
    });
  }
  async closeAll(): Promise<void> {
    for (const ws of this.sockets.splice(0)) ws.terminate();
  }
}

export class TwoProcessHarness {
  postgres!: StartedPostgreSqlContainer;
  redis!: StartedTestContainer;
  rest!: FakeTossRestServer;
  ws!: FakeTossWsServer;
  observer!: Client;
  /**
   * A second connection that holds one row lock for the drill. It is separate
   * from `observer` so the observer's sampling queries never run inside the
   * lock-holding transaction.
   */
  #holder: Client | null = null;
  credentials!: { clientId: string; clientSecret: string };
  readonly processes: ApiProcess[] = [];
  readonly observations: Observation[] = [];
  readonly wsConnectionSamples: { t: number; connections: number }[] = [];
  readonly leaderEpochSamples: { t: number; rows: unknown[] }[] = [];
  readonly secrets = {
    sessionHashKeys: randomBytes(24).toString('base64url'),
    csrfSecret: randomBytes(32).toString('base64url'),
    adminApiKey: randomBytes(32).toString('base64url'),
  };
  #observers: ReturnType<typeof setInterval>[] = [];
  #watching = new Set<ApiProcess>();

  async start(): Promise<void> {
    this.postgres = await new PostgreSqlContainer(
      'postgres:17.5-alpine',
    ).start();
    this.redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    this.rest = new FakeTossRestServer();
    this.ws = new FakeTossWsServer();
    await this.rest.start();
    await this.ws.start();
    this.credentials = this.rest.issueCredentials();
    this.rest.onTokenIssued((token) => this.ws.allowToken(token));
    this.rest.seedSnapshot('KR', '005930', '70000', {
      asks: [{ price: '70100', volume: '100' }],
      bids: [{ price: '70000', volume: '100' }],
    });
    for (const symbol of TOSS_SYMBOL_WHITELIST)
      this.rest.seedSnapshot('US', symbol, '190.25', {
        asks: [{ price: '190.30', volume: '100' }],
        bids: [{ price: '190.20', volume: '100' }],
      });
    this.observer = new Client({
      connectionString: this.postgres.getConnectionUri(),
    });
    await this.observer.connect();
    this.#observers.push(
      setInterval(() => {
        this.wsConnectionSamples.push({
          t: Date.now(),
          connections: this.ws.connections,
        });
      }, OBSERVE_INTERVAL_MS),
      setInterval(() => {
        void this.observer
          .query(
            'select market_code, epoch::text, leader_id, released_at from leader_epochs order by market_code',
          )
          .then((r) =>
            this.leaderEpochSamples.push({ t: Date.now(), rows: r.rows }),
          )
          .catch(() => undefined);
      }, OBSERVE_INTERVAL_MS),
      setInterval(() => {
        for (const process of this.#watching) void this.#observe(process);
      }, OBSERVE_INTERVAL_MS),
    );
  }

  async #observe(process: ApiProcess): Promise<void> {
    if (!process.running) return;
    for (const endpoint of [
      '/health/ready',
      '/api/v1/health/trading',
      '/health/market-data',
    ]) {
      try {
        const response = await fetch(`${process.origin}${endpoint}`);
        const body = await response.json().catch(() => undefined);
        this.observations.push({
          t: Date.now(),
          process: process.name,
          endpoint,
          status: response.status,
          body,
        });
      } catch {
        /* process may be between listen and exit */
      }
    }
  }

  async spawn(
    name: string,
    extraEnv: Record<string, string> = {},
  ): Promise<ApiProcess> {
    const port = await unusedPort();
    const child = spawn(process.execPath, [ENTRYPOINT], {
      cwd: WORKSPACE_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        // Production requires an explicit fee schedule (compose literals in
        // deployment); the drill uses the v1 defaults.
        FEE_SCHEDULE_VERSION: '1',
        FEE_KR_COMMISSION_RATE: '0.00015',
        FEE_KR_SELL_TAX_RATE: '0.0015',
        FEE_US_COMMISSION_RATE: '0.0025',
        FEE_US_SELL_TAX_RATE: '0',
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN,
        DATABASE_URL: this.postgres.getConnectionUri(),
        REDIS_URL: `redis://${this.redis.getHost()}:${this.redis.getMappedPort(6379)}`,
        SESSION_HASH_KEYS: this.secrets.sessionHashKeys,
        CSRF_SECRET: this.secrets.csrfSecret,
        ADMIN_API_KEY: this.secrets.adminApiKey,
        MARKET_DATA_ADAPTER: 'toss',
        TOSS_CLIENT_ID: this.credentials.clientId,
        TOSS_CLIENT_SECRET: this.credentials.clientSecret,
        TOSS_REST_BASE_URL: this.rest.baseUrl,
        TOSS_WS_URL: this.ws.url,
        RECOVERY_STABILITY_MS: '500',
        SHUTDOWN_DRAIN_DEADLINE_MS: '10000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const api = new ApiProcess(name, port, child);
    this.processes.push(api);
    this.#watching.add(api);
    return api;
  }

  async waitForLive(api: ApiProcess, timeoutMs = 20_000): Promise<void> {
    await waitUntil(
      async () => {
        if (!api.running)
          throw new Error(
            `${api.name} exited before liveness:\n${api.logs.map((l) => l.raw).join('\n')}`,
          );
        try {
          return (await fetch(`${api.origin}/health/live`)).ok;
        } catch {
          return false;
        }
      },
      timeoutMs,
      `${api.name} liveness`,
    );
  }

  async trading(api: ApiProcess): Promise<Record<string, unknown>> {
    return (
      await fetch(`${api.origin}/api/v1/health/trading`)
    ).json() as Promise<Record<string, unknown>>;
  }
  async marketData(api: ApiProcess): Promise<Record<string, unknown>> {
    return (await fetch(`${api.origin}/health/market-data`)).json() as Promise<
      Record<string, unknown>
    >;
  }
  async ready(api: ApiProcess): Promise<JsonResponse> {
    return this.json(`${api.origin}/health/ready`);
  }
  async json(url: string, init?: RequestInit): Promise<JsonResponse> {
    const response = await fetch(url, init);
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { status: response.status, headers: response.headers, body };
  }

  async waitForNormal(api: ApiProcess, timeoutMs: number): Promise<void> {
    await waitUntil(
      async () => {
        const health = await this.marketData(api).catch(() => undefined);
        return (
          health?.runtime === 'SERVING' &&
          (health?.KR as { state?: string } | undefined)?.state === 'NORMAL' &&
          (health?.US as { state?: string } | undefined)?.state === 'NORMAL'
        );
      },
      timeoutMs,
      `${api.name} NORMAL`,
      100,
    );
  }

  async bootstrap(api: ApiProcess): Promise<DrillClient> {
    const response = await fetch(`${api.origin}/api/v1/sessions/anonymous`, {
      method: 'POST',
      headers: { origin: PUBLIC_ORIGIN },
    });
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    const body = (await response.json()) as {
      csrfToken: string;
      session: { id: string };
    };
    if (!cookie) throw new Error('bootstrap returned no cookie');
    return { cookie, csrf: body.csrfToken, id: body.session.id };
  }

  mutationHeaders(client: DrillClient): Record<string, string> {
    return {
      origin: PUBLIC_ORIGIN,
      cookie: client.cookie,
      'x-csrf-token': client.csrf,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
    };
  }
  async placeOrder(
    api: ApiProcess,
    client: DrillClient,
    order: Record<string, unknown>,
  ): Promise<JsonResponse> {
    return this.json(`${api.origin}/api/v1/orders`, {
      method: 'POST',
      headers: this.mutationHeaders(client),
      body: JSON.stringify(order),
    });
  }
  /**
   * Sessions start with KRW only; US orders need USD, so the drill converts
   * through the public FX routes exactly as a browser session would.
   */
  async fundUsd(
    api: ApiProcess,
    client: DrillClient,
    krwAmount = '10000000',
  ): Promise<JsonResponse> {
    const quote = await this.json(`${api.origin}/api/v1/fx/quotes`, {
      method: 'POST',
      headers: this.mutationHeaders(client),
      body: JSON.stringify({ from: 'KRW', to: 'USD', amount: krwAmount }),
    });
    if (quote.status >= 300) return quote;
    return this.json(`${api.origin}/api/v1/fx/conversions`, {
      method: 'POST',
      headers: this.mutationHeaders(client),
      body: JSON.stringify({
        quoteId: (quote.body as { quoteId?: string }).quoteId,
      }),
    });
  }
  async cancelOrder(
    api: ApiProcess,
    client: DrillClient,
    orderId: string,
  ): Promise<JsonResponse> {
    return this.json(`${api.origin}/api/v1/orders/${orderId}`, {
      method: 'DELETE',
      headers: Object.fromEntries(
        Object.entries(this.mutationHeaders(client)).filter(
          ([key]) => key !== 'content-type',
        ),
      ),
    });
  }

  async auditRows(like: string): Promise<
    {
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }[]
  > {
    return (
      await this.observer.query(
        'select event_type, payload, occurred_at from audit_events where event_type like $1 order by occurred_at, id',
        [like],
      )
    ).rows as {
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }[];
  }
  async leaderEpochs(): Promise<
    Record<
      string,
      { epoch: string; leader_id: string; released_at: Date | null }
    >
  > {
    const rows = (
      await this.observer.query(
        'select market_code, epoch::text, leader_id, released_at from leader_epochs',
      )
    ).rows as {
      market_code: string;
      epoch: string;
      leader_id: string;
      released_at: Date | null;
    }[];
    return Object.fromEntries(rows.map((r) => [r.market_code, r]));
  }
  async pendingOutbox(): Promise<{ id: string; event_type: string }[]> {
    return (
      await this.observer.query(
        'select id::text, event_type from outbox_events where published_at is null',
      )
    ).rows as { id: string; event_type: string }[];
  }
  async leaseBackendPid(leaderId: string, market: string): Promise<number> {
    const rows = (
      await this.observer.query(
        'select pid from pg_stat_activity where application_name = $1',
        [`moi-lease-${market}-${leaderId}`],
      )
    ).rows;
    const pid = Number(rows[0]?.pid);
    if (!pid) throw new Error(`no lease backend for ${market} ${leaderId}`);
    return pid;
  }
  async advisoryLockCount(): Promise<number> {
    return Number(
      (
        await this.observer.query(
          "select count(*)::int as n from pg_locks where locktype = 'advisory'",
        )
      ).rows[0]?.n ?? 0,
    );
  }

  async stop(
    api: ApiProcess,
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    ms: number;
  }> {
    const started = Date.now();
    api.kill(signal);
    const timer = setTimeout(() => api.kill('SIGKILL'), 30_000);
    const result = await api.exited;
    clearTimeout(timer);
    this.#watching.delete(api);
    return { ...result, ms: Date.now() - started };
  }

  /**
   * Pin an admitted request inside P1 for as long as the drill needs it
   * (§10.2-4, §6.6-3). A process with an empty outbox drains and exits about
   * 60 ms after SIGTERM, so an HTTP probe that merely races the signal sees
   * DRAINING only on an idle runner. Locking the session row makes the next
   * mutation from that session block at LEDGER_LOCK_ORDER's first step —
   * inside the transaction, admitted, in flight — and §6.6-3 keeps the process
   * in DRAINING until `releaseSession()` lets it finish.
   */
  async holdSession(client: DrillClient): Promise<void> {
    if (this.#holder !== null) throw new Error('a session is already held');
    this.#holder = new Client({
      connectionString: this.postgres.getConnectionUri(),
    });
    await this.#holder.connect();
    await this.#holder.query('begin');
    await this.#holder.query(
      'select id from anonymous_sessions where id = $1::uuid for update',
      [client.id],
    );
  }

  async releaseSession(): Promise<void> {
    const holder = this.#holder;
    if (holder === null) return;
    this.#holder = null;
    await holder.query('rollback').catch(() => undefined);
    await holder.end().catch(() => undefined);
  }

  /** Backends (other than ours) blocked on a lock while touching `table`. */
  async backendsBlockedOn(table: string): Promise<number> {
    const result = await this.observer.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock'
           and query ilike $1
           and pid <> pg_backend_pid()`,
      [`%${table}%`],
    );
    return result.rows[0]?.n ?? 0;
  }

  writeEvidence(name: string, extra: Record<string, unknown>): string {
    const dir = resolve(
      WORKSPACE_ROOT,
      'apps/paper-api/test-results/leader-handoff',
    );
    mkdirSync(dir, { recursive: true });
    const file = resolve(
      dir,
      `${new Date().toISOString().replaceAll(':', '-')}-${name}.json`,
    );
    writeFileSync(
      file,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          fakeWs: {
            peakConcurrentConnections: this.ws.peakConcurrentConnections,
            evictions: this.ws.evictions,
          },
          wsConnectionSamples: this.wsConnectionSamples,
          wsLifecycle: this.ws.lifecycle,
          leaderEpochSamples: this.leaderEpochSamples,
          observations: this.observations,
          processes: this.processes.map((p) => ({
            name: p.name,
            port: p.port,
            logs: p.logs.map((l) => ({ t: l.t, raw: l.raw })),
          })),
          ...extra,
        },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
    );
    return file;
  }

  async dispose(): Promise<void> {
    for (const timer of this.#observers) clearInterval(timer);
    await this.releaseSession();
    for (const api of this.processes)
      if (api.running) await this.stop(api, 'SIGKILL').catch(() => undefined);
    await this.ws?.stop().catch(() => undefined);
    await this.rest?.stop().catch(() => undefined);
    await this.observer?.end().catch(() => undefined);
    await this.redis?.stop().catch(() => undefined);
    await this.postgres?.stop().catch(() => undefined);
  }
}
