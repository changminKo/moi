import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Market } from '@skipjack/trading-core';

export interface FakeBookLevel {
  readonly price: string;
  readonly volume: string;
}
export interface FakeBook {
  readonly asks: readonly FakeBookLevel[];
  readonly bids: readonly FakeBookLevel[];
}
export interface FakeRestRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Whether an Authorization header was present — never the token itself. */
  readonly authorized: boolean;
}

const DEFAULT_TOKEN_TTL_SECONDS = 86_400;
const KNOWN_PATHS = new Set([
  '/oauth2/token',
  '/api/v1/prices',
  '/api/v1/orderbook',
  '/api/v1/stocks/all',
  '/api/v1/market-calendar/KR',
  '/api/v1/market-calendar/US',
  '/api/v1/exchange-rate',
]);

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

/**
 * Behavioural model of the pinned OpenAPI contract's public surface (§9.2):
 * OAuth2 client-credentials issuance with single-token validity, bearer-guarded
 * market-data reads in the BFF envelope, and the contract's error examples.
 * Binds to 127.0.0.1 only; order/account paths do not exist here (404).
 */
export class FakeTossRestServer {
  readonly #server: Server;
  readonly #clients = new Map<string, string>();
  readonly #tokens = new Map<string, { clientId: string; expiresAt: number }>();
  readonly #activeTokenByClient = new Map<string, string>();
  readonly #snapshots = new Map<string, { price: string; book: FakeBook }>();
  readonly #failNext = new Map<string, { status: number; remaining: number }>();
  readonly #requests: FakeRestRequestRecord[] = [];
  #tokenTtlSeconds = DEFAULT_TOKEN_TTL_SECONDS;
  #retryAfterSeconds = 1;
  #ipAllowed = true;
  #tokenRequests = 0;
  #port = 0;

