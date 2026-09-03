#!/usr/bin/env node
/**
 * Deployment-contract checker.
 *
 * Parses the committed deployment artifacts (Compose, Dockerfiles, Prometheus
 * rules, Alertmanager routing, CI workflow, runbooks) and fails unless every
 * operational invariant from the architecture spec holds. Structured files are
 * parsed as YAML so the checks assert on values, not on substrings.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = (...segments) => join(root, ...segments);
const read = (relative) => {
  const absolute = path(relative);
  assert.ok(existsSync(absolute), `missing deployment file: ${relative}`);
  return readFileSync(absolute, 'utf8');
};
const readYaml = (relative) => parseYaml(read(relative));

const NODE_VERSION = '24.19.0';
const PNPM_VERSION = '11.22.0';
const PUBLIC_SERVICES = ['web', 'paper-api'];
const PRIVATE_SERVICES = ['postgres', 'redis'];
/**
 * Declared in compose but gated behind a profile, so `docker compose up` and
 * infra/oracle/deploy.sh leave it alone. The strategy runner is here because a
 * service outside the contract is a service nobody checks.
 */
const OPT_IN_SERVICES = ['bot'];
/** Nothing on this list may reach the bot: it trades through the public API. */
const BOT_FORBIDDEN_ENV =
  /TOSS|DATABASE|REDIS|POSTGRES|SECRET|ADMIN|SESSION|CSRF|MARKET_DATA|FEE_|ALLOW_?LIST/i;
const BOUNDED_ALERT_LABELS = new Set([
  'severity',
  'market',
  'state',
  'cause_group',
  'tx_type',
  'lock_type',
]);
const RUNBOOK_SECTIONS = [
  'Symptoms',
  'Safe first action',
  'CANCEL_ONLY',
  'Read-only diagnosis',
  'Recovery preconditions',
  'Verification',
  'Rollback criteria',
  'Evidence to retain',
];
const RUNBOOKS = [
  'docs/runbooks/market-data-degraded.md',
  'docs/runbooks/redis-or-leader-loss.md',
  'docs/runbooks/postgres-or-outbox-lag.md',
  'docs/runbooks/emergency-cancel-only.md',
  'docs/runbooks/anonymous-session-cleanup.md',
];
const SECRET_PATTERNS = [
  /TOSS_[A-Z_]*(TOKEN|SECRET|KEY)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{8,}/,
  /POSTGRES_PASSWORD\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{4,}/,
  /(CSRF_SECRET|SESSION_HASH_KEYS|ADMIN_API_KEY)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{8,}/,
  /postgres(ql)?:\/\/[^:\s]+:[^@$\s]+@/,
  /discord(app)?\.com\/api\/webhooks\/\d+\/\S+/,
];

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

/** Parses a Compose duration such as "45s" or "1m30s" into milliseconds. */
function durationToMs(value) {
  assert.equal(
    typeof value,
    'string',
    `expected duration string, got ${value}`,
  );
  const matches = [...value.matchAll(/(\d+)(ms|s|m|h)/g)];
  assert.ok(matches.length > 0, `unparseable duration ${value}`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return matches.reduce((total, [, n, u]) => total + Number(n) * unit[u], 0);
}

/** Extracts instruction lines (after resolving continuations) from a Dockerfile. */
function dockerfileInstructions(text) {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [instruction, ...rest] = line.split(/\s+/);
      return { instruction: instruction.toUpperCase(), args: rest.join(' ') };
    });
}

function checkDockerfile(relative) {
  const instructions = dockerfileInstructions(read(relative));
  const froms = instructions.filter((i) => i.instruction === 'FROM');
  assert.ok(froms.length >= 2, `${relative} must be a multi-stage build`);
  for (const from of froms) {
    const image = from.args.split(/\s+/)[0];
    if (image.startsWith('node:')) {
      assert.match(
        image,
        new RegExp(`^node:${NODE_VERSION.replaceAll('.', '\\.')}(-|$)`),
        `${relative} must pin Node ${NODE_VERSION}; found ${image}`,
      );
    } else {
      assert.ok(
        froms.some((f) => f.args.includes(` AS ${image}`)),
        `${relative} references non-node, non-stage base image ${image}`,
      );
    }
  }
  const users = instructions.filter((i) => i.instruction === 'USER');
  assert.ok(users.length > 0, `${relative} never switches away from root`);
  assert.equal(
    users.at(-1).args,
    'node',
    `${relative} final USER must be node`,
  );
  const runs = instructions
    .filter((i) => i.instruction === 'RUN')
    .map((i) => i.args);
  assert.ok(
    runs.some(
      (r) => r.includes(`pnpm@${PNPM_VERSION}`) && r.includes('corepack'),
    ),
    `${relative} must activate pnpm ${PNPM_VERSION} through corepack`,
  );
  assert.ok(
    runs.some((r) => /pnpm fetch/.test(r)),
    `${relative} must use pnpm fetch`,
  );
  assert.ok(
    runs.some((r) => /pnpm install .*--frozen-lockfile/.test(r)),
    `${relative} must install with --frozen-lockfile`,
  );
  const copies = instructions.filter((i) => i.instruction === 'COPY');
  assert.ok(
    !copies.some((c) => /(^|\s)\.env(\s|$)/.test(c.args)),
    `${relative} must not copy .env`,
  );
  return instructions;
}

