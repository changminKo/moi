import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_FEE_SCHEDULES, loadConfig } from './config.js';

const PROD_FEES = {
  FEE_SCHEDULE_VERSION: '1',
  FEE_KR_COMMISSION_RATE: '0.00015',
  FEE_KR_SELL_TAX_RATE: '0.0015',
  FEE_US_COMMISSION_RATE: '0.0025',
  FEE_US_SELL_TAX_RATE: '0',
};
const BASE = {
  PUBLIC_ORIGIN: 'https://app.moi.test',
  DATABASE_URL: 'postgres://u:p@db:5432/moi',
  REDIS_URL: 'redis://redis:6379',
  SESSION_HASH_KEYS: 'k1,k2',
  CSRF_SECRET: 'c'.repeat(32),
  ADMIN_API_KEY: 'a'.repeat(32),
};

describe('loadConfig (§5.1, A8)', () => {
  it('defaults MARKET_DATA_ADAPTER to fake outside production', () => {
    expect(loadConfig({ ...BASE, NODE_ENV: 'test' }).marketDataAdapter).toBe(
      'fake',
    );
    expect(
      loadConfig({ ...BASE, NODE_ENV: 'development' }).marketDataAdapter,
    ).toBe('fake');
  });
  it('requires an explicit adapter in production and forbids fake', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' })).toThrow(
      /MARKET_DATA_ADAPTER must be set explicitly in production/,
    );
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        ...PROD_FEES,
        MARKET_DATA_ADAPTER: '',
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        ...PROD_FEES,
        MARKET_DATA_ADAPTER: 'fake',
      }),
    ).toThrow(/fake adapter is forbidden in production/);
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'test', MARKET_DATA_ADAPTER: 'bogus' }),
    ).toThrow(ConfigError);
  });
  it('requires Toss credentials with the toss adapter and validates their shape', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        ...PROD_FEES,
        MARKET_DATA_ADAPTER: 'toss',
      }),
    ).toThrow(/TOSS_CLIENT_ID/);
    const ok = loadConfig({
      ...BASE,
      NODE_ENV: 'production',
      ...PROD_FEES,
      MARKET_DATA_ADAPTER: 'toss',
      TOSS_CLIENT_ID: 'c_abcdefgh123',
      TOSS_CLIENT_SECRET: 's'.repeat(16),
    });
    expect(ok.marketDataAdapter).toBe('toss');
    expect(ok.toss).toEqual({
      clientId: 'c_abcdefgh123',
      clientSecret: 's'.repeat(16),
      restBaseUrl: 'https://openapi.tossinvest.com',
      wsUrl: 'wss://openapi-ws.tossinvest.com/ws/v1',
    });
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'test',
        MARKET_DATA_ADAPTER: 'toss',
        TOSS_CLIENT_ID: 'nope',
        TOSS_CLIENT_SECRET: 's'.repeat(16),
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'test',
        MARKET_DATA_ADAPTER: 'toss',
        TOSS_CLIENT_ID: 'c_abcdefgh123',
        TOSS_CLIENT_SECRET: 'short',
      }),
    ).toThrow(ConfigError);
  });
  it('allows provider URL overrides only outside production or on loopback (§5.3)', () => {
    const toss = {
      MARKET_DATA_ADAPTER: 'toss',
      TOSS_CLIENT_ID: 'c_abcdefgh123',
      TOSS_CLIENT_SECRET: 's'.repeat(16),
    };
    expect(
      loadConfig({
        ...BASE,
        ...toss,
        NODE_ENV: 'production',
        ...PROD_FEES,
        TOSS_REST_BASE_URL: 'http://127.0.0.1:4010',
        TOSS_WS_URL: 'ws://localhost:4011/ws/v1',
      }).toss?.restBaseUrl,
    ).toBe('http://127.0.0.1:4010');
    expect(() =>
      loadConfig({
        ...BASE,
        ...toss,
        NODE_ENV: 'production',
        ...PROD_FEES,
        TOSS_REST_BASE_URL: 'https://evil.example',
      }),
    ).toThrow(/loopback/);
    expect(() =>
      loadConfig({
        ...BASE,
        ...toss,
        NODE_ENV: 'production',
        ...PROD_FEES,
        TOSS_WS_URL: 'wss://evil.example/ws',
      }),
    ).toThrow(/loopback/);
    expect(
      loadConfig({
        ...BASE,
        ...toss,
        NODE_ENV: 'test',
        TOSS_REST_BASE_URL: 'https://mock.example',
      }).toss?.restBaseUrl,
    ).toBe('https://mock.example');
  });
  it('enforces write rate limits by default and refuses to switch them off in production (#34)', () => {
    const test = loadConfig({ ...BASE, NODE_ENV: 'test' });
    expect(test.rateLimitsEnabled).toBe(true);
    expect(test.trustProxy).toBe(false);
    expect(
      loadConfig({ ...BASE, NODE_ENV: 'test', RATE_LIMITS: 'off' })
        .rateLimitsEnabled,
    ).toBe(false);
    expect(
      loadConfig({ ...BASE, NODE_ENV: 'test', TRUST_PROXY: 'true' }).trustProxy,
    ).toBe(true);
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'production', RATE_LIMITS: 'off' }),
    ).toThrow(/RATE_LIMITS=off is forbidden in production/);
  });

  it('bounds the tunable timers', () => {
    const config = loadConfig({ ...BASE, NODE_ENV: 'test' });
    expect(config.shutdownDrainDeadlineMs).toBe(30_000);
    expect(config.recoveryStabilityMs).toBe(5_000);
    expect(
      loadConfig({
        ...BASE,
        NODE_ENV: 'test',
        SHUTDOWN_DRAIN_DEADLINE_MS: '10000',
        RECOVERY_STABILITY_MS: '0',
      }),
    ).toMatchObject({
      shutdownDrainDeadlineMs: 10_000,
      recoveryStabilityMs: 0,
    });
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'test',
        SHUTDOWN_DRAIN_DEADLINE_MS: '4999',
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'test',
        SHUTDOWN_DRAIN_DEADLINE_MS: '40001',
      }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'test', RECOVERY_STABILITY_MS: '30001' }),
    ).toThrow();
  });
  it('never echoes secret values in ConfigError messages', () => {
    try {
      loadConfig({
        ...BASE,
        NODE_ENV: 'test',
        MARKET_DATA_ADAPTER: 'toss',
        TOSS_CLIENT_ID: 'c_abcdefgh123',
        TOSS_CLIENT_SECRET: 'tooshort',
      });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('tooshort');
      expect(String((error as Error).message)).not.toContain(BASE.CSRF_SECRET);
    }
  });

  it('applies the default fee schedule outside production and requires it in production', () => {
    expect(loadConfig({ ...BASE, NODE_ENV: 'test' }).fees).toEqual(
      DEFAULT_FEE_SCHEDULES,
    );
    const production = {
      ...BASE,
      NODE_ENV: 'production',
      MARKET_DATA_ADAPTER: 'toss',
      TOSS_CLIENT_ID: 'c_abcdef1234',
      TOSS_CLIENT_SECRET: 's'.repeat(32),
    };
    expect(() => loadConfig(production)).toThrow(/FEE_SCHEDULE_VERSION/);
    const fees = {
      FEE_SCHEDULE_VERSION: '2',
      FEE_KR_COMMISSION_RATE: '0.0001',
      FEE_KR_SELL_TAX_RATE: '0.0015',
      FEE_US_COMMISSION_RATE: '0.002',
      FEE_US_SELL_TAX_RATE: '0',
    };
    expect(loadConfig({ ...production, ...fees }).fees).toEqual({
      version: 2,
      KR: { commissionRate: '0.0001', sellTaxRate: '0.0015' },
      US: { commissionRate: '0.002', sellTaxRate: '0' },
    });
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'test', FEE_SCHEDULE_VERSION: '1' }),
    ).toThrow(/partial/);
    expect(() =>
      loadConfig({ ...production, ...fees, FEE_KR_COMMISSION_RATE: '1.5' }),
    ).toThrow(/decimal rate/);
  });
});
