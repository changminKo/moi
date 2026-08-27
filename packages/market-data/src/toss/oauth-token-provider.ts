import type { TokenProvider } from '../ports.js';
import { MarketDataError } from '../types.js';

export const TOKEN_REFRESH_LEAD_MS = 300_000;
export const TOKEN_MIN_REISSUE_INTERVAL_MS = 10_000;

export type TokenRefreshResult = 'ok' | 'auth_failed' | 'throttled' | 'error';

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

export interface OAuthTokenProviderOptions {
  readonly baseUrl: URL | string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly onRefresh?: (result: TokenRefreshResult) => void;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : undefined;
}

/**
 * Client-credentials token provider (§5.5). One cached token per process,
 * refreshed five minutes before expiry, a single in-flight issue shared by
 * concurrent callers, and a 10 s floor between reissues to protect the
 * provider's AUTH rate-limit group. The secret leaves this object only inside
 * the form body of the token request.
 */
export class OAuthTokenProvider implements TokenProvider {
  readonly #o: OAuthTokenProviderOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #cached: CachedToken | null = null;
  #inFlight: Promise<string> | null = null;
  #lastIssueAt = Number.NEGATIVE_INFINITY;

  constructor(options: OAuthTokenProviderOptions) {
    this.#o = options;
    this.#fetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
  }

  async getAccessToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const now = this.#now();
    if (this.#cached && this.#cached.expiresAt - now > TOKEN_REFRESH_LEAD_MS)
      return this.#cached.token;
    if (this.#inFlight) return this.#inFlight;
    if (now - this.#lastIssueAt < TOKEN_MIN_REISSUE_INTERVAL_MS) {
      this.#o.onRefresh?.('throttled');
      throw new MarketDataError(
        'AUTH_THROTTLED',
        'token reissue is throttled to one request per 10 seconds',
      );
    }
    this.#inFlight = this.#issue(signal).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Drops the cached token (after a provider 401); the next call reissues. */
  invalidate(): void {
    this.#cached = null;
  }

  async #issue(signal: AbortSignal): Promise<string> {
    this.#lastIssueAt = this.#now();
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.#o.clientId,
      client_secret: this.#o.clientSecret,
    });
    let response: Response;
    try {
      response = await this.#fetch(new URL('/oauth2/token', this.#o.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal,
      });
    } catch (error) {
      this.#o.onRefresh?.('error');
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      this.#o.onRefresh?.('auth_failed');
      throw new MarketDataError(
        'AUTH_FAILED',
        response.status === 403
          ? 'provider rejected the client IP'
          : 'provider rejected the client credentials',
        { statusCode: response.status },
      );
    }
    if (response.status === 429) {
      this.#o.onRefresh?.('throttled');
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get('retry-after'),
      );
      throw new MarketDataError('RATE_LIMITED', 'token endpoint rate limited', {
        statusCode: 429,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    if (!response.ok) {
      this.#o.onRefresh?.('error');
      throw new MarketDataError(
        'AUTH_FAILED',
        `token endpoint HTTP ${response.status}`,
        {
          statusCode: response.status,
        },
      );
    }
    const payload = (await response.json()) as {
      access_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof payload.access_token !== 'string' ||
      payload.access_token.length === 0 ||
      typeof payload.expires_in !== 'number'
    ) {
      this.#o.onRefresh?.('error');
      throw new MarketDataError('AUTH_FAILED', 'token response is malformed');
    }
    this.#cached = {
      token: payload.access_token,
      expiresAt: this.#now() + payload.expires_in * 1000,
    };
    this.#o.onRefresh?.('ok');
    return payload.access_token;
  }
}