/**
 * Build-context sources of every COPY (stage-to-stage copies excluded): the
 * paths that must exist in the context for the build to see them.
 */
function contextCopySources(instructions) {
  const sources = [];
  for (const copy of instructions.filter((i) => i.instruction === 'COPY')) {
    const tokens = copy.args.split(/\s+/);
    if (tokens.some((t) => t.startsWith('--from='))) continue;
    const paths = tokens.filter((t) => !t.startsWith('--'));
    sources.push(...paths.slice(0, -1).map((s) => s.replace(/\/+$/, '')));
  }
  return sources;
}

/**
 * Every workspace:* dependency of the app, dev included, resolved recursively
 * to its directory. `pnpm deploy` resolves the app's whole manifest — a dev
 * dependency whose directory is missing from the build context fails the image
 * build with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND (this broke the #43 deploy: the
 * api image never built because apps/strategy-runner was not copied in).
 */
function workspaceDependencyDirs(appDir) {
  const dirs = new Map();
  const queue = [appDir];
  while (queue.length > 0) {
    const manifest = JSON.parse(read(join(queue.pop(), 'package.json')));
    const wanted = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, range] of Object.entries(wanted)) {
      if (!String(range).startsWith('workspace:') || dirs.has(name)) continue;
      const short = name.replace(/^@[^/]+\//, '');
      const candidates = ['packages', 'apps']
        .map((kind) => `${kind}/${short}`)
        .filter((candidate) => existsSync(path(candidate, 'package.json')));
      assert.equal(
        candidates.length,
        1,
        `cannot locate workspace package ${name} (dependency of ${appDir})`,
      );
      dirs.set(name, candidates[0]);
      queue.push(candidates[0]);
    }
  }
  return dirs;
}

check('node runtime pin', () => {
  assert.equal(read('.nvmrc').trim(), NODE_VERSION);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.packageManager, `pnpm@${PNPM_VERSION}`);
  assert.match(pkg.engines.node, /24\.19/);
  assert.equal(
    pkg.scripts['check:deployment'],
    'node scripts/check-deployment-contract.mjs',
  );
});

check('api image', () => {
  const instructions = checkDockerfile('apps/paper-api/Dockerfile');
  const cmd = instructions.filter((i) => i.instruction === 'CMD').at(-1);
  assert.ok(cmd, 'api Dockerfile needs CMD');
  assert.match(cmd.args, /apps\/paper-api\/dist\/main\.js/);
  assert.match(cmd.args, /"node"/, 'api CMD must use exec form with node');
});

check('image build contexts carry every workspace dependency', () => {
  for (const app of ['apps/paper-api', 'apps/web', 'apps/strategy-runner']) {
    const instructions = dockerfileInstructions(read(`${app}/Dockerfile`));
    const sources = contextCopySources(instructions);
    const covered = (dir) =>
      sources.some((s) => s === dir || dir.startsWith(`${s}/`));
    for (const [name, dir] of workspaceDependencyDirs(app)) {
      assert.ok(
        covered(dir),
        `${app}/Dockerfile build context misses ${dir} — ${name} is a workspace dependency (dev counts: pnpm deploy resolves the whole manifest), so the image build fails without it`,
      );
    }
  }
});

check('web image', () => {
  const instructions = checkDockerfile('apps/web/Dockerfile');
  const cmd = instructions.filter((i) => i.instruction === 'CMD').at(-1);
  assert.ok(cmd, 'web Dockerfile needs CMD');
  assert.match(cmd.args, /apps\/web\/server\.mjs/);
  assert.match(cmd.args, /"node"/, 'web CMD must use exec form with node');
  assert.ok(
    existsSync(path('apps/web/server.mjs')),
    'apps/web/server.mjs missing',
  );
  assert.ok(
    existsSync(path('apps/web/server.test.mjs')),
    'apps/web/server.test.mjs missing',
  );
});

check('bot image', () => {
  const instructions = checkDockerfile('apps/strategy-runner/Dockerfile');
  const cmd = instructions.filter((i) => i.instruction === 'CMD').at(-1);
  assert.ok(cmd, 'bot Dockerfile needs CMD');
  assert.match(
    cmd.args,
    /apps\/strategy-runner\/dist\/main\.js/,
    'bot Dockerfile CMD must run apps/strategy-runner/dist/main.js',
  );
  assert.match(cmd.args, /"node"/, 'bot CMD must use exec form with node');
  assert.ok(
    !instructions.some((i) => i.instruction === 'EXPOSE'),
    'the bot serves nothing and must not EXPOSE a port',
  );
  // The compose volume for BOT_STATE_DIR inherits the image's ownership of the
  // mount point on first use; without this the read-only runtime cannot write
  // a single NDJSON line and the runner dies at its first decision.
  const runs = instructions
    .filter((i) => i.instruction === 'RUN')
    .map((i) => i.args);
  assert.ok(
    runs.some((r) => /chown node:node \/var\/lib\/moi-bot/.test(r)),
    'bot image must own /var/lib/moi-bot as node, or the read-only runtime cannot write its state volume',
  );
});

