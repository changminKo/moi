import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  StartupCheckStrategy,
  type StartupStatus,
  Wait,
} from 'testcontainers';
import { createDatabase } from '../src/db/database.js';
import { migrateToLatest } from '../src/db/migrate.js';

/** Environment variable naming the previous `paper-api` image under test. */
export const PREVIOUS_IMAGE_VARIABLE = 'SCHEMA_COMPAT_PREVIOUS_IMAGE';

export const MISSING_PREVIOUS_IMAGE_MESSAGE = `${PREVIOUS_IMAGE_VARIABLE} must name the previous paper-api image to test against the current schema (CI builds the event's previous SHA as moi-paper-api-schema-compat:previous); no Docker resource was started`;

/** Printed by `previous-release-runner.mjs` once the old release saw its fill. */
export const SUCCESS_MARKER = 'SCHEMA_COMPAT_WRITE_OK';
/** The deliberately incompatible column the harness self-test adds to `fills`. */
export const INCOMPATIBLE_FILL_COLUMN = 'schema_compat_probe';

const POSTGRES_IMAGE = 'postgres:17.5-alpine';
const REDIS_IMAGE = 'redis:7-alpine';
const POSTGRES_ALIAS = 'postgres';
const REDIS_ALIAS = 'redis';
const REDIS_PORT = 6379;
const RUNNER_SOURCE = fileURLToPath(
  new URL('./previous-release-runner.mjs', import.meta.url),
);
/** Neutral path: nothing under /app, so the image's own files are untouched. */
const RUNNER_MOUNT_PATH = '/tmp/moi-schema-compat/previous-release-runner.mjs';
const ONE_SHOT_TIMEOUT_MS = 180_000;
const LOG_TAIL_LINES = 60;

export interface PreviousReleaseScenarioOptions {
  /**
   * Harness self-test: after the current migrations, add a `NOT NULL` column
   * to `fills` that no release knows about, so the previous image's fill
   * insert must fail.
   */
  readonly addIncompatibleFillColumn?: boolean;
  /** Overrides `SCHEMA_COMPAT_PREVIOUS_IMAGE` (tests of the contract itself). */
  readonly previousImage?: string;
}

/**
 * Synthetic test configuration for the previous runtime. Every value is a
 * fixture: loopback listener, fake adapter, zero fees under the version the
 * fixtures own (`ZERO_FEE_SCHEDULES`), keys that unlock nothing anywhere.
 */
function previousRuntimeEnvironment(postgres: {
  user: string;
  password: string;
  database: string;
}): Record<string, string> {
  const { user, password, database } = postgres;
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    PUBLIC_ORIGIN: 'http://127.0.0.1:0',
    DATABASE_URL: `postgres://${user}:${password}@${POSTGRES_ALIAS}:5432/${database}`,
    REDIS_URL: `redis://${REDIS_ALIAS}:${REDIS_PORT}`,
    SESSION_HASH_KEYS: 'schema-compat-fixture-session-hash-key-32-bytes',
    CSRF_SECRET: 'schema-compat-fixture-csrf-secret-at-least-32-bytes',
    MARKET_DATA_ADAPTER: 'fake',
    SHUTDOWN_DRAIN_DEADLINE_MS: '5000',
    RECOVERY_STABILITY_MS: '0',
    FEE_SCHEDULE_VERSION: '2',
    FEE_KR_COMMISSION_RATE: '0',
    FEE_KR_SELL_TAX_RATE: '0',
    FEE_US_COMMISSION_RATE: '0',
    FEE_US_SELL_TAX_RATE: '0',
  };
}

function resolvePreviousImage(candidate: string | undefined): string {
  const image = candidate?.trim() ?? '';
  if (image === '') throw new Error(MISSING_PREVIOUS_IMAGE_MESSAGE);
  return image;
}

type Cleanup = () => Promise<unknown>;

/**
 * Runs `body`, then every registered cleanup in reverse order, even after a
 * failure. The first error wins: a scenario failure is never hidden by a
 * cleanup failure, and a cleanup failure surfaces when the body succeeded.
 */
async function withCleanup<T>(
  body: (defer: (cleanup: Cleanup) => void) => Promise<T>,
): Promise<T> {
  const cleanups: Cleanup[] = [];
  let failure: { error: unknown } | undefined;
  let result: T | undefined;
  try {
    result = await body((cleanup) => cleanups.push(cleanup));
  } catch (error) {
    failure = { error };
  }
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== undefined) throw failure.error;
  return result as T;
}

/**
 * Applies the *current* checkout's migrations to the fresh database, and for
 * the self-test adds the incompatible column afterwards — only while `fills`
 * is still empty, which is what lets a `NOT NULL` column without a default be
 * added at all and keeps the probe out of every other scenario.
 */
