import { TOSS_CONTRACT_SERVERS } from '@moi/market-data';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export { TOSS_CONTRACT_SERVERS };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
// The contract only shows `c_…` as an example; the developer console issues
// other prefixes (e.g. `ts…`), so only the character class and length are checked.
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  PUBLIC_ORIGIN: z.url(),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  SESSION_HASH_KEYS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  CSRF_SECRET: z.string().min(32),
  ADMIN_API_KEY: z.string().min(32).optional(),
  MARKET_DATA_ADAPTER: z.string().optional(),
  TOSS_CLIENT_ID: z.string().optional(),
  TOSS_CLIENT_SECRET: z.string().optional(),
  TOSS_REST_BASE_URL: z.url().default(TOSS_CONTRACT_SERVERS.rest),
  TOSS_WS_URL: z.url().default(TOSS_CONTRACT_SERVERS.ws),
  /**
   * Whether `X-Forwarded-For` names the client. Only true behind the
   * deployment's own reverse proxy (the Oracle overlay's Caddy, the sole
   * ingress); a directly exposed API must not trust a header anyone can send.
   */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  SHUTDOWN_DRAIN_DEADLINE_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(40_000)
    .default(30_000),
  RECOVERY_STABILITY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(30_000)
    .default(5_000),
  FEE_SCHEDULE_VERSION: z.coerce.number().int().min(1).optional(),
  FEE_KR_COMMISSION_RATE: z.string().optional(),
  FEE_KR_SELL_TAX_RATE: z.string().optional(),
  FEE_US_COMMISSION_RATE: z.string().optional(),
  FEE_US_SELL_TAX_RATE: z.string().optional(),
});

export interface FeeRates {
  readonly commissionRate: string;
  readonly sellTaxRate: string;
}

/** Versioned per-market fee schedule (architecture §fees). */
export interface FeeSchedules {
  readonly version: number;
  readonly KR: FeeRates;
  readonly US: FeeRates;
}

/**
 * Korean retail approximation: 0.015% commission plus 0.15% sell-side
 * transaction tax; US: 0.25% commission, no sell tax. Applied outside
 * production when no FEE_* variable is set; production must configure all.
 */
export const DEFAULT_FEE_SCHEDULES: FeeSchedules = Object.freeze({
  version: 1,
  KR: { commissionRate: '0.00015', sellTaxRate: '0.0015' },
  US: { commissionRate: '0.0025', sellTaxRate: '0' },
});

/**
 * Fee-free schedule for deterministic fixtures and harnesses. It carries its
 * own version number: a schedule version names one set of rates for good, so
 * fixtures and the default schedule must never share one (the boot-time drift
 * guard would refuse the second process to see the same database).
 */
export const ZERO_FEE_SCHEDULES: FeeSchedules = Object.freeze({
  version: 2,
  KR: { commissionRate: '0', sellTaxRate: '0' },
  US: { commissionRate: '0', sellTaxRate: '0' },
});

const RATE_PATTERN = /^(0|0\.\d{1,10})$/;
const FEE_VARIABLES = [
  'FEE_SCHEDULE_VERSION',
  'FEE_KR_COMMISSION_RATE',
  'FEE_KR_SELL_TAX_RATE',
  'FEE_US_COMMISSION_RATE',
  'FEE_US_SELL_TAX_RATE',
] as const;

function readRate(name: string, value: string | undefined): string {
  if (value === undefined || !RATE_PATTERN.test(value))
    throw new ConfigError(
      `${name} must be a decimal rate in [0, 1) with at most 10 decimals`,
    );
  return value;
}

function resolveFees(
  nodeEnv: AppConfig['nodeEnv'],
  parsed: z.infer<typeof environmentSchema>,
): FeeSchedules {
  const provided = FEE_VARIABLES.filter((name) => parsed[name] !== undefined);
  if (provided.length === 0) {
    if (nodeEnv === 'production')
      throw new ConfigError(
        'FEE_SCHEDULE_VERSION and the FEE_*_RATE variables must be set in production',
      );
    return DEFAULT_FEE_SCHEDULES;
  }
  if (provided.length !== FEE_VARIABLES.length)
    throw new ConfigError(
      `fee schedule is partial: set all of ${FEE_VARIABLES.join(', ')}`,
    );
  return {
    version: parsed.FEE_SCHEDULE_VERSION as number,
    KR: {
      commissionRate: readRate(
        'FEE_KR_COMMISSION_RATE',
        parsed.FEE_KR_COMMISSION_RATE,
      ),
      sellTaxRate: readRate(
        'FEE_KR_SELL_TAX_RATE',
        parsed.FEE_KR_SELL_TAX_RATE,
      ),
    },
    US: {
      commissionRate: readRate(
        'FEE_US_COMMISSION_RATE',
        parsed.FEE_US_COMMISSION_RATE,
      ),
      sellTaxRate: readRate(
        'FEE_US_SELL_TAX_RATE',
        parsed.FEE_US_SELL_TAX_RATE,
      ),
    },
  };
}