check('deploy verifies an enabled bot', () => {
  const script = read('infra/oracle/deploy.sh');
  assert.ok(
    /COMPOSE_PROFILES/.test(script) &&
      /bot_steady/.test(script) &&
      /RestartCount/.test(script),
    'deploy.sh must fail the release when COMPOSE_PROFILES enables the bot but the container is not running steadily (RestartCount 0)',
  );
  assert.ok(
    /com\.docker\.compose\.service=bot/.test(script) &&
      /rm -sf bot/.test(script),
    'deploy.sh must fail the release when the bot profile is off but a bot container is still there',
  );
  assert.match(
    read('infra/oracle/deploy-lib.sh'),
    /bot_steady\(\)/,
    'deploy-lib.sh must define bot_steady (tested in status-check.test.mjs)',
  );
  const status = read('infra/oracle/status-check.sh');
  assert.ok(
    /COMPOSE_PROFILES/.test(status) && /bot=\$bot/.test(status),
    'status-check.sh must report the bot when COMPOSE_PROFILES enables it',
  );
});

check('dockerignore', () => {
  const entries = read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const required of [
    '.git',
    '.env',
    '**/*.test.*',
    '.omc',
    '.cursor',
    '.codegraph',
    'node_modules',
  ]) {
    assert.ok(
      entries.some(
        (e) => e === required || e === `${required}/` || e === `**/${required}`,
      ),
      `.dockerignore must exclude ${required}`,
    );
  }
});

