#!/usr/bin/env node
/**
 * Deployment preflight.
 *
 * Runs on the operator's machine (or the deploy job) with the production
 * environment resolved by the secret manager, immediately before
 * `docker compose up`. It answers three questions the contract checker cannot,
 * because they depend on the live environment rather than on committed files:
 *
 *   1. Is every required secret present and well-formed? Values are never
 *      printed — only the variable name and the rule it failed.
 *   2. Does `docker compose config` accept the environment (every `${VAR:?}`
 *      interpolation satisfied)?
 *   3. Is this process's egress address registered with the provider
 *      (`infra/provider-allowlist.yaml`)? A `403 access_denied` after deploy
 *      is otherwise the first time anyone finds out.
 *
 * Exit 0 only when all three hold. `--skip-compose` and `--skip-egress` exist
 * for hosts without Docker or network; they print what was skipped.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The `.env.example` placeholders and the usual stand-ins. */
const PLACEHOLDER = /replace-with|change-?me|^xxx+$|^(secret|password)$/i;
const MIN_SECRET_BYTES = 32;
const MIN_TOSS_SECRET_BYTES = 16;
const MIN_POSTGRES_PASSWORD_BYTES = 16;

const RULES = [
  ['PUBLIC_ORIGIN', httpsOrigin],
  ['PUBLIC_API_ORIGIN', httpsOrigin],
  ['DATABASE_URL', postgresUrl],
  ['POSTGRES_PASSWORD', minLength(MIN_POSTGRES_PASSWORD_BYTES)],
  ['SESSION_HASH_KEYS', hashKeys],
  ['CSRF_SECRET', minLength(MIN_SECRET_BYTES)],
  ['ADMIN_API_KEY', minLength(MIN_SECRET_BYTES)],
  ['TOSS_CLIENT_ID', tossClientId],
  ['TOSS_CLIENT_SECRET', minLength(MIN_TOSS_SECRET_BYTES)],
];

/**
 * Optional variables: absent is fine, malformed is not. The strategy runner's
 * Discord channel is the only one so far — the reporter is a silent no-op
 * without it (like `infra/oracle/notify.sh`), but a webhook that is wrong, or
 * that is the operational channel wearing the trade name, must be caught here
 * rather than discovered as trading noise on top of an incident alert.
 */
const OPTIONAL_RULES = [['DISCORD_WEBHOOK_TRADE_URL', tradeWebhook]];

/** Variables that must NOT be set: the compose file owns them as literals. */
const FORBIDDEN = {
  MARKET_DATA_ADAPTER:
    'is a committed compose literal (toss); do not override it from the environment',
  TOSS_REST_BASE_URL: 'must not be overridden in production',
  TOSS_WS_URL: 'must not be overridden in production',
  FEE_SCHEDULE_VERSION:
    'is a committed compose literal; bump it in infra/compose.yaml',
  FEE_KR_COMMISSION_RATE: 'is a committed compose literal',
  FEE_KR_SELL_TAX_RATE: 'is a committed compose literal',
  FEE_US_COMMISSION_RATE: 'is a committed compose literal',
  FEE_US_SELL_TAX_RATE: 'is a committed compose literal',
  // Strategy-runner design §4.1/§4.2. The bot's connect target is a committed
  // literal in infra/compose.yaml (the internal `paper-api` service, which is
  // what its ALLOWED_API_HOSTS constant permits), and its Origin header is
  // derived from PUBLIC_ORIGIN. An environment override of either is precisely
  // how the bot would end up pointed at, or vouching for, a host that is not
  // this deployment — so the deploy refuses one rather than honouring it.
  BOT_API_ORIGIN:
    'is a committed compose literal (the internal paper-api service); the bot may not be aimed elsewhere from the environment',
  BOT_PUBLIC_ORIGIN:
    'is derived from PUBLIC_ORIGIN in infra/compose.yaml; the Origin header may not be set from the environment',
};

const DISCORD_WEBHOOK =
  /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

/**
 * Validated against the whole environment, because the rule that matters is a
 * relation: the runner's channel must not be the operational one. Never
 * returns the value — a problem line is printed.
 */