async function migrateWithCurrentSource(
  connectionUri: string,
  addIncompatibleFillColumn: boolean,
): Promise<void> {
  const db = createDatabase(connectionUri);
  try {
    await migrateToLatest(db);
    if (!addIncompatibleFillColumn) return;
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from fills
    `.execute(db);
    if (rows[0]?.n !== 0)
      throw new Error('the incompatible probe needs an empty fills table');
    await sql`
      alter table fills add column ${sql.ref(INCOMPATIBLE_FILL_COLUMN)} text not null
    `.execute(db);
  } finally {
    await db.destroy();
  }
}

/**
 * Waits for the one-shot container to *finish* and records how it ended.
 *
 * Deliberately not `Wait.forOneShotStartup()`: that strategy answers FAIL on
 * a nonzero exit, which makes `GenericContainer.start()` reject before a
 * `StartedTestContainer` exists — the harness then cannot stop the container
 * itself and is left relying on Testcontainers' error path and Ryuk. Every
 * finished container is therefore reported as started; `runPreviousImage`
 * reads `exitCode` for the verdict and stops the container in `finally`.
 */
type DockerClient = Parameters<StartupCheckStrategy['checkStartupState']>[0];

export class FinishedOneShotStrategy extends StartupCheckStrategy {
  /** The process exit code once the container has finished. */
  exitCode: number | undefined;

  async checkStartupState(
    dockerClient: DockerClient,
    containerId: string,
  ): Promise<StartupStatus> {
    const { State } = await dockerClient.getContainer(containerId).inspect();
    if (State.Running || State.Paused || !isSet(State.FinishedAt))
      return 'PENDING';
    this.exitCode = State.ExitCode;
    return 'SUCCESS';
  }
}

const DOCKER_TIMESTAMP_ZERO = '0001-01-01T00:00:00Z';
function isSet(timestamp: string): boolean {
  return (
    timestamp !== '' &&
    timestamp !== DOCKER_TIMESTAMP_ZERO &&
    Date.parse(timestamp) > 0
  );
}

function tail(lines: readonly string[]): string {
  return lines.slice(-LOG_TAIL_LINES).join('\n');
}

/**
 * Runs the previous image once, on the scenario network, with the runner
 * mounted read-only. Resolves only when the container exited 0 *and* printed
 * the success marker; rejects with the exit code and the log tail otherwise.
 * The container is stopped and removed in `finally` in every case.
 */
async function runPreviousImage(
  image: string,
  network: StartedNetwork,
  environment: Record<string, string>,
): Promise<void> {
  const lines: string[] = [];
  const strategy = new FinishedOneShotStrategy();
  const started = await new GenericContainer(image)
    .withNetwork(network)
    .withEnvironment(environment)
    .withBindMounts([
      { source: RUNNER_SOURCE, target: RUNNER_MOUNT_PATH, mode: 'ro' },
    ])
    .withCommand(['node', RUNNER_MOUNT_PATH])
    .withWaitStrategy(strategy)
    .withStartupTimeout(ONE_SHOT_TIMEOUT_MS)
    .withLogConsumer((stream) => {
      stream.on('data', (chunk: Buffer | string) => {
        lines.push(...String(chunk).split('\n').filter(Boolean));
      });
    })
    .start();
  try {
    const describe = (verdict: string) =>
      `previous image ${image} ${verdict}; container output (last ${LOG_TAIL_LINES} lines):\n${tail(lines)}`;
    if (strategy.exitCode !== 0)
      throw new Error(
        describe(
          `exited with code ${strategy.exitCode} before ${SUCCESS_MARKER}`,
        ),
      );
    if (!lines.some((line) => line.trim() === SUCCESS_MARKER))
      throw new Error(describe(`exited 0 without printing ${SUCCESS_MARKER}`));
  } finally {
    await started.stop();
  }
}

/**
 * One complete #46 scenario on its own Docker network: fresh PostgreSQL and
 * Redis, the current checkout's migrations, then the previous image's compiled
 * runtime performing the old release's write path. Every resource is released
 * in `finally`, a failed one-shot start included.
 */
export async function runPreviousReleaseScenario(
  options: PreviousReleaseScenarioOptions = {},
): Promise<void> {
  const image = resolvePreviousImage(
    options.previousImage ?? process.env[PREVIOUS_IMAGE_VARIABLE],
  );
  await withCleanup(async (defer) => {
    const network = await new Network().start();
    defer(() => network.stop());
    // One at a time, each registered for cleanup as soon as it is up: a
    // second start that fails must not orphan the first container.
    const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(POSTGRES_ALIAS)
      .start();
    defer(() => postgres.stop());
    // Reached only through its network alias, so no host port is bound; the
    // log line is what says it is ready to serve.
    const redis = await new GenericContainer(REDIS_IMAGE)
      .withNetwork(network)
      .withNetworkAliases(REDIS_ALIAS)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    defer(() => redis.stop());
    await migrateWithCurrentSource(
      postgres.getConnectionUri(),
      options.addIncompatibleFillColumn === true,
    );
    await runPreviousImage(
      image,
      network,
      previousRuntimeEnvironment({
        user: postgres.getUsername(),
        password: postgres.getPassword(),
        database: postgres.getDatabase(),
      }),
    );
  });
}