let compose;
check('compose topology', () => {
  compose = readYaml('infra/compose.yaml');
  const services = compose.services ?? {};
  for (const name of [
    ...PUBLIC_SERVICES,
    ...PRIVATE_SERVICES,
    ...OPT_IN_SERVICES,
  ]) {
    assert.ok(services[name], `compose must define service ${name}`);
  }
  assert.deepEqual(
    Object.keys(services).sort(),
    [...PUBLIC_SERVICES, ...PRIVATE_SERVICES, ...OPT_IN_SERVICES].sort(),
    'compose must define exactly web, paper-api, postgres, redis, bot',
  );
  for (const name of [...PUBLIC_SERVICES, ...PRIVATE_SERVICES]) {
    assert.equal(
      services[name].profiles,
      undefined,
      `${name} must start by default; only ${OPT_IN_SERVICES.join(', ')} is opt-in`,
    );
  }
  for (const name of PRIVATE_SERVICES) {
    assert.equal(
      services[name].ports,
      undefined,
      `${name} must not publish ports`,
    );
    assert.ok(services[name].healthcheck?.test, `${name} needs a healthcheck`);
    const volumes = services[name].volumes ?? [];
    assert.ok(volumes.length > 0, `${name} needs persistent data volume`);
    for (const volume of volumes) {
      const source =
        typeof volume === 'string' ? volume.split(':')[0] : volume.source;
      assert.ok(
        compose.volumes?.[source],
        `${name} volume ${source} must be a declared named volume`,
      );
    }
  }
  for (const name of PUBLIC_SERVICES) {
    assert.ok(
      (services[name].ports ?? []).length > 0,
      `${name} must publish a port`,
    );
    assert.ok(services[name].healthcheck?.test, `${name} needs a healthcheck`);
  }
  const api = services['paper-api'];
  assert.equal(
    api.deploy?.replicas,
    1,
    'exactly one paper-api replica by default',
  );
  assert.equal(api.labels?.['moi.role'], 'http+market-data-leader');
  const markets = String(api.labels?.['moi.leader-markets'] ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  assert.ok(markets.length > 0, 'paper-api must declare the markets it leads');
  assert.equal(new Set(markets).size, markets.length, 'one leader per market');
  assert.deepEqual(
    [...markets].sort(),
    ['KR', 'US'],
    'leader markets must be the code Market values KR and US',
  );
  for (const [name, service] of Object.entries(services)) {
    if (name === 'paper-api') continue;
    assert.equal(
      service.labels?.['moi.leader-markets'],
      undefined,
      `${name} must not claim leadership`,
    );
  }
  const liveness = api.labels?.['moi.liveness-path'];
  const readiness = api.labels?.['moi.readiness-path'];
  assert.equal(liveness, '/health/live');
  assert.equal(readiness, '/health/ready');
  assert.notEqual(
    liveness,
    readiness,
    'readiness must be distinct from liveness',
  );
  const probe = Array.isArray(api.healthcheck.test)
    ? api.healthcheck.test.join(' ')
    : api.healthcheck.test;
  assert.ok(
    probe.includes(readiness),
    'paper-api healthcheck must gate on readiness',
  );
  assert.deepEqual(api.depends_on?.postgres, { condition: 'service_healthy' });
  assert.deepEqual(api.depends_on?.redis, { condition: 'service_healthy' });
});

check(
  'strategy runner is declared, gated, and cannot be aimed elsewhere',
  () => {
    const bot = compose?.services?.bot;
    assert.ok(bot, 'compose must define the bot service');

    // Opt-in only. The runner is incomplete; a release must not start it.
    assert.deepEqual(
      bot.profiles,
      ['bot'],
      'bot must sit behind exactly the `bot` profile so no default up starts it',
    );
    assert.equal(bot.ports, undefined, 'bot must not publish a port');
    assert.equal(
      bot.restart,
      'unless-stopped',
      'design §7.3: the bot restarts on its own and never takes the stack with it',
    );
    assert.deepEqual(bot.depends_on?.['paper-api'], {
      condition: 'service_healthy',
    });

    // §8.1: append-only state survives a restart, on a declared named volume.
    // Anything bound in from the host is the operator's configuration, and it
    // is read-only: the bot reads its limits, it does not get to rewrite them.
    const mounts = (bot.volumes ?? []).map((volume) => {
      if (typeof volume !== 'string')
        return {
          source: volume.source,
          target: volume.target,
          mode: volume.read_only === true ? 'ro' : '',
        };
      const [source, target, mode = ''] = volume.split(':');
      return { source, target, mode };
    });
    const isBind = (mount) => /^[./]/.test(mount.source ?? '');
    const named = mounts.filter((mount) => !isBind(mount));
    const binds = mounts.filter(isBind);
    assert.ok(named.length > 0, 'bot needs a state volume');
    for (const mount of named)
      assert.ok(
        compose.volumes?.[mount.source],
        `bot volume ${mount.source} must be a declared named volume`,
      );
    for (const mount of binds)
      assert.equal(
        mount.mode,
        'ro',
        `bot bind mount ${mount.source} must be read-only`,
      );

    const env = bot.environment ?? {};

    // §4.1: the connect target. A committed literal, so there is nothing here
    // for an environment to substitute, and the host is the compose service
    // name — reachable only on this project's internal network. Together those
    // are what turn "the bot cannot reach a real exchange" from a hope into a
    // property of the deployment surface. The allow-list it is checked against
    // is a code constant in the runner; this reads that constant so compose and
    // it cannot drift, and the bot cannot be handed a host it will refuse.
    const apiOrigin = String(env.BOT_API_ORIGIN ?? '');
    assert.ok(
      apiOrigin.length > 0 && !apiOrigin.includes('${'),
      'BOT_API_ORIGIN must be a committed literal: an interpolation is a value the environment can move',
    );
    let apiHost;
    try {
      apiHost = new URL(apiOrigin).hostname;
    } catch {
      assert.fail(`BOT_API_ORIGIN is not a URL: ${apiOrigin}`);
    }
    const originModule = 'apps/strategy-runner/src/api-origin.ts';
    if (existsSync(path(originModule))) {
      const block = /ALLOWED_API_HOSTS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
        read(originModule),
      );
      assert.ok(block, `cannot locate ALLOWED_API_HOSTS in ${originModule}`);
      // Comments first: an apostrophe in prose ("the operator's own machine")
      // reads as a quoted entry otherwise, which puts junk in the parsed list
      // and would let a host slip in on a comment's wording.
      const listing = block[1].replace(/\/\/[^\n]*/g, '');
      const allowed = [...listing.matchAll(/'([^']+)'/g)].map(
        ([, host]) => host,
      );
      assert.ok(
        allowed.length > 0,
        `parsed no hosts out of ALLOWED_API_HOSTS in ${originModule}; the parser or the constant changed`,
      );
      assert.ok(
        allowed.includes(apiHost),
        `BOT_API_ORIGIN host ${apiHost} is not on the runner's ALLOWED_API_HOSTS (${allowed.join(', ')}); the bot would refuse to start`,
      );
    }

    // §4.2: the Origin *header*, which is a different value from the connect
    // target — the paper API compares it against its own PUBLIC_ORIGIN, the
    // browser app's origin. Conflating the two is a 403 on every mutation the
    // bot ever makes, so they are asserted apart.
    assert.match(
      String(env.BOT_PUBLIC_ORIGIN ?? ''),
      /^\$\{PUBLIC_ORIGIN:\?/,
      "BOT_PUBLIC_ORIGIN must be the deployment's own PUBLIC_ORIGIN",
    );
    assert.notEqual(
      env.BOT_PUBLIC_ORIGIN,
      env.BOT_API_ORIGIN,
      'the Origin header and the connect target are different values (design §4.2)',
    );

    // The runner has no default risk limits and refuses to start without its
    // configuration, so the path must be set and must resolve inside one of the
    // read-only mounts above.
    const configPath = String(env.BOT_CONFIG_PATH ?? '');
    assert.ok(configPath.length > 0, 'BOT_CONFIG_PATH must be set');
    assert.ok(
      binds.some((mount) => configPath.startsWith(`${mount.target}/`)),
      `BOT_CONFIG_PATH ${configPath} must live inside a read-only bind mount`,
    );
    assert.ok(
      existsSync(path('infra/bot/runner.example.json')),
      'infra/bot/runner.example.json must exist for the operator to copy',
    );
    assert.ok(
      !existsSync(path('infra/bot/runner.json')),
      "infra/bot/runner.json is the operator's file and must not be committed",
    );

    const widening = Object.keys(env).filter((key) =>
      BOT_FORBIDDEN_ENV.test(key),
    );
    assert.deepEqual(
      widening,
      [],
      'the bot receives no ledger credential, no provider credential, and no allow-list override',
    );

    // §7.4: its own channel, and never the operational one notify.sh posts to.
    assert.equal(
      env.DISCORD_WEBHOOK_URL,
      undefined,
      'the operational Discord webhook must never reach the bot (design §7.4)',
    );
    assert.match(
      String(env.DISCORD_WEBHOOK_TRADE_URL ?? ''),
      /^\$\{DISCORD_WEBHOOK_TRADE_URL:-\}$/,
      'DISCORD_WEBHOOK_TRADE_URL must be an optional interpolation, never a literal',
    );

    // The image is the runner's own. Its Dockerfile arrives with the runner; the
    // moment it does it answers to the same rules as web and paper-api.
    const dockerfile = bot.build?.dockerfile;
    assert.equal(
      dockerfile,
      'apps/strategy-runner/Dockerfile',
      'bot must build from the strategy runner Dockerfile',
    );
    if (existsSync(path(dockerfile))) checkDockerfile(dockerfile);
  },
);

