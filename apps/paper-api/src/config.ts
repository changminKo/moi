import { z } from 'zod';

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
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly sessionHashKeys: readonly [string, ...string[]];
  readonly csrfSecret: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  if (parsed.SESSION_HASH_KEYS.length === 0) {
    throw new Error('SESSION_HASH_KEYS must contain at least one key');
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
  };
}
