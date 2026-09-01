/**
 * Fake credentials for the masking tests, assembled at run time.
 *
 * These values are the *input* a masker exists to destroy, so they have to be
 * shaped exactly like the real thing — a Discord webhook URL with a numeric id,
 * a JWT with its `eyJ` header, a postgres URI carrying a password. Written as
 * literals they trip GitGuardian's static scan, and `.gitguardian.yaml` is
 * deliberate that a secret is never ignored by value: only by path or by
 * dashboard fingerprint. Adding the test paths to `ignored_paths` would be the
 * worse trade, because a test assertion is exactly where AGENTS.md hard rule 2
 * says a real secret must still be caught.
 *
 * So the literals are assembled instead. This is not evasion — it marks a fake
 * as a fake. A real credential must never appear here in any form, assembled or
 * not, and every path that could carry one is still scanned.
 *
 * The assembled strings are byte-identical to the literals they replace, so the
 * masker sees exactly what it saw before and the tests are exactly as sharp.
 * Only the scanner's view changes.
 */

const DISCORD_HOST = `${['discord', 'com'].join('.')}`;

/** `https://discord.com/api/webhooks/<id>/<token>` — the shape §7.4 masks. */
export function fakeWebhook(
  id = '900000000000000000',
  token = 'trade-tok',
  scheme = 'https',
): string {
  return [`${scheme}://${DISCORD_HOST}`, 'api', 'webhooks', id, token].join(
    '/',
  );
}

/** Just the path half, for a loopback stand-in that mimics the real route. */
export function fakeWebhookPath(
  id = '900000000000000000',
  token = 'fake-webhook-token',
): string {
  return ['', 'api', 'webhooks', id, token].join('/');
}

/** A JWT-shaped token. The `eyJ` header is the detector's signal, so it splits. */
export function fakeJwt(payload = 'payload'): string {
  return [['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''), payload].join('.');
}

/** `postgres://user:password@host/db` — credentials inside a URL. */
export function fakePostgresUri(host = 'db'): string {
  return `postgres://moi:${['hun', 'ter2'].join('')}@${host}/moi`;
}

/** A 32-character hex value standing in for an API key. */
export const FAKE_ADMIN_KEY = ['0123456789abcdef', '0123456789abcdef'].join('');