function tradeWebhook(value, env) {
  if (!DISCORD_WEBHOOK.test(value))
    return 'must be an https Discord webhook URL';
  if (value === env.DISCORD_WEBHOOK_URL?.trim())
    return 'must be a different channel from DISCORD_WEBHOOK_URL, or trading traffic buries incident alerts';
  return undefined;
}

function httpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:') return 'must use https';
  if (url.pathname !== '/' || url.search || url.hash)
    return 'must be a bare origin (no path, query, or fragment)';
  return undefined;
}

function postgresUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'must be a postgres:// URL';
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    return 'must be a postgres:// URL';
  if (!url.username || !url.password) return 'must carry a role and password';
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    return 'must not point at localhost from the container';
  return undefined;
}

function minLength(bytes) {
  return (value) =>
    value.length < bytes ? `must be at least ${bytes} characters` : undefined;
}

function hashKeys(value) {
  const keys = value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (keys.length === 0) return 'must contain at least one key';
  if (keys.some((key) => key.length < MIN_TOSS_SECRET_BYTES))
    return `every key must be at least ${MIN_TOSS_SECRET_BYTES} characters`;
  return undefined;
}

function tossClientId(value) {
  // Mirrors CLIENT_ID_PATTERN in apps/paper-api/src/config.ts.
  return /^[A-Za-z0-9_-]{8,}$/.test(value)
    ? undefined
    : 'must be at least 8 letters, digits, _ or -';
}

/**
 * Validates the environment without ever echoing a value. Returns the list
 * of `{ variable, problem }` failures; an empty list means every rule passed.
 */
export function validateEnvironment(env) {
  const failures = [];
  for (const [variable, rule] of RULES) {
    const value = env[variable];
    if (value === undefined || value.trim().length === 0) {
      failures.push({ variable, problem: 'is required' });
      continue;
    }
    if (PLACEHOLDER.test(value)) {
      failures.push({ variable, problem: 'still holds a placeholder value' });
      continue;
    }
    const problem = rule(value);
    if (problem !== undefined) failures.push({ variable, problem });
  }
  for (const [variable, rule] of OPTIONAL_RULES) {
    const value = env[variable]?.trim();
    if (value === undefined || value.length === 0) continue;
    if (PLACEHOLDER.test(value)) {
      failures.push({ variable, problem: 'still holds a placeholder value' });
      continue;
    }
    const problem = rule(value, env);
    if (problem !== undefined) failures.push({ variable, problem });
  }
  for (const [variable, problem] of Object.entries(FORBIDDEN)) {
    if (env[variable] !== undefined) failures.push({ variable, problem });
  }
  // The TLS edge (WEB_DOMAIN / API_DOMAIN) and the application origins must
  // name the same hosts, or CORS, cookies and WebSocket Origin checks fail
  // while readiness still looks healthy.
  for (const [domainVar, originVar] of [
    ['WEB_DOMAIN', 'PUBLIC_ORIGIN'],
    ['API_DOMAIN', 'PUBLIC_API_ORIGIN'],
  ]) {
    const domain = env[domainVar];
    const origin = env[originVar];
    if (
      domain !== undefined &&
      origin !== undefined &&
      origin !== `https://${domain}`
    )
      failures.push({
        variable: originVar,
        problem: `must be https://${domain} to match ${domainVar}`,
      });
  }
  return failures;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export function isIpAddress(value) {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value));
}

