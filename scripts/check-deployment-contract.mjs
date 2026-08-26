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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  for (const name of [...PUBLIC_SERVICES, ...PRIVATE_SERVICES]) {
    assert.ok(services[name], `compose must define service ${name}`);
  }
  assert.deepEqual(
    Object.keys(services).sort(),
    [...PUBLIC_SERVICES, ...PRIVATE_SERVICES].sort(),
    'compose must define exactly web, paper-api, postgres, redis',
  );
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
  assert.equal(api.labels?.['skipjack.role'], 'http+market-data-leader');
  const markets = String(api.labels?.['skipjack.leader-markets'] ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  assert.ok(markets.length > 0, 'paper-api must declare the markets it leads');
  assert.equal(new Set(markets).size, markets.length, 'one leader per market');
  for (const [name, service] of Object.entries(services)) {
    if (name === 'paper-api') continue;
    assert.equal(
      service.labels?.['skipjack.leader-markets'],
      undefined,
      `${name} must not claim leadership`,
    );
  }
  const liveness = api.labels?.['skipjack.liveness-path'];
  const readiness = api.labels?.['skipjack.readiness-path'];
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
  const texts = [
    'infra/compose.yaml',
    'apps/paper-api/Dockerfile',
    'apps/web/Dockerfile',
    '.github/workflows/ci.yml',
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
  ]) {
    assert.match(
      String(env[key] ?? ''),
      /^\$\{[A-Z_]+:\?/,
      `${key} must be injected via required interpolation`,
    );
  }
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
    'pnpm test',
    'pnpm check:deployment',
    'pnpm build',
    'pnpm --filter @skipjack/e2e exec playwright install --with-deps chromium',
    'pnpm --filter @skipjack/e2e test:e2e',
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
