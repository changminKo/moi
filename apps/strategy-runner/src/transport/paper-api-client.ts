import type {
  PaperBrokerRequest,
  PaperBrokerResponse,
  PaperBrokerTransport,
} from '@moi/strategy-sdk';
import { DomainError } from '@moi/trading-core';
import { readApiOrigin, readPublicOrigin } from '../api-origin.js';

/**
 * The authenticated seam between the runner and the paper API (design §4.2).
 *
 * It owns exactly three things: the origin, the session headers, and turning a
 * response into `{ status, body }`. Everything above it — retries, session
 * re-establishment, decoding — belongs to the callers, because those are
 * policies and this is a pipe.
 *
 * ## Why the origin is pinned twice
 *
 * `readApiOrigin` decides at startup that the configured origin is allowed. That
 * is not sufficient on its own: `new URL('http://evil.example/x', origin)`
 * ignores the origin entirely and returns `http://evil.example/x`, so a path
 * that is not relative escapes an allow-list that was only checked once. The
 * request path is therefore required to begin with a single `/`, and the
 * assembled URL's origin is compared against the allowed one before the request
 * is made. Design §4.1 asks for "a host constant in the transport"; this is it,
 * and it is a check rather than a comment because the SDK's own `PaperBrokerPath`
 * is a compile-time union that a JavaScript caller can simply not honour.
 */

export interface SessionCredentials {
  readonly sessionId: string;
  /** The `moi_session=…` cookie pair, as sent. */
  readonly cookie: string;
  readonly csrfToken: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly setCookie: string | null;
}

export interface ApiRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Absolute-path-relative, e.g. `/api/v1/portfolio`. */
  readonly path: string;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  /**
   * Whether to send the session. Off for the bootstrap call, which is what
   * creates a session, and for public reference data.
   */
  readonly authenticated?: boolean;
}

export type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface PaperApiClientOptions {
  /** Where to connect. Checked against the allow-list (§4.1). */
  readonly origin: string;
  /**
   * The `Origin` header value, which must equal the paper API's own configured
   * `PUBLIC_ORIGIN` for its CSRF check to pass (§4.2). Defaults to `origin`,
   * which is right on a loopback development stack and wrong in compose, where
   * the bot connects to the service name and the public origin is the web app's.
   */
  readonly publicOrigin?: string;
  /**
   * The credentials in force *now*. A supplier rather than a value because a
   * session swap replaces them mid-run, and a transport holding a stale copy
   * would keep writing under a session the ledger has forgotten.
   */
  readonly credentials: () => SessionCredentials | null;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const RELATIVE_PATH = /^\/(?!\/)/u;

function refuse(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

export class PaperApiClient {
  readonly #origin: string;
  readonly #publicOrigin: string;
  readonly #credentials: () => SessionCredentials | null;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: PaperApiClientOptions) {
    // Re-validated here rather than trusted from the caller: this class is the
    // only thing that turns a configured string into a network destination, so
    // it is the right place for the check to be unconditional.
    this.#origin = readApiOrigin(options.origin);
    this.#publicOrigin =
      options.publicOrigin === undefined
        ? this.#origin
        : readPublicOrigin(options.publicOrigin);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get origin(): string {
    return this.#origin;
  }

  get publicOrigin(): string {
    return this.#publicOrigin;
  }

  /**
   * Builds the request URL, refusing anything that would leave the pinned
   * origin. `//host/path` is rejected along with an absolute URL: it is
   * protocol-relative and resolves to a different host just as surely.
   */
  #url(path: string): string {
    if (typeof path !== 'string' || !RELATIVE_PATH.test(path)) {
      refuse(
        `a paper API path must start with a single '/', got ${String(path)}`,
      );
    }

    const url = new URL(path, this.#origin);

    if (url.origin !== this.#origin) {
      refuse(
        `a paper API request may not leave ${this.#origin}, got ${url.origin}`,
      );
    }

    return url.toString();
  }

  async send(request: ApiRequest): Promise<ApiResponse> {
    const url = this.#url(request.path);
    const isMutation = request.method !== 'GET';
    const authenticated = request.authenticated !== false;
    // Every mutation carries all four headers design §4.2 lists. `Origin` goes
    // on reads too: the CSRF plugin only inspects it on a mutation, but sending
    // one shape of request is simpler than sending two.
    const headers: Record<string, string> = { origin: this.#publicOrigin };

    if (authenticated) {
      const credentials = this.#credentials();

      if (credentials === null) {
        refuse('an authenticated paper API request needs a session');
      }

      headers.cookie = credentials.cookie;

      if (isMutation) {
        headers['x-csrf-token'] = credentials.csrfToken;
      }
    }

    // An *authenticated* mutation needs a key. Not merely the API's requirement:
    // a session-scoped write with no key is a write that cannot be replayed, and
    // being able to replay one is what the runner's whole restart story rests on.
    //
    // The qualifier is not a loophole, it is the same rule read correctly. The
    // ledger scopes idempotency by `(session_id, key)`, so a key sent by a
    // request that carries no session has nothing to be unique within. There is
    // exactly one such mutation — `POST /api/v1/sessions/anonymous`, the call
    // that *creates* the session — and design §4.3 makes it safe a different
    // way: it is issued only when there is no usable session, and what it
    // returns is persisted before anything can be placed under it.
    if (isMutation && authenticated) {
      if (request.idempotencyKey === undefined) {
        refuse(
          `a ${request.method} to ${request.path} needs an idempotency key`,
        );
      }

      headers['idempotency-key'] = request.idempotencyKey;
    }

    if (isMutation && !authenticated && request.idempotencyKey !== undefined) {
      refuse(
        `a ${request.method} to ${request.path} carries no session, so an idempotency key would have nothing to be unique within`,
      );
    }

    const serialised =
      request.body === undefined ? undefined : JSON.stringify(request.body);

    if (serialised !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        method: request.method,
        headers,
        ...(serialised === undefined ? {} : { body: serialised }),
        signal: controller.signal,
      });
      const text = await response.text();

      return {
        status: response.status,
        // An empty or non-JSON body is `undefined` rather than an error: the
        // status is what the callers branch on, and a 502 from something in
        // front of the API carries HTML.
        body: text.length === 0 ? undefined : parseJson(text),
        setCookie: response.headers.get('set-cookie'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The seam `PaperBroker` takes. It is this class narrowed, not a second
   * implementation: the SDK's adapter owns request mapping and decoding, and
   * this owns the session and the origin, which is exactly the split
   * `PaperBrokerTransport` documents.
   */
  brokerTransport(): PaperBrokerTransport {
    return {
      request: async (
        request: PaperBrokerRequest,
      ): Promise<PaperBrokerResponse> => {
        const response = await this.send({
          method: request.method,
          path: request.path,
          ...(request.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: request.idempotencyKey }),
          ...(request.body === undefined ? {} : { body: request.body }),
        });

        return { status: response.status, body: response.body };
      },
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