  constructor() {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent)
          json(response, 500, { error: { code: 'internal-error' } });
      });
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#server.listen(0, '127.0.0.1', resolve),
    );
    const address = this.#server.address();
    this.#port = typeof address === 'object' && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  // ---- control API --------------------------------------------------------

  issueCredentials(): { clientId: string; clientSecret: string } {
    const clientId = `c_${randomBytes(12).toString('hex')}`;
    const clientSecret = `s_${randomBytes(24).toString('base64url')}`;
    this.#clients.set(clientId, clientSecret);
    return { clientId, clientSecret };
  }
  setTokenTtl(seconds: number): void {
    this.#tokenTtlSeconds = seconds;
  }
  setRetryAfter(seconds: number): void {
    this.#retryAfterSeconds = seconds;
  }
  setIpAllowed(allowed: boolean): void {
    this.#ipAllowed = allowed;
  }
  invalidateAllTokens(): void {
    this.#tokens.clear();
    this.#activeTokenByClient.clear();
  }
  failNext(path: string, status: number, count = 1): void {
    this.#failNext.set(path, { status, remaining: count });
  }
  seedSnapshot(
    market: Market,
    symbol: string,
    price: string,
    book: FakeBook,
  ): void {
    this.#snapshots.set(`${market}:${symbol}`, { price, book });
  }
  requests(): readonly FakeRestRequestRecord[] {
    return [...this.#requests];
  }
  tokenRequests(): number {
    return this.#tokenRequests;
  }
  activeTokenCount(): number {
    return this.#tokens.size;
  }

  // ---- HTTP ---------------------------------------------------------------

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl);
    const method = request.method ?? 'GET';
    const authorized = typeof request.headers.authorization === 'string';
    const record = (status: number): void => {
      this.#requests.push({ method, path: url.pathname, status, authorized });
    };
    const injected = this.#failNext.get(url.pathname);
    if (injected && injected.remaining > 0) {
      injected.remaining -= 1;
      if (injected.remaining === 0) this.#failNext.delete(url.pathname);
      record(injected.status);
      json(
        response,
        injected.status,
        {
          error: {
            requestId: 'fake',
            code:
              injected.status === 429
                ? 'rate-limit-exceeded'
                : 'internal-error',
            message: 'injected',
          },
        },
        injected.status === 429
          ? { 'retry-after': String(this.#retryAfterSeconds) }
          : {},
      );
      return;
    }
    if (!KNOWN_PATHS.has(url.pathname)) {
      record(404);
      json(response, 404, {
        error: {
          requestId: 'fake',
          code: 'not-found',
          message: 'unknown path',
        },
      });
      return;
    }
    if (url.pathname === '/oauth2/token') {
      await this.#token(request, response, record);
      return;
    }
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const grant = token ? this.#tokens.get(token) : undefined;
    if (
      !token ||
      !grant ||
      grant.expiresAt <= Date.now() ||
      this.#activeTokenByClient.get(grant.clientId) !== token
    ) {
      record(401);
      json(
        response,
        401,
        {
          error: {
            requestId: 'fake',
            code: 'unauthorized',
            message: 'Token is invalid or expired',
          },
        },
        { 'www-authenticate': 'Bearer realm="openapi", error="invalid_token"' },
      );
      return;
    }
    const market = url.searchParams.get('market') as Market | null;
    if (url.pathname === '/api/v1/prices') {
      const symbols = (url.searchParams.get('symbols') ?? '')
        .split(',')
        .filter(Boolean);
      const rows = symbols.map((symbol) => {
        const seeded = this.#snapshots.get(`${market}:${symbol}`);
        return seeded
          ? {
              symbol,
              timestamp: new Date().toISOString(),
              lastPrice: seeded.price,
              currency: market === 'US' ? 'USD' : 'KRW',
            }
          : undefined;
      });
      if (rows.some((r) => r === undefined) || rows.length === 0) {
        record(404);
        json(response, 404, {
          error: {
            requestId: 'fake',
            code: 'not-found',
            message: 'symbol not seeded',
          },
        });
        return;
      }
      record(200);
      json(response, 200, { success: true, result: rows });
      return;
    }
    if (url.pathname === '/api/v1/orderbook') {
      const symbol = url.searchParams.get('symbol') ?? '';
      const seeded = this.#snapshots.get(`${market}:${symbol}`);
      if (!seeded) {
        record(404);
        json(response, 404, {
          error: {
            requestId: 'fake',
            code: 'not-found',
            message: 'symbol not seeded',
          },
        });
        return;
      }
      record(200);
      json(response, 200, {
        success: true,
        result: {
          timestamp: new Date().toISOString(),
          currency: market === 'US' ? 'USD' : 'KRW',
          asks: seeded.book.asks,
          bids: seeded.book.bids,
        },
      });
      return;
    }
    record(200);
    json(response, 200, { success: true, result: [] });
  }

  async #token(
    request: IncomingMessage,
    response: ServerResponse,
    record: (status: number) => void,
  ): Promise<void> {
    this.#tokenRequests += 1;
    if (!this.#ipAllowed) {
      record(403);
      json(response, 403, {
        error: 'access_denied',
        error_description: 'IP address not allowed',
      });
      return;
    }
    const form = new URLSearchParams(await readBody(request));
    const grantType = form.get('grant_type');
    if (grantType !== 'client_credentials') {
      record(400);
      json(response, 400, {
        error: grantType ? 'unsupported_grant_type' : 'invalid_request',
        error_description: grantType
          ? 'Only client_credentials grant type is supported.'
          : 'Required parameter is missing.',
      });
      return;
    }
    const clientId = form.get('client_id');
    const clientSecret = form.get('client_secret');
    if (!clientId || !clientSecret) {
      record(400);
      json(response, 400, {
        error: 'invalid_request',
        error_description: 'Required parameter is missing.',
      });
      return;
    }
    if (this.#clients.get(clientId) !== clientSecret) {
      record(401);
      json(
        response,
        401,
        {
          error: 'invalid_client',
          error_description: 'Client authentication failed.',
        },
        { 'www-authenticate': 'Basic realm="openapi"' },
      );
      return;
    }
    const previous = this.#activeTokenByClient.get(clientId);
    if (previous) this.#tokens.delete(previous);
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(token, {
      clientId,
      expiresAt: Date.now() + this.#tokenTtlSeconds * 1000,
    });
    this.#activeTokenByClient.set(clientId, token);
    record(200);
    json(response, 200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.#tokenTtlSeconds,
    });
  }
}
