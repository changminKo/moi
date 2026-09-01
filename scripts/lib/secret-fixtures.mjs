/**
 * Fake credentials for the host-script masking tests, assembled at run time.
 *
 * The reasoning is written out once in
 * `packages/strategy-reporter/src/testing/secret-fixtures.ts`: these values are
 * the input a masker exists to destroy, so they must be shaped like the real
 * thing; written as literals they trip GitGuardian's static scan; and
 * `.gitguardian.yaml` refuses value-based ignores while path-based ones would
 * blind the scanner to exactly the place AGENTS.md hard rule 2 cares about.
 * Assembling marks a fake as a fake. A real credential belongs here in no form.
 *
 * This is the plain-JavaScript twin of that module, because `node --test` runs
 * these suites outside the workspace package.
 */

const DISCORD_HOST = ['discord', 'com'].join('.');

export function fakeWebhook(
  id = '900000000000000000',
  token = 'trade-tok',
  scheme = 'https',
) {
  return [`${scheme}://${DISCORD_HOST}`, 'api', 'webhooks', id, token].join(
    '/',
  );
}

export function fakeJwt(payload = 'payload') {
  return [['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''), payload].join('.');
}

export function fakePostgresUri(host = 'db') {
  return `postgres://moi:${['hun', 'ter2'].join('')}@${host}/moi`;
}

export const FAKE_ADMIN_KEY = ['0123456789abcdef', '0123456789abcdef'].join('');