/** Parses and validates `infra/provider-allowlist.yaml`. Throws on a malformed file. */
export function parseAllowlist(text) {
  const doc = parseYaml(text);
  if (doc?.provider !== 'toss')
    throw new Error('provider-allowlist.yaml: provider must be "toss"');
  const entries = doc.registered_egress_ips;
  if (!Array.isArray(entries))
    throw new Error(
      'provider-allowlist.yaml: registered_egress_ips must be a list',
    );
  return entries.map((entry, index) => {
    const where = `provider-allowlist.yaml: entry ${index}`;
    if (typeof entry?.address !== 'string' || !isIpAddress(entry.address))
      throw new Error(`${where}: address must be an IPv4 or IPv6 address`);
    if (typeof entry.environment !== 'string' || entry.environment.length === 0)
      throw new Error(`${where}: environment is required`);
    if (
      typeof entry.registered_at !== 'string' ||
      Number.isNaN(Date.parse(entry.registered_at))
    )
      throw new Error(`${where}: registered_at must be an ISO date`);
    if (
      typeof entry.registered_by !== 'string' ||
      entry.registered_by.length === 0
    )
      throw new Error(`${where}: registered_by is required`);
    return {
      address: entry.address,
      environment: entry.environment,
      registeredAt: entry.registered_at,
      registeredBy: entry.registered_by,
    };
  });
}

/** Undefined when `address` is registered for `environment`; otherwise the reason. */
export function checkEgress(address, allowlist, environment = 'production') {
  if (!isIpAddress(address))
    return `egress address "${address}" is not an IP address`;
  const registered = allowlist.filter((e) => e.environment === environment);
  if (registered.length === 0)
    return `no egress address is registered for ${environment}; register the static egress IP with the provider and record it in infra/provider-allowlist.yaml`;
  if (!registered.some((e) => e.address === address))
    return `egress address ${address} is not registered for ${environment} (registered: ${registered.map((e) => e.address).join(', ')})`;
  return undefined;
}

async function currentEgressAddress(fetchImpl = fetch) {
  const response = await fetchImpl('https://api.ipify.org?format=text', {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`egress lookup failed: HTTP ${response.status}`);
  return (await response.text()).trim();
}

function composeConfig(env) {
  const result = spawnSync(
    'docker',
    ['compose', '-f', join(root, 'infra/compose.yaml'), 'config', '--quiet'],
    { env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  if (result.error)
    return `docker compose is not runnable: ${result.error.message}`;
  if (result.status !== 0) {
    // Compose reports the unsatisfied interpolation by variable name, never
    // by value, so its stderr is safe to surface.
    return `docker compose config failed:\n${result.stderr.trim()}`;
  }
  return undefined;
}

export async function preflight({ env, args, allowlistText, fetchImpl, log }) {
  const skipCompose = args.includes('--skip-compose');
  const skipEgress = args.includes('--skip-egress');
  const environment =
    args[args.indexOf('--environment') + 1] && args.includes('--environment')
      ? args[args.indexOf('--environment') + 1]
      : 'production';
  const explicitIp = args.includes('--egress-ip')
    ? args[args.indexOf('--egress-ip') + 1]
    : env.EGRESS_IP;
  let failed = false;
  const fail = (message) => {
    failed = true;
    log(`FAIL ${message}`);
  };

  const failures = validateEnvironment(env);
  if (failures.length === 0)
    log('ok   environment: every required variable present and well-formed');
  for (const { variable, problem } of failures)
    fail(`environment: ${variable} ${problem}`);

  if (skipCompose) log('skip docker compose config (--skip-compose)');
  else {
    const problem = composeConfig(env);
    if (problem === undefined)
      log('ok   docker compose config accepts the environment');
    else fail(problem);
  }

  if (
    environment === 'production' &&
    (skipEgress || args.includes('--egress-ip') || env.EGRESS_IP !== undefined)
  ) {
    fail(
      'production preflight must observe the real egress address: --skip-egress, --egress-ip and EGRESS_IP are refused',
    );
  } else if (skipEgress) log('skip egress allow list (--skip-egress)');
  else {
    try {
      const allowlist = parseAllowlist(allowlistText);
      const address = explicitIp ?? (await currentEgressAddress(fetchImpl));
      const problem = checkEgress(address, allowlist, environment);
      if (problem === undefined)
        log(
          `ok   egress ${address} is registered with the provider for ${environment}`,
        );
      else fail(problem);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const code = await preflight({
    env: process.env,
    args: process.argv.slice(2),
    allowlistText: readFileSync(
      join(root, 'infra/provider-allowlist.yaml'),
      'utf8',
    ),
    log: (line) => console.log(line),
  });
  process.exit(code);
}