check('publish workflow builds every image compose ships', () => {
  const workflow = readYaml('.github/workflows/publish.yml');
  const built = (workflow.jobs.images.strategy.matrix.include ?? []).map(
    (entry) => entry.dockerfile,
  );
  for (const [name, service] of Object.entries(compose.services)) {
    const dockerfile = service.build?.dockerfile;
    if (!dockerfile) continue;
    assert.ok(
      built.includes(dockerfile),
      `publish.yml must build an image for compose service ${name} (${dockerfile})`,
    );
  }
});

check('production overlay pulls every built image from GHCR', () => {
  // `!reset null` is a compose-specific tag; read the overlay as text so the
  // check does not depend on how a generic YAML parser treats it.
  const overlay = read('infra/oracle/compose.override.yaml');
  const workflow = readYaml('.github/workflows/publish.yml');
  const matrix = workflow.jobs.images.strategy.matrix.include ?? [];
  for (const [name, service] of Object.entries(compose.services)) {
    const dockerfile = service.build?.dockerfile;
    if (!dockerfile) continue;
    // The image a service pulls is the one publish.yml builds from its
    // Dockerfile — not merely *some* moi-* image.
    const built = matrix.find((entry) => entry.dockerfile === dockerfile);
    assert.ok(built, `publish.yml must build ${dockerfile} for ${name}`);
    const block = overlay.match(
      new RegExp(`\\n  ${name}:\\n((?:    [^\\n]*\\n)+)`),
    );
    assert.ok(block, `overlay must pull ${name} from GHCR`);
    assert.match(
      block[1],
      new RegExp(
        `^ {4}image: ghcr\\.io/changminko/moi-${built.name}:\\$\\{MOI_IMAGE_TAG:-main\\}$`,
        'm',
      ),
      `overlay must pull ${name} as ghcr.io/changminko/moi-${built.name} under MOI_IMAGE_TAG`,
    );
    assert.match(
      block[1],
      /^ {4}build: !reset null$/m,
      `overlay must reset ${name}'s build so the host never builds`,
    );
  }
});

check('shutdown grace exceeds drain deadline', () => {
  const source = read('apps/paper-api/src/lifecycle/shutdown-coordinator.ts');
  const match = source.match(/deadlineMs \?\? (\d[\d_]*)/);
  assert.ok(
    match,
    'cannot locate default drain deadline in shutdown-coordinator.ts',
  );
  const drainMs = Number(match[1].replaceAll('_', ''));
  const grace = compose?.services?.['paper-api']?.stop_grace_period;
  assert.ok(grace, 'paper-api needs stop_grace_period');
  assert.ok(
    durationToMs(grace) > drainMs,
    `stop_grace_period ${grace} must exceed drain deadline ${drainMs}ms`,
  );
});

