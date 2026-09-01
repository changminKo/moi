/**
 * Outbound masking for everything the runner reports (strategy-runner design
 * §7.4, AGENTS.md hard rule 2: secrets never enter logs or chat).
 *
 * Two layers, both applied by `maskOutbound`, which the reporter calls in one
 * place — when it renders the payload — so no call site can forget one:
 *
 *   1. Pattern masking, for secrets whose value the runner does not hold.
 *      These are the rules `infra/oracle/notify.sh` applies on the host, plus
 *      the session, CSRF, Set-Cookie and idempotency-key patterns §7.4 adds to
 *      both the host script and the runner.
 *   2. Exact-value masking, for the secrets the runner does hold: the trade
 *      webhook URL, the session cookie, the CSRF token, ADMIN_API_KEY. A
 *      session cookie rotates, so these arrive through a provider read at send
 *      time rather than being captured once at construction.
 *
 * Exact values are substituted before the patterns run: a pattern replacement
 * cannot then hide a held secret from the exact pass.
 *
 * `containsSecret` is the tripwire. The reporter runs it over the finished
 * JSON body, and a held secret that survived both layers means the payload is
 * dropped instead of posted. Delivery fails open; a secret does not.
 */

export const SECRET_MASK = '***';

/**
 * Exact-value masking below this length is refused. A two-character "secret"
 * would shred ordinary text — `KR` appears in every Korean symbol — and a
 * value that short is not a credential.
 */
export const MIN_EXACT_SECRET_LENGTH = 8;

interface MaskingRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

export const MASKING_RULES: readonly MaskingRule[] = [
  // Discord webhook URLs, including the ptb/canary hosts.
  {
    pattern:
      /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi,
    replacement: '<webhook>',
  },
  // Credentials embedded in a URL: postgres://role:password@host/db.
  {
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/:@\s]+:)[^@\s]+@/g,
    replacement: `$1${SECRET_MASK}@`,
  },
  { pattern: /\bBearer\s+\S+/gi, replacement: `Bearer ${SECRET_MASK}` },
  // §7.4: the paper-api session cookie, by name, wherever it appears. The
  // `\s*` lets the value sit on the line after the marker, which is where a
  // wrapped log line puts it; `infra/oracle/notify.sh` crosses the newline for
  // the same reason. Over-masking is the safe direction.
  {
    pattern: /\bmoi_session=\s*[^;\s,"']*/gi,
    replacement: `moi_session=${SECRET_MASK}`,
  },
  // §7.4: hyphenated headers the assignment rule below cannot reach.
  {
    pattern:
      /\b(set-cookie|x-csrf-token|csrf-token|idempotency-key)\s*[:=]\s*[^\s,;"']+/gi,
    replacement: `$1: ${SECRET_MASK}`,
  },
  // KEY/TOKEN/SECRET/PASSWORD/WEBHOOK/COOKIE-style assignments.
  {
    pattern:
      /([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|COOKIE)[A-Za-z0-9_]*\s*[=:]\s*)[^\s,;"']+/gi,
    replacement: `$1${SECRET_MASK}`,
  },
];

function maskable(secrets: readonly string[]): readonly string[] {
  return secrets.filter((secret) => secret.length >= MIN_EXACT_SECRET_LENGTH);
}

/** Applies exact-value masking, then every pattern rule, to `text`. */
export function maskOutbound(
  text: string,
  secrets: readonly string[] = [],
): string {
  let masked = text;
  for (const secret of maskable(secrets))
    masked = masked.split(secret).join(SECRET_MASK);
  for (const { pattern, replacement } of MASKING_RULES)
    masked = masked.replace(
      new RegExp(pattern.source, pattern.flags),
      replacement,
    );
  return masked;
}

/** True while a held secret is still literally present in `text`. */
export function containsSecret(
  text: string,
  secrets: readonly string[],
): boolean {
  return maskable(secrets).some((secret) => text.includes(secret));
}
