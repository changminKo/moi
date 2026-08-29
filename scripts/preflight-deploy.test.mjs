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

describe('provider allow list', () => {
  it('parses the committed file (empty until an address is registered)', () => {
    const text = spawnSync(
      'cat',
      [join(root, 'infra/provider-allowlist.yaml')],
      {
        encoding: 'utf8',
      },
    ).stdout;
    assert.deepEqual(parseAllowlist(text), []);
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
      args: ['--skip-compose', '--egress-ip', '203.0.113.10'],
      allowlistText: allowlistYaml,
      log: (l) => lines.push(l),
    });
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(lines.some((l) => /^ok\s+egress 203\.0\.113\.10/.test(l)));
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
});
