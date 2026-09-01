import { DomainError } from '@moi/trading-core';

/**
 * The origin allow-list (design §4.1). `BOT_API_ORIGIN` is checked against it
 * and the runner refuses to start otherwise — fail closed.
 *
 * This is the *real* defence against the bot reaching a live venue. v1 claimed
 * `PaperBroker`'s path union achieved it; it never did, because a path says
 * nothing about a host, and `paper-broker.ts` now says so in its own comment.
 * The host is what decides which company receives an order, so the host is what
 * is pinned.
 *
 * The list is a **code constant**, not configuration. A list an operator can
 * extend through the environment is not an allow-list, it is a default — and
 * the failure it exists to prevent is precisely a wrong environment. The
 * deployment's own public origin is added here, in the commit that adds the
 * compose service, which is design §8.1's phase D.
 *
 * Ports are unconstrained on purpose. A port reaches a different process on the
 * same host, never a different company, and the integration suites bind an
 * ephemeral one. Constraining it would buy nothing and would make the round-trip
 * test unable to use the very code it is testing.
 */
export const ALLOWED_API_HOSTS: ReadonlySet<string> = new Set([
  // The operator's own machine, and the container's own loopback.
  '127.0.0.1',
  'localhost',
  // Bracketed, as `URL.hostname` reports an IPv6 literal.
  '[::1]',
  // The compose service name the bot container resolves (design §8.1).
  'paper-api',
]);

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function refuse(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

/**
 * Validates `BOT_API_ORIGIN` and returns it in the canonical form the transport
 * builds URLs against.
 *
 * A bare origin only: a value carrying a path, a query, a fragment or
 * credentials is refused rather than trimmed. `new URL(path, origin)` resolves
 * an absolute path against the origin's *root* regardless of any path here, so
 * accepting one would silently discard part of what the operator wrote — and a
 * discarded prefix is exactly the kind of "it looked configured" failure this
 * gate exists to make loud.
 */
function readBareOrigin(value: unknown, name: string): URL {
  if (typeof value !== 'string' || value.length === 0) {
    refuse(`${name} must be set`);
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    refuse(`${name} is not a URL: ${value}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    refuse(`${name} must be http or https, got ${url.protocol}`);
  }

  if (url.username !== '' || url.password !== '') {
    refuse(`${name} must not carry credentials`);
  }

  // `new URL('http://h:1')` normalises the path to `'/'`, so an operator's bare
  // origin and a root path are indistinguishable here. The written form is
  // therefore what is checked, and it must be exactly the origin.
  if (url.origin !== value) {
    refuse(
      `${name} must be a bare origin with no path, query or fragment, got ${value}`,
    );
  }

  return url;
}

/** Validates `BOT_API_ORIGIN` — the host the runner will actually connect to. */
export function readApiOrigin(value: unknown): string {
  const url = readBareOrigin(value, 'BOT_API_ORIGIN');

  // `hostname` rather than `host`: it excludes the port, which is deliberately
  // unconstrained. It keeps an IPv6 literal's brackets, so the list is written
  // the way an operator writes the origin.
  if (!ALLOWED_API_HOSTS.has(url.hostname)) {
    refuse(
      `BOT_API_ORIGIN host is not on the allow-list: ${url.host}. The runner refuses to start rather than place orders against an unrecognised host.`,
    );
  }

  return url.origin;
}

/**
 * Validates `BOT_PUBLIC_ORIGIN` — the value of the `Origin` **header** every
 * request carries (design §4.2).
 *
 * This is a different value from `BOT_API_ORIGIN` and the two must not be
 * conflated, which an earlier version of this module did. The paper API's CSRF
 * check compares the header against its own configured `PUBLIC_ORIGIN`
 * (`plugins/csrf.ts`), and `PUBLIC_ORIGIN` is the *browser app's* origin. In
 * the compose deployment the bot connects to `http://paper-api:3000` over the
 * internal network while the public origin is something like
 * `https://app.moi.example`; sending the connect target as the header would be
 * answered 403 on every mutation the bot ever made.
 *
 * It is deliberately **not** checked against `ALLOWED_API_HOSTS`. The allow-list
 * exists to stop the runner *reaching* a venue, and a header value reaches
 * nothing — it is a string the paper API compares against its own configuration.
 * Requiring the web app's public origin to be on a list of hosts the bot may
 * connect to would be a rule about the wrong thing. Its shape is still validated,
 * because a malformed one fails every mutation and should say so at startup.
 */
export function readPublicOrigin(value: unknown): string {
  return readBareOrigin(value, 'BOT_PUBLIC_ORIGIN').origin;
}
