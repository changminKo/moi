/**
 * The judgements the production browser smoke makes, kept out of the spec so
 * they can be tested without a live origin.
 *
 * The smoke itself can only run against a deployed host, which no CI job may
 * touch, so everything it decides lives here and is exercised by
 * `smoke-contract.test.ts`. What is left in the spec is the driving.
 */

export type ConsoleErrorRecord = Readonly<{
  text: string;
  /** Where Chromium says the message came from; a resource error carries the URL here. */
  location?: string;
}>;

export type ObservedResponse = Readonly<{ url: string; status: number }>;

/**
 * A missing favicon is the one console error a healthy page may produce: it is
 * cosmetic and browsers request it unprompted. Chromium reports it as a
 * generic "failed to load resource" whose location is the icon URL, so the
 * text alone never identifies it — both halves are read.
 */
// Anchored on the path segment: `/favicon.ico` is the icon, `/favicon/app.js`
// is a script under a directory that merely shares the name.
const FAVICON_URL = /\/favicon[^/]*$/iu;
// Read from the message only. Folding the URL in would let any error whose
// location happens to contain "404" excuse itself.
const LOAD_FAILURE = /404|not found|failed to load resource/iu;

export function isIgnorableConsoleError(record: ConsoleErrorRecord): boolean {
  const path = (record.location ?? '').split('?')[0] ?? '';
  return FAVICON_URL.test(path) && LOAD_FAILURE.test(record.text);
}

/**
 * `/runtime-config.js` is a script, not JSON, and the page is untrusted input
 * as far as this process is concerned — so the origin is read out of it rather
 * than evaluated. The unconfigured fallback shipped in `apps/web/public`
 * assigns `window.location.origin`, which has no literal to find: that is the
 * failure this is here to name.
 */
export function readRuntimeConfigApiOrigin(body: string): string {
  const match = /"apiOrigin"\s*:\s*"([^"]+)"/u.exec(body);
  const origin = match?.[1];
  if (origin === undefined) {
    throw new Error(
      'runtime-config.js declares no literal apiOrigin; the web container was served without PUBLIC_API_ORIGIN',
    );
  }
  return assertBareOrigin(origin, 'runtime-config.js apiOrigin');
}

/**
 * The smoke talks to a real deployment, so it never guesses an origin: with
 * `SMOKE_WEB_ORIGIN` unset it says so and runs nothing.
 */
export function requireSmokeWebOrigin(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(
      'SMOKE_WEB_ORIGIN is required, e.g. SMOKE_WEB_ORIGIN=https://moi.example pnpm smoke:prod',
    );
  }
  return assertBareOrigin(value, 'SMOKE_WEB_ORIGIN');
}

// Loopback spellings, as `apps/web/server.mjs` lists them for
// PUBLIC_API_ORIGIN. `URL` renders an IPv6 host bracketed.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function assertBareOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL, got ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`${label} must use http or https, got ${value}`);
  // The smoke drives a real deployment and its trace carries a live session
  // cookie; plain HTTP off the loopback would put that on the wire. Loopback
  // stays allowed because that is how the smoke is rehearsed against the e2e
  // harness. Same line `server.mjs` draws for PUBLIC_API_ORIGIN.
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(
      `${label} must use HTTPS outside loopback hosts, got ${value}`,
    );
  if (url.username || url.password)
    throw new Error(`${label} must not include credentials`);
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error(`${label} must be a bare origin without a path`);
  return url.origin;
}

/**
 * The requests that prove the bundle honoured what it read. #25 was a release
 * where the page called its own origin instead: the API answered every probe
 * `deploy.sh` makes while the browser never reached it.
 */
export function apiCallsToOrigin(
  responses: readonly ObservedResponse[],
  apiOrigin: string,
): readonly ObservedResponse[] {
  const prefix = `${apiOrigin}/api/v1/`;
  return responses.filter(
    (response) =>
      response.url.startsWith(prefix) &&
      response.status >= 200 &&
      response.status < 300,
  );
}
