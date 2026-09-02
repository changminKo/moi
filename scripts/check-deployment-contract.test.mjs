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
import { fakeWebhook } from './lib/secret-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED = [
  '.nvmrc',
  'package.json',
  '.dockerignore',
  '.github',
  'apps/paper-api/Dockerfile',
  'apps/web/Dockerfile',
  'apps/strategy-runner/Dockerfile',
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
  // The workspace-dependency coverage check walks the app manifests.
  'apps/paper-api/package.json',
  'apps/web/package.json',
  'apps/strategy-runner/package.json',
  'packages/trading-core/package.json',
  'packages/market-data/package.json',
  'packages/strategy-sdk/package.json',
  'packages/strategy-reporter/package.json',
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
  it('fails when the api build context misses a workspace dependency', () => {
    // The exact mutation that broke the #43 deploy: apps/strategy-runner is a
    // dev dependency of paper-api, and without its COPY the image build dies
    // with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND while `main` stays stale on GHCR.
    const dir = copyRepo((d) => {
      const file = join(d, 'apps/paper-api/Dockerfile');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /^COPY apps\/strategy-runner .*\n/m,
          '',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /misses apps\/strategy-runner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
        `${readFileSync(file, 'utf8')}\n# DISCORD_WEBHOOK_URL=${fakeWebhook('123456789', 'abcDEF_ghi-jkl')}\n`,
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
   * #86: the alerting-dependency check reads `notify.sh`'s own guards, so it is
   * only as good as its parser. A guard written in another valid idiom must
   * still be read — and a guard the parser cannot read must fail the build
   * rather than silently drop the tool out of the list.
   */
  const guardCases = [
    [
      'type -p',
      'type -p rsync >/dev/null 2>&1 || soft_fail "rsync missing, nothing posted"',
      /notify\.sh requires rsync/,
    ],
    [
      'which with a combined redirect',
      'which rsync &>/dev/null || soft_fail "rsync missing, nothing posted"',
      /notify\.sh requires rsync/,
    ],
    [
      'command -v without a redirect',
      'command -v rsync || soft_fail "rsync missing, nothing posted"',
      /notify\.sh requires rsync/,
    ],
    [
      'a shape the parser does not know',
      '[ -x /usr/bin/rsync ] || soft_fail "rsync missing, nothing posted"',
      /unrecognised dependency guard in infra\/oracle\/notify\.sh/,
    ],
    [
      'a message that names a different tool than the probe',
      'command -v jq >/dev/null 2>&1 || soft_fail "rsync missing, nothing posted"',
      /unrecognised dependency guard in infra\/oracle\/notify\.sh:\d+: .* names rsync as missing but no probe/,
    ],
    [
      'an if/then block',
      'if ! command -v rsync >/dev/null 2>&1; then\n  soft_fail "rsync missing, nothing posted"\nfi',
      /notify\.sh requires rsync/,
    ],
    [
      'a brace group after the probe',
      'command -v rsync >/dev/null 2>&1 || { soft_fail "rsync missing, nothing posted"; }',
      /notify\.sh requires rsync/,
    ],
    [
      'a probe of a variable',
      'for tool in rsync; do command -v "$tool" >/dev/null 2>&1 || soft_fail "$tool missing"; done',
      /unrecognised dependency guard in infra\/oracle\/notify\.sh:\d+: cannot name the tool/,
    ],
    [
      'a probe with no soft_fail at all',
      'hash rsync 2>/dev/null || exit 1',
      /notify\.sh requires rsync/,
    ],
    [
      'a probe chained after another command',
      '[ -n "$payload" ] && which rsync >/dev/null 2>&1 || soft_fail "rsync missing, nothing posted"',
      /notify\.sh requires rsync/,
    ],
  ];
  for (const [name, guard, message] of guardCases)
    it(`fails on an unprovisioned notify.sh dependency guarded with ${name}`, () => {
      const dir = copyRepo((d) => {
        const file = join(d, 'infra/oracle/notify.sh');
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(
            /^command -v perl [^\n]*$/m,
            (line) => `${line}\n${guard}`,
          ),
        );
      });
      try {
        const result = run(dir);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  /**
   * The probe words are ordinary English too. Text that merely mentions them
   * — a message, a trailing comment — must not be read as a dependency.
   */
  const benignLines = [
    ['a message that says "type"', 'echo "please type your rsync path" >&2'],
    ['a trailing comment', 'level="fatal" # type check: keep this in sync'],
    ['a message that says "which"', 'echo "decide which rsync to use" >&2'],
    [
      'a message with "then type"',
      'echo "retry, and then type your password again" >&2',
    ],
    [
      'a message with "do hash"',
      "echo 'we do hash every payload before sending' >&2",
    ],
    [
      'a comment after a command',
      'level="$1" && printf %s "$level" # then type it: legacy',
    ],
  ];
  for (const [name, line] of benignLines)
    it(`still passes when notify.sh gains ${name}`, () => {
      const dir = copyRepo((d) => {
        const file = join(d, 'infra/oracle/notify.sh');
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(
            /^command -v perl [^\n]*$/m,
            (guard) => `${guard}\n${line}`,
          ),
        );
      });
      try {
        const result = run(dir);
        assert.equal(result.status, 0, result.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  it('still passes when a provisioned tool is guarded in another idiom', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/notify.sh');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /^command -v perl ([^\n]*)$/m,
          'type -p perl $1',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 0, result.stderr);
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
  /**
   * Phase D wires the image (#93). Each of these is a way the three artifacts
   * that must move together — Dockerfile, publish matrix, GHCR overlay — could
   * drift apart, plus the host-side promise that an enabled bot is actually up.
   */
  it('fails when the publish workflow does not build the strategy runner image', () => {
    const dir = copyRepo((d) => {
      const file = join(d, '.github/workflows/publish.yml');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /\n\s*- name: strategy-runner\n\s*dockerfile: apps\/strategy-runner\/Dockerfile/,
          '',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /publish\.yml must build an image for compose service bot/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  /**
   * #99: the arm64 half of every image is built on a native arm64 runner. Under
   * QEMU `pnpm fetch` hung for 43 minutes and the publish timed out, which on
   * an arm64 production host means no deploy at all. Each case is a way the
   * workflow could drift back.
   */
  const publishCases = [
    [
      'the publish workflow brings QEMU back',
      (text) =>
        text.replace(
          '      - uses: docker/setup-buildx-action@v4\n',
          '      - uses: docker/setup-qemu-action@v3\n      - uses: docker/setup-buildx-action@v4\n',
        ),
      /publish\.yml must not build under QEMU/,
    ],
    [
      'arm64 is built on an amd64 runner',
      (text) =>
        text.replace('runner: ubuntu-24.04-arm', 'runner: ubuntu-24.04'),
      /publish\.yml must build arm64 on a native arm64 runner/,
    ],
    [
      'a publish job may run for 45 minutes again',
      (text) => text.replace('timeout-minutes: 20', 'timeout-minutes: 45'),
      /publish\.yml jobs must time out within 20 minutes/,
    ],
    [
      'the manifest job waits for every build to succeed',
      (text) => text.replace(/^ {4}if: \$\{\{ !cancelled\(\) \}\}\n/m, ''),
      /publish\.yml manifests must run after a failed build too/,
    ],
    [
      'the manifest job promotes without verifying the merge',
      (text) =>
        text.replace(
          / {6}- name: Verify the manifest carries one image per architecture\n[\s\S]*?(?= {6}- name: Trivy scan)/,
          '',
        ),
      /publish\.yml must verify the merged manifest/,
    ],
    [
      'the manifest job forgets an image',
      (text) =>
        text.replace(
          /(manifests:[\s\S]*?name: \[paper-api, web), strategy-runner\]/,
          '$1]',
        ),
      /publish\.yml must assemble a manifest for strategy-runner/,
    ],
  ];
  for (const [name, mutate, message] of publishCases)
    it(`fails when ${name}`, () => {
      const dir = copyRepo((d) => {
        const file = join(d, '.github/workflows/publish.yml');
        const before = readFileSync(file, 'utf8');
        const after = mutate(before);
        assert.notEqual(after, before, 'the mutation must land');
        writeFileSync(file, after);
      });
      try {
        const result = run(dir);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  it('fails when the production overlay lets the bot build on the host', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/compose.override.yaml');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /\n {2}bot:\n {4}image: [^\n]+\n {4}build: !reset null\n/,
          '\n',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /overlay must pull bot from GHCR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('fails when the bot image runs something other than the runner entry point', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'apps/strategy-runner/Dockerfile');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          'CMD ["node", "apps/strategy-runner/dist/main.js"]',
          'CMD ["node", "apps/strategy-runner/dist/index.js"]',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /bot Dockerfile CMD must run apps\/strategy-runner\/dist\/main\.js/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('fails when the bot image does not own its state directory', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'apps/strategy-runner/Dockerfile');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          ' \\\n    && mkdir -p /var/lib/moi-bot && chown node:node /var/lib/moi-bot',
          '',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /bot image must own \/var\/lib\/moi-bot as node/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('fails when deploy.sh stops checking that an enabled bot is running', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/deploy.sh');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /COMPOSE_PROFILES/g,
          'COMPOSE_PROFILE',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /deploy\.sh must fail the release when COMPOSE_PROFILES enables the bot but the container is not running steadily/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('fails when the alerting path needs a tool the host never installs', () => {
    const dir = copyRepo((d) => {
      for (const [file, from, to] of [
        ['infra/oracle/bootstrap.sh', 'gnupg jq perl age', 'gnupg jq age'],
        [
          'infra/oracle/deploy.sh',
          'for tool in jq perl; do',
          'for tool in jq; do',
        ],
      ]) {
        const path = join(d, file);
        const before = readFileSync(path, 'utf8');
        assert.ok(
          before.includes(from),
          `${file} no longer contains "${from}"`,
        );
        writeFileSync(path, before.replace(from, to));
      }
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /notify\.sh requires perl/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when deploy stops re-executing the freshly checked-out script', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/deploy.sh');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          'deploy_reexec "$REPO/infra/oracle/deploy.sh" "$REF"\n',
          '',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /deploy\.sh must re-exec the checked-out script/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when published runtime images lose the source revision label', () => {
    const dir = copyRepo((d) => {
      const file = join(d, '.github/workflows/publish.yml');
      const before = readFileSync(file, 'utf8');
      const after = before.replace(
        `          labels: org.opencontainers.image.revision=\${{ github.sha }}\n`,
        '',
      );
      assert.notEqual(after, before, 'revision-label mutation matched nothing');
      writeFileSync(file, after);
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /published runtime images must carry the source revision label/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when deploy skips pulled-image revision verification', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/deploy.sh');
      const before = readFileSync(file, 'utf8');
      const after = before.replace(
        `verify_release_image_revisions "$checkout_sha" "$paper_api_image" "$web_image" \${bot_image:+"$bot_image"}\n`,
        '',
      );
      assert.notEqual(
        after,
        before,
        'revision-verification mutation matched nothing',
      );
      writeFileSync(file, after);
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /deploy\.sh must verify pulled image revisions before migrations/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
