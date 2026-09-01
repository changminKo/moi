import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkEgress,
  parseAllowlist,
  preflight,
  validateEnvironment,
} from './preflight-deploy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'S3cr3t-value-that-must-never-be-printed-0123456789';
const goodEnv = () => ({
  PUBLIC_ORIGIN: 'https://app.moi.example',
  PUBLIC_API_ORIGIN: 'https://api.moi.example',
  DATABASE_URL: `postgres://moi:${SECRET}@db.internal:5432/moi`,
  POSTGRES_PASSWORD: SECRET,
  SESSION_HASH_KEYS: `${SECRET}a,${SECRET}b`,
  CSRF_SECRET: SECRET,
  ADMIN_API_KEY: SECRET,
  TOSS_CLIENT_ID: 'c_abcdef1234',
  TOSS_CLIENT_SECRET: SECRET,
});
const allowlistYaml = `
provider: toss
registered_egress_ips:
  - address: 203.0.113.10
    environment: production
    registered_at: 2026-09-01
    registered_by: ops@example.com
  - address: 198.51.100.7
    environment: staging
    registered_at: 2026-09-01
    registered_by: ops@example.com
`;

describe('validateEnvironment', () => {
  it('accepts a complete production environment', () => {
    assert.deepEqual(validateEnvironment(goodEnv()), []);
  });
  it('names every missing variable without echoing values', () => {
    const failures = validateEnvironment({});
    assert.equal(failures.length, 9);
    assert.ok(failures.every((f) => f.problem === 'is required'));
  });
  it('rejects placeholders, short secrets, http origins, localhost databases, and malformed client ids', () => {
    const env = {
      ...goodEnv(),
      CSRF_SECRET: 'replace-with-at-least-32-random-bytes',
      ADMIN_API_KEY: 'short',
      PUBLIC_ORIGIN: 'http://app.moi.example',
      PUBLIC_API_ORIGIN: 'https://api.moi.example/v1',
      DATABASE_URL: 'postgres://moi:pw@localhost:5432/moi',
      TOSS_CLIENT_ID: 'abc',
    };
    const problems = Object.fromEntries(
      validateEnvironment(env).map((f) => [f.variable, f.problem]),
    );
    assert.match(problems.CSRF_SECRET, /placeholder/);
    assert.match(problems.ADMIN_API_KEY, /at least 32/);
    assert.match(problems.PUBLIC_ORIGIN, /https/);
    assert.match(problems.PUBLIC_API_ORIGIN, /bare origin/);
    assert.match(problems.DATABASE_URL, /localhost/);
    assert.match(problems.TOSS_CLIENT_ID, /at least 8 letters/);
  });
  it('requires the application origins to match the TLS edge domains when present', () => {
    const ok = validateEnvironment({
      ...goodEnv(),
      WEB_DOMAIN: 'app.moi.example',
      API_DOMAIN: 'api.moi.example',
    });
    assert.deepEqual(ok, []);
    const bad = validateEnvironment({
      ...goodEnv(),
      WEB_DOMAIN: 'other.example',
      API_DOMAIN: 'api.moi.example',
    });
    assert.deepEqual(
      bad.map((f) => f.variable),
      ['PUBLIC_ORIGIN'],
    );
    assert.match(bad[0].problem, /https:\/\/other\.example/);
  });
  it('refuses environment overrides of the compose literals', () => {
    const failures = validateEnvironment({
      ...goodEnv(),
      MARKET_DATA_ADAPTER: 'fake',
      TOSS_REST_BASE_URL: 'https://example.test',
    });
    assert.deepEqual(failures.map((f) => f.variable).sort(), [
      'MARKET_DATA_ADAPTER',
      'TOSS_REST_BASE_URL',
    ]);
  });
});

describe('strategy runner variables', () => {
  const TRADE = 'https://discord.com/api/webhooks/900000000000000000/trade-tok';
  const OPS = 'https://discord.com/api/webhooks/800000000000000000/ops-token1';

  it('accepts an environment with no bot variables at all', () => {
    assert.deepEqual(validateEnvironment(goodEnv()), []);
  });

  it('accepts a well-formed trade webhook on its own channel', () => {
    assert.deepEqual(
      validateEnvironment({
        ...goodEnv(),
        DISCORD_WEBHOOK_URL: OPS,
        DISCORD_WEBHOOK_TRADE_URL: TRADE,
      }),
      [],
    );
  });

  // Design §7.4: the bot's channel is separate so trading traffic cannot bury
  // an incident alert. One webhook under both names defeats that silently.
  it('refuses the operational webhook reused as the trade webhook', () => {
    const problems = Object.fromEntries(
      validateEnvironment({
        ...goodEnv(),
        DISCORD_WEBHOOK_URL: OPS,
        DISCORD_WEBHOOK_TRADE_URL: OPS,
      }).map((f) => [f.variable, f.problem]),
    );
    assert.match(problems.DISCORD_WEBHOOK_TRADE_URL, /different channel/);
  });

  it('refuses a trade webhook that is not an https Discord webhook', () => {
    for (const value of [
      'https://example.com/api/webhooks/1/tok',
      'http://discord.com/api/webhooks/1/tok',
      'not-a-url',
    ]) {
      const problems = validateEnvironment({
        ...goodEnv(),
        DISCORD_WEBHOOK_TRADE_URL: value,
      });
      assert.equal(problems.length, 1, value);
      assert.equal(problems[0].variable, 'DISCORD_WEBHOOK_TRADE_URL');
    }
  });

  it('never echoes the rejected webhook value', () => {
    const [failure] = validateEnvironment({
      ...goodEnv(),
      DISCORD_WEBHOOK_TRADE_URL: 'https://example.com/leaked-path-abcdef',
    });
    assert.ok(!failure.problem.includes('leaked-path'));
  });

  // §4.1: the compose file derives the bot's origins from this deployment's
  // own PUBLIC_ORIGIN / PUBLIC_API_ORIGIN. An environment override is how the
  // bot would get aimed somewhere else, so the deploy refuses one outright.
  it('refuses environment overrides of the bot origins', () => {
    const problems = Object.fromEntries(
      validateEnvironment({
        ...goodEnv(),
        BOT_API_ORIGIN: 'https://api.exchange.example',
        BOT_PUBLIC_ORIGIN: 'https://app.exchange.example',
      }).map((f) => [f.variable, f.problem]),
    );
    assert.match(problems.BOT_API_ORIGIN, /compose/);
    assert.match(problems.BOT_PUBLIC_ORIGIN, /compose/);
  });
});