check('no committed secrets', () => {
  assert.ok(!existsSync(path('.env')), '.env must not exist in the repository');
  // Host-side alerting scripts and units post to a Discord webhook; the URL
  // must come from the sops file, never from the repository.
  const oracleFiles = readdirSync(path('infra/oracle'))
    .filter((name) => /\.(sh|service|timer)$/.test(name))
    .map((name) => `infra/oracle/${name}`);
  const texts = [
    'infra/compose.yaml',
    'apps/paper-api/Dockerfile',
    'apps/web/Dockerfile',
    '.github/workflows/ci.yml',
    '.github/workflows/notify.yml',
    ...oracleFiles,
  ].map((f) => [f, read(f)]);
  for (const [file, text] of texts) {
    for (const pattern of SECRET_PATTERNS) {
      assert.ok(
        !pattern.test(text),
        `${file} appears to contain a literal secret (${pattern})`,
      );
    }
  }
  const env = compose?.services?.['paper-api']?.environment ?? {};
  for (const key of [
    'DATABASE_URL',
    'CSRF_SECRET',
    'SESSION_HASH_KEYS',
    'ADMIN_API_KEY',
    'TOSS_CLIENT_ID',
    'TOSS_CLIENT_SECRET',
  ]) {
    assert.match(
      String(env[key] ?? ''),
      /^\$\{[A-Z_]+:\?/,
      `${key} must be injected via required interpolation`,
    );
  }
  assert.strictEqual(
    env.MARKET_DATA_ADAPTER,
    'toss',
    'paper-api MARKET_DATA_ADAPTER must be the literal toss (no interpolation, no fake)',
  );
  assert.match(
    String(env.FEE_SCHEDULE_VERSION ?? ''),
    /^[1-9]\d*$/,
    'FEE_SCHEDULE_VERSION must be a committed positive integer literal',
  );
  for (const key of [
    'FEE_KR_COMMISSION_RATE',
    'FEE_KR_SELL_TAX_RATE',
    'FEE_US_COMMISSION_RATE',
    'FEE_US_SELL_TAX_RATE',
  ])
    assert.match(
      String(env[key] ?? ''),
      /^(0|0\.\d{1,10})$/,
      `${key} must be a committed decimal rate literal in [0, 1)`,
    );
  assert.match(
    String(compose?.services?.postgres?.environment?.POSTGRES_PASSWORD ?? ''),
    /^\$\{[A-Z_]+:\?/,
    'POSTGRES_PASSWORD must be injected via required interpolation',
  );
  const webEnv = compose?.services?.web?.environment ?? {};
  const forbidden = Object.keys(webEnv).filter((k) =>
    /TOSS|DATABASE|REDIS|SECRET|ADMIN|KEY/.test(k),
  );
  assert.deepEqual(
    forbidden,
    [],
    'web service must receive no backend secrets or endpoints',
  );
});

/**
 * The external tools `notify.sh` depends on, read from the script.
 *
 * A dependency is counted wherever the script **probes** for a command —
 * `command -v`, `type -p`, `type`, `which`, `hash` — whatever the probe is
 * wired to: `|| soft_fail`, `|| { soft_fail …; }`, `if ! …; then`. Counting
 * the probe rather than the `soft_fail` is what keeps the list honest when the
 * next person writes the guard in another idiom (#86). Two things fail the
 * build instead of being skipped: a probe whose target this checker cannot
 * name (a variable, a quoted word), and a `soft_fail "<tool> missing…"`
 * message with no probe for that tool on the same line or the lines just
 * above it — a guard in a shape the parser does not read, which must not
 * drop the tool out of the list silently.
 */
function notifyDependencyGuards(script) {
  // A probe is recognised only in command position — the start of the line
  // or right after `;`, `{`, `(`, `&&`, `||`, `do`, `then`, with an optional
  // `if`/`!` — so
  // the words `type`, `which`, `hash` inside a message or a trailing comment
  // are not read as one.
  const probe =
    /(?:^|[;{(]|&&|\|\||\bdo|\bthen)\s*(?:if\s+)?!?\s*(?:command -v|type -p|type|which|hash)\s+(\S+)/g;
  const missing = /soft_fail\s+"(\S+) missing\b/;
  const lines = script.split('\n');
  const tools = new Set();
  const probedAt = [];
  lines.forEach((line, index) => {
    const at = `infra/oracle/notify.sh:${index + 1}`;
    if (/^\s*#/.test(line)) return;
    const here = [];
    for (const [, raw] of line.matchAll(probe)) {
      const tool = raw.replace(/^["']|["']$/g, '');
      assert.ok(
        /^[A-Za-z0-9_.+-]+$/.test(tool.split('/').pop()) && !tool.includes('$'),
        `unrecognised dependency guard in ${at}: cannot name the tool "${raw}" probes; guard each tool by its literal name`,
      );
      here.push(tool.split('/').pop());
    }
    for (const tool of here) {
      tools.add(tool);
      probedAt.push({ tool, index });
    }
    const named = missing.exec(line)?.[1];
    if (named === undefined) return;
    const nearby = probedAt.some(
      (each) => each.tool === named && index - each.index <= 2,
    );
    assert.ok(
      nearby,
      `unrecognised dependency guard in ${at}: "${line.trim()}" names ${named} as missing but no probe for it (command -v | type -p | type | which | hash) is on this line or the two above`,
    );
  });
  return [...tools];
}

/**
 * Everything `notify.sh` needs must actually be on the host.
 *
 * The alerting path is fail-closed by design: a missing dependency means no
 * message rather than a wrong one. That is the right trade, and it is also why
 * this check exists — a host that has quietly stopped alerting looks exactly
 * like a host with nothing to report. `perl` is the live example: it masks
 * every outbound field, and it arrived in the alerting path long after
 * bootstrap.sh's package list was written.
 *
 * Rather than pin today's list, this reads the guards out of `notify.sh` and
 * requires each one to be provisioned by `bootstrap.sh` (a fresh host) or by
 * `deploy.sh` (a host bootstrapped before the tool joined the list). Adding a
 * dependency to the alerting path without provisioning it fails the build.
 */
check('host alerting dependencies are provisioned', () => {
  const guards = notifyDependencyGuards(read('infra/oracle/notify.sh'));
  assert.ok(
    guards.length > 0,
    'cannot locate notify.sh dependency guards; the parser or the script changed',
  );

  const words = (text, pattern) =>
    [...text.matchAll(pattern)].flatMap(([, list]) => list.trim().split(/\s+/));
  const provisioned = new Set([
    ...words(
      read('infra/oracle/bootstrap.sh'),
      /apt-get install -y -qq ([^\n]*)/g,
    ),
    ...words(read('infra/oracle/deploy.sh'), /for tool in ([^;\n]*);/g),
  ]);

  for (const tool of guards)
    assert.ok(
      provisioned.has(tool),
      `notify.sh requires ${tool}, but neither bootstrap.sh nor deploy.sh installs it; alerting would fail closed and the host would look quiet`,
    );
});

check('provider egress allow list', () => {
  const doc = readYaml('infra/provider-allowlist.yaml');
  assert.strictEqual(
    doc?.provider,
    'toss',
    'allow list must name the toss provider',
  );
  assert.ok(
    Array.isArray(doc?.registered_egress_ips),
    'registered_egress_ips must be a list',
  );
  for (const [index, entry] of doc.registered_egress_ips.entries()) {
    const where = `provider-allowlist entry ${index}`;
    assert.match(
      String(entry?.address ?? ''),
      /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i,
      `${where}: address must be an IP address`,
    );
    for (const field of ['environment', 'registered_at', 'registered_by'])
      assert.ok(
        typeof entry?.[field] === 'string' && entry[field].length > 0,
        `${where}: ${field} is required`,
      );
    assert.ok(
      !Number.isNaN(Date.parse(String(entry.registered_at))),
      `${where}: registered_at must be an ISO date`,
    );
  }
  const text = read('infra/provider-allowlist.yaml');
  for (const pattern of SECRET_PATTERNS)
    assert.ok(
      !pattern.test(text),
      `allow list must hold addresses only (${pattern})`,
    );
});

check('secret-manager template holds references only', () => {
  const lines = read('infra/secrets.env.tpl')
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('#'));
  assert.ok(
    lines.length > 0,
    'secrets.env.tpl must declare the compose variables',
  );
  const declared = new Set();
  for (const line of lines) {
    const match = /^([A-Z_]+)=(op:\/\/[^\s]+)$/.exec(line);
    assert.ok(
      match,
      `secrets.env.tpl line must be VAR=op://vault/item/field: ${line.split('=')[0]}`,
    );
    declared.add(match[1]);
  }
  for (const key of [
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
    'SESSION_HASH_KEYS',
    'CSRF_SECRET',
    'ADMIN_API_KEY',
    'TOSS_CLIENT_ID',
    'TOSS_CLIENT_SECRET',
    // The runner's own Discord channel (design §7.4). Optional at run time,
    // but the operator must be told it exists and that it is not the
    // operational DISCORD_WEBHOOK_URL.
    'DISCORD_WEBHOOK_TRADE_URL',
  ])
    assert.ok(declared.has(key), `secrets.env.tpl must reference ${key}`);
  assert.ok(
    !declared.has('MARKET_DATA_ADAPTER'),
    'MARKET_DATA_ADAPTER is a compose literal, not a secret',
  );
});

check('no live provider hosts in tests', () => {
  const roots = ['apps', 'packages', 'scripts'];
  const allowed = new Set([
    'packages/market-data/contracts/toss/openapi.json',
    'packages/market-data/contracts/toss/asyncapi.json',
    'packages/market-data/contracts/toss/provenance.json',
    'packages/market-data/src/toss/contract-servers.ts',
    'packages/market-data/src/toss/contract-servers.test.ts',
    'apps/paper-api/src/config.ts',
    'apps/paper-api/src/config.test.ts',
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name.startsWith('.')
      )
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js|json|yaml|yml)$/.test(entry.name)) {
        const rel = relative(root, full);
        if (allowed.has(rel)) continue;
        if (/tossinvest\.com/.test(readFileSync(full, 'utf8')))
          offenders.push(rel);
      }
    }
  };
  for (const r of roots) if (existsSync(path(r))) walk(path(r));
  assert.deepEqual(
    offenders,
    [],
    'live provider hosts may appear only in the pinned contracts and server constants',
  );
});

check('prometheus alerts', () => {
  const rules = readYaml('infra/monitoring/prometheus-alerts.yaml');
  const alerts = (rules.groups ?? [])
    .flatMap((g) => g.rules ?? [])
    .filter((r) => r.alert);
  const byName = new Map(alerts.map((r) => [r.alert, r]));
  const immediate = [
    'InvariantViolation',
    'TransactionalAuditFailure',
    'EmergencyLatchActive',
  ];
  for (const name of immediate) {
    const rule = byName.get(name);
    assert.ok(rule, `missing immediate alert ${name}`);
    assert.ok(
      !rule.for || rule.for === '0s' || rule.for === '0m',
      `${name} must fire immediately`,
    );
  }
  for (const name of [
    'MarketDataDegradedSustained',
    'MarketDataRecoveringSustained',
    'RecoveryDurationExceeded',
    'FeedReconnectFlapping',
    'TransactionErrors',
    'DbLockWaitHigh',
    'OutboxLagHigh',
    'ProviderConnectionsAboveLimit',
    'LeaderLeaseWaitLong',
    'ProviderAuthFailed',
    'ShutdownForced',
    'LeaderReelection',
    'LeaderBundleSplit',
    'HttpAdmissionRejectedOutsideDrain',
    'OutboxClaimsOutsideServing',
    'OutboxShutdownDrainOutsideDraining',
    'StreamReplayOverflow',
  ]) {
    assert.ok(byName.get(name), `missing alert ${name}`);
  }
  assert.match(
    byName.get('RecoveryDurationExceeded').expr,
    /60/,
    'recovery alert threshold must be 60 seconds',
  );
  for (const rule of alerts) {
    for (const label of Object.keys(rule.labels ?? {})) {
      assert.ok(
        BOUNDED_ALERT_LABELS.has(label),
        `${rule.alert} uses unbounded label ${label}`,
      );
    }
    const runbook = rule.annotations?.runbook;
    assert.ok(runbook, `${rule.alert} must link a runbook`);
    assert.ok(
      RUNBOOKS.includes(runbook),
      `${rule.alert} runbook ${runbook} is not a committed runbook`,
    );
  }
  const alertmanager = readYaml('infra/monitoring/alertmanager.yaml');
  assert.deepEqual(
    [...(alertmanager.route?.group_by ?? [])].sort(),
    ['alertname', 'incident', 'market', 'recovery_epoch'],
    'notification dedup must key on alert name, market, incident, and recovery epoch',
  );
  assert.ok(
    alertmanager.route?.repeat_interval,
    'alertmanager route needs a cooldown (repeat_interval)',
  );
});

check('runbooks', () => {
  for (const runbook of RUNBOOKS) {
    const text = read(runbook);
    for (const section of RUNBOOK_SECTIONS) {
      assert.ok(
        new RegExp(`^##+ .*${section}`, 'im').test(text),
        `${runbook} missing section "${section}"`,
      );
    }
    for (const needle of [
      'reservation',
      'leader fence',
      'outbox lag',
      'user-stream',
    ]) {
      assert.ok(
        text.toLowerCase().includes(needle),
        `${runbook} must cover ${needle} verification`,
      );
    }
  }
});

check('deployment guide', () => {
  const text = read('docs/operations/deployment.md');
  const required = [
    /migrat(e|ions?) .*before .*traffic/i,
    /one (leader|`paper-api`) replica|exactly one `paper-api`/i,
    /readiness gate/i,
    /CANCEL_ONLY/,
    /old leader disconnect/i,
    /new leader recover/i,
    /NORMAL/,
    /rollback/i,
    /secret injection/i,
    /preflight:deploy/,
    /egress allow list/i,
    /provider-allowlist\.yaml/,
    /TLS/,
    /Secure/,
    /SameSite=Lax/,
    /14[- ]day/i,
    /backup/i,
    /restore/i,
    /third Toss connection/i,
    /\/health\/live/,
    /\/health\/ready/,
  ];
  for (const pattern of required) {
    assert.ok(pattern.test(text), `deployment.md must cover ${pattern}`);
  }
});

check('ci workflow', () => {
  const workflow = readYaml('.github/workflows/ci.yml');
  assert.deepEqual(
    workflow.permissions,
    { contents: 'read' },
    'workflow must grant only contents: read',
  );
  const jobs = Object.values(workflow.jobs ?? {});
  assert.ok(jobs.length > 0, 'workflow needs a job');
  for (const job of jobs) {
    assert.equal(job.permissions, undefined, 'jobs must not widen permissions');
  }
  const steps = jobs.flatMap((j) => j.steps ?? []);
  const setupNode = steps.find((s) =>
    String(s.uses ?? '').startsWith('actions/setup-node@'),
  );
  assert.ok(setupNode, 'workflow must use actions/setup-node');
  assert.equal(String(setupNode.with?.['node-version']), NODE_VERSION);
  assert.equal(
    setupNode.with?.cache,
    'pnpm',
    'setup-node must cache the pnpm store',
  );
  const setupPnpm = steps.find((s) =>
    String(s.uses ?? '').startsWith('pnpm/action-setup@'),
  );
  assert.ok(setupPnpm, 'workflow must use pnpm/action-setup');
  assert.equal(String(setupPnpm.with?.version), PNPM_VERSION);
  const runs = steps.map((s) => s.run ?? '').join('\n');
  for (const command of [
    'pnpm install --frozen-lockfile',
    'pnpm check',
    'pnpm typecheck',
    // Container-bound integration suites run one workspace at a time on the
    // four-core runner; parallel containers dropped PostgreSQL connections.
    'pnpm turbo run test --concurrency=1',
    'pnpm check:deployment',
    'pnpm build',
    'pnpm --filter @moi/e2e exec playwright install --with-deps chromium',
    'pnpm --filter @moi/e2e test:e2e',
  ]) {
    assert.ok(
      runs.split('\n').some((l) => l.trim() === command),
      `workflow must run "${command}"`,
    );
  }
  const upload = steps.find((s) =>
    String(s.uses ?? '').startsWith('actions/upload-artifact@'),
  );
  assert.ok(upload, 'workflow must upload the Playwright report');
  assert.equal(
    upload.if,
    'failure()',
    'Playwright report uploads only on failure',
  );
  const envText = read('.github/workflows/ci.yml');
  assert.ok(!/TOSS_/.test(envText), 'CI must not reference Toss credentials');
});

if (failures.length > 0) {
  console.error('Deployment contract violations:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Deployment contract holds.');
