import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED = [
  '.nvmrc',
  'package.json',
  '.dockerignore',
  '.github',
  'apps/paper-api/Dockerfile',
  'apps/web/Dockerfile',
  'apps/web/server.mjs',
  'apps/web/server.test.mjs',
  'apps/paper-api/src/lifecycle/shutdown-coordinator.ts',
  'infra',
  'docs/runbooks',
  'docs/operations',
  'scripts/check-deployment-contract.mjs',
  'apps/strategy-runner/src/api-origin.ts',
  'packages/market-data/contracts',
  'packages/market-data/src/toss',
  'apps/paper-api/src/config.ts',
  'apps/paper-api/src/config.test.ts',
];

function copyRepo(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'moi-contract-'));
  for (const entry of TRACKED) {
    // `apps/strategy-runner` arrives in its own phase; the checks that read it
    // are conditional, so its absence must not break the harness.
    if (!existsSync(join(root, entry))) continue;
    cpSync(join(root, entry), join(dir, entry), { recursive: true });
  }
  cpSync(
    join(root, 'node_modules', 'yaml'),
    join(dir, 'node_modules', 'yaml'),
    { recursive: true, dereference: true },
  );
  mutate?.(dir);
  return dir;
}
function run(dir) {
  return spawnSync(
    process.execPath,
    [join(dir, 'scripts/check-deployment-contract.mjs')],
    { encoding: 'utf8' },
  );
}