describe('provider allow list', () => {
  it('parses the committed file into well-formed entries', () => {
    const text = spawnSync(
      'cat',
      [join(root, 'infra/provider-allowlist.yaml')],
      {
        encoding: 'utf8',
      },
    ).stdout;
    const entries = parseAllowlist(text);
    for (const entry of entries) {
      assert.match(entry.address, /^(\d{1,3}\.){3}\d{1,3}$|:/);
      assert.ok(entry.environment.length > 0);
      assert.ok(!Number.isNaN(Date.parse(entry.registeredAt)));
      assert.ok(entry.registeredBy.length > 0);
    }
    // The Oracle reference host's reserved address is the only production
    // registration; anything else is refused.
    assert.equal(checkEgress('138.2.53.206', entries, 'production'), undefined);
    assert.match(
      checkEgress('203.0.113.1', entries, 'production') ?? '',
      /not registered for production/,
    );
  });
  it('accepts a registered address for its environment only', () => {
    const list = parseAllowlist(allowlistYaml);
    assert.equal(checkEgress('203.0.113.10', list), undefined);
    assert.match(
      checkEgress('198.51.100.7', list),
      /not registered for production/,
    );
    assert.equal(checkEgress('198.51.100.7', list, 'staging'), undefined);
    assert.match(
      checkEgress('203.0.113.10', [], 'production'),
      /no egress address is registered/,
    );
    assert.match(checkEgress('not-an-ip', list), /not an IP address/);
  });
  it('rejects malformed entries', () => {
    assert.throws(
      () =>
        parseAllowlist(
          'provider: toss\nregistered_egress_ips:\n  - address: nope\n',
        ),
      /IPv4 or IPv6/,
    );
    assert.throws(
      () => parseAllowlist('provider: kiwoom\nregistered_egress_ips: []\n'),
      /provider/,
    );
  });
});

describe('preflight', () => {
  it('passes with a good environment, an explicit egress ip, and compose skipped', async () => {
    const lines = [];
    const code = await preflight({
      env: { ...goodEnv() },
      // Overrides are for operators' machines, never production (see below).
      args: [
        '--skip-compose',
        '--egress-ip',
        '198.51.100.7',
        '--environment',
        'staging',
      ],
      allowlistText: allowlistYaml,
      log: (l) => lines.push(l),
    });
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(lines.some((l) => /^ok\s+egress 198\.51\.100\.7/.test(l)));
  });
  it('fails closed on any problem and never prints a secret value', async () => {
    const lines = [];
    const code = await preflight({
      env: { ...goodEnv(), CSRF_SECRET: 'short' },
      args: ['--skip-compose'],
      allowlistText: allowlistYaml,
      fetchImpl: async () => ({ ok: true, text: async () => '192.0.2.1' }),
      log: (l) => lines.push(l),
    });
    assert.equal(code, 1);
    const output = lines.join('\n');
    assert.match(output, /FAIL environment: CSRF_SECRET must be at least 32/);
    assert.match(output, /FAIL egress address 192\.0\.2\.1 is not registered/);
    assert.ok(!output.includes(SECRET), 'secret value leaked into output');
  });
  it('reports the failing interpolation when the environment is incomplete (cli)', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/preflight-deploy.mjs'),
        '--skip-compose',
        '--egress-ip',
        '203.0.113.10',
        '--environment',
        'staging',
      ],
      { env: { PATH: process.env.PATH }, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /FAIL environment: TOSS_CLIENT_SECRET is required/,
    );
    assert.match(result.stdout, /FAIL no egress address is registered/);
  });

  it('refuses egress overrides for the production environment', async () => {
    const lines = [];
    const code = await preflight({
      env: { ...goodEnv() },
      args: ['--skip-compose', '--skip-egress'],
      allowlistText: allowlistYaml,
      log: (l) => lines.push(l),
    });
    assert.equal(code, 1);
    assert.match(
      lines.join('\n'),
      /production preflight must observe the real egress address/,
    );
    const withIp = [];
    const code2 = await preflight({
      env: { ...goodEnv() },
      args: ['--skip-compose', '--egress-ip', '203.0.113.10'],
      allowlistText: allowlistYaml,
      log: (l) => withIp.push(l),
    });
    assert.equal(code2, 1);
  });
});