export type MarketDataAdapter = 'toss' | 'fake';

export interface TossConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly restBaseUrl: string;
  readonly wsUrl: string;
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly sessionHashKeys: readonly [string, ...string[]];
  readonly csrfSecret: string;
  readonly adminApiKey?: string;
  readonly marketDataAdapter: MarketDataAdapter;
  readonly toss?: TossConfig;
  readonly shutdownDrainDeadlineMs: number;
  /** Fastify `trustProxy`: derive `request.ip` from `X-Forwarded-For`. */
  readonly trustProxy: boolean;
  readonly recoveryStabilityMs: number;
  readonly fees: FeeSchedules;
}

function isLoopback(url: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(url).hostname);
}

function resolveAdapter(
  nodeEnv: AppConfig['nodeEnv'],
  raw: string | undefined,
): MarketDataAdapter {
  const value = raw?.trim() ?? '';
  if (nodeEnv === 'production') {
    if (value === '')
      throw new ConfigError(
        'MARKET_DATA_ADAPTER must be set explicitly in production',
      );
    if (value === 'fake')
      throw new ConfigError('fake adapter is forbidden in production');
  }
  if (value === '') return 'fake';
  if (value === 'toss' || value === 'fake') return value;
  throw new ConfigError('MARKET_DATA_ADAPTER must be "toss" or "fake"');
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  if (parsed.SESSION_HASH_KEYS.length === 0) {
    throw new ConfigError('SESSION_HASH_KEYS must contain at least one key');
  }
  if (parsed.NODE_ENV === 'production' && !parsed.ADMIN_API_KEY) {
    throw new ConfigError('ADMIN_API_KEY is required in production');
  }
  const marketDataAdapter = resolveAdapter(
    parsed.NODE_ENV,
    parsed.MARKET_DATA_ADAPTER,
  );
  let toss: TossConfig | undefined;
  if (marketDataAdapter === 'toss') {
    if (
      !parsed.TOSS_CLIENT_ID ||
      !CLIENT_ID_PATTERN.test(parsed.TOSS_CLIENT_ID)
    )
      throw new ConfigError(
        'TOSS_CLIENT_ID is required for the toss adapter (at least 8 letters, digits, _ or -)',
      );
    if (!parsed.TOSS_CLIENT_SECRET || parsed.TOSS_CLIENT_SECRET.length < 16)
      throw new ConfigError(
        'TOSS_CLIENT_SECRET is required for the toss adapter (>= 16 characters)',
      );
    for (const [name, value, fallback] of [
      [
        'TOSS_REST_BASE_URL',
        parsed.TOSS_REST_BASE_URL,
        TOSS_CONTRACT_SERVERS.rest,
      ],
      ['TOSS_WS_URL', parsed.TOSS_WS_URL, TOSS_CONTRACT_SERVERS.ws],
    ] as const) {
      if (
        parsed.NODE_ENV === 'production' &&
        value !== fallback &&
        !isLoopback(value)
      )
        throw new ConfigError(
          `${name} may only be overridden in production with a loopback host`,
        );
    }
    toss = {
      clientId: parsed.TOSS_CLIENT_ID,
      clientSecret: parsed.TOSS_CLIENT_SECRET,
      restBaseUrl: parsed.TOSS_REST_BASE_URL,
      wsUrl: parsed.TOSS_WS_URL,
    };
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    publicOrigin: parsed.PUBLIC_ORIGIN,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    sessionHashKeys: parsed.SESSION_HASH_KEYS as [string, ...string[]],
    csrfSecret: parsed.CSRF_SECRET,
    ...(parsed.ADMIN_API_KEY ? { adminApiKey: parsed.ADMIN_API_KEY } : {}),
    marketDataAdapter,
    ...(toss ? { toss } : {}),
    shutdownDrainDeadlineMs: parsed.SHUTDOWN_DRAIN_DEADLINE_MS,
    trustProxy: parsed.TRUST_PROXY === 'true',
    recoveryStabilityMs: parsed.RECOVERY_STABILITY_MS,
    fees: resolveFees(parsed.NODE_ENV, parsed),
  };
}