describe('check-deployment-contract (A8)', () => {
  it('passes on the committed repository', () => {
    const dir = copyRepo();
    try {
      const result = run(dir);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const [label, replacement] of [
    ['removed', ''],
    [
      'interpolated',
      `MARKET_DATA_ADAPTER: "$${'{'}MARKET_DATA_ADAPTER:?adapter}"`,
    ],
    ['fake', 'MARKET_DATA_ADAPTER: fake'],
  ]) {
    it(`fails when the compose adapter literal is ${label}`, () => {
      const dir = copyRepo((d) => {
        const file = join(d, 'infra/compose.yaml');
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(
            'MARKET_DATA_ADAPTER: toss',
            replacement,
          ),
        );
      });
      try {
        const result = run(dir);
        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          /MARKET_DATA_ADAPTER must be the literal toss/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  it('fails when a Toss secret is not a required interpolation', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/compose.yaml');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /TOSS_CLIENT_SECRET: "\$\{[^}]+\}"/,
          'TOSS_CLIENT_SECRET: literal-secret-value-1234',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /TOSS_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('fails when an alerting script carries a literal Discord webhook URL', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/notify.sh');
      writeFileSync(
        file,
        `${readFileSync(file, 'utf8')}\n# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123456789/abcDEF_ghi-jkl\n`,
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /infra\/oracle\/notify\.sh appears to contain a literal secret/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The strategy runner's half of the contract (strategy-runner design §4.1,
   * §7.4, §8.1). Each case is a way the deployment surface could quietly let
   * the bot start on its own, reach a host that is not this deployment's paper
   * API, or carry a credential it has no business holding.
   */
  const botCases = [
    [
      'the bot is no longer profile-gated',
      (text) => text.replace('    profiles:\n      - bot\n', ''),
      /bot must sit behind exactly the `bot` profile/,
    ],
    [
      'the connect target becomes an environment variable',
      (text) =>
        text.replace(
          'BOT_API_ORIGIN: "http://paper-api:3000"',
          `BOT_API_ORIGIN: "$${'{'}BOT_API_ORIGIN:?where the bot trades}"`,
        ),
      /BOT_API_ORIGIN must be a committed literal/,
    ],
    [
      'the Origin header is conflated with the connect target',
      (text) =>
        text.replace(
          /BOT_PUBLIC_ORIGIN: "\$\{PUBLIC_ORIGIN[^"]*"/,
          'BOT_PUBLIC_ORIGIN: "http://paper-api:3000"',
        ),
      /BOT_PUBLIC_ORIGIN must be the deployment's own PUBLIC_ORIGIN/,
    ],
    [
      'the configuration path leaves the read-only mount',
      (text) =>
        text.replace(
          'BOT_CONFIG_PATH: /etc/moi-bot/runner.json',
          'BOT_CONFIG_PATH: /var/lib/moi-bot/runner.json',
        ),
      /must live inside a read-only bind mount/,
    ],
    [
      'the operator configuration is mounted writable',
      (text) => text.replace('- ./bot:/etc/moi-bot:ro', '- ./bot:/etc/moi-bot'),
      /bind mount \.\/bot must be read-only/,
    ],
    [
      'an environment-supplied allow list is added',
      (text) =>
        text.replace(
          '      BOT_STATE_DIR: /var/lib/moi-bot',
          `      BOT_ORIGIN_ALLOWLIST: "$${'{'}BOT_ORIGIN_ALLOWLIST:-}"\n      BOT_STATE_DIR: /var/lib/moi-bot`,
        ),
      /no allow-list override/,
    ],
    [
      'the bot is handed a ledger credential',
      (text) =>
        text.replace(
          '      BOT_STATE_DIR: /var/lib/moi-bot',
          `      ADMIN_API_KEY: "$${'{'}ADMIN_API_KEY:?admin key}"\n      BOT_STATE_DIR: /var/lib/moi-bot`,
        ),
      /no ledger credential/,
    ],
    [
      'the bot posts into the operational Discord channel',
      (text) =>
        text.replace(
          /DISCORD_WEBHOOK_TRADE_URL: "\$\{DISCORD_WEBHOOK_TRADE_URL:-\}"/,
          `DISCORD_WEBHOOK_URL: "$${'{'}DISCORD_WEBHOOK_URL:-}"`,
        ),
      /operational Discord webhook must never reach the bot/,
    ],
    [
      'the bot publishes a port',
      (text) =>
        text.replace(
          '    volumes:\n      - bot-state:/var/lib/moi-bot',
          '    ports:\n      - "9000:9000"\n    volumes:\n      - bot-state:/var/lib/moi-bot',
        ),
      /bot must not publish a port/,
    ],
    [
      'the bot keeps its state on no volume at all',
      (text) => text.replace('      - bot-state:/var/lib/moi-bot\n', ''),
      /bot needs a state volume/,
    ],
  ];
  for (const [label, mutate, expected] of botCases) {
    it(`fails when ${label}`, () => {
      const dir = copyRepo((d) => {
        const file = join(d, 'infra/compose.yaml');
        const before = readFileSync(file, 'utf8');
        const after = mutate(before);
        assert.notEqual(after, before, `mutation "${label}" matched nothing`);
        writeFileSync(file, after);
      });
      try {
        const result = run(dir);
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('fails when the trade webhook is missing from the secret template', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/secrets.env.tpl');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /^DISCORD_WEBHOOK_TRADE_URL=.*$/m,
          '',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must reference DISCORD_WEBHOOK_TRADE_URL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Design §4.1's allow-list is a code constant in the runner, and the compose
   * connect target has to be on it or the bot fails closed at start-up — a
   * failure nobody sees until someone enables the profile. These two cases are
   * the mechanical version of "the compose change and the allow-list go in one
   * commit": the checker reads the constant, so the pair cannot drift.
   */
  const writeAllowList = (dir, hosts) => {
    const file = join(dir, 'apps/strategy-runner/src/api-origin.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `export const ALLOWED_API_HOSTS: ReadonlySet<string> = new Set([\n${hosts
        .map((host) => `  '${host}',`)
        .join('\n')}\n]);\n`,
    );
  };

  it('fails when the connect target is not on the runner allow-list', () => {
    const dir = copyRepo((d) => writeAllowList(d, ['127.0.0.1', 'localhost']));
    try {
      const result = run(dir);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /BOT_API_ORIGIN host paper-api is not on the runner's ALLOWED_API_HOSTS/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes once the allow-list names the compose service', () => {
    const dir = copyRepo((d) =>
      writeAllowList(d, ['127.0.0.1', 'localhost', '[::1]', 'paper-api']),
    );
    try {
      const result = run(dir);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
