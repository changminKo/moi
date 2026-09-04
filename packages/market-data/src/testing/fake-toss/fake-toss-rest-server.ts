import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Market } from '@moi/trading-core';

export interface FakeBookLevel {
  readonly price: string;
  readonly volume: string;
}
export interface FakeBook {
  readonly asks: readonly FakeBookLevel[];
  readonly bids: readonly FakeBookLevel[];
}
/** The regular-session window of one seeded calendar day (contract bounds). */
export interface FakeCalendarSession {
  readonly startTime: string;
  readonly endTime: string;
}
export interface FakeRestRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Whether an Authorization header was present — never the token itself. */
  readonly authorized: boolean;
  /** Wall-clock ms when the request was answered. */
  readonly at: number;
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** A date that exists: the pattern plus a round trip through the calendar. */
function isCalendarDate(value: string): boolean {
  return (
    DATE_PATTERN.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
/** Nearest weekday strictly before (`step` −1) or after (`step` +1) `date`. */
function nearestWeekday(date: string, step: number): string {
  let cursor = shiftDate(date, step);
  while (isWeekend(cursor)) cursor = shiftDate(cursor, step);
  return cursor;
}

/** The zone whose local clock defines each market's session times. */
const MARKET_TIME_ZONE: Readonly<Record<Market, string>> = {
  KR: 'Asia/Seoul',
  US: 'America/New_York',
};

/** Minutes `timeZone` is offset from UTC at `instant`. */
function zoneOffsetMinutes(timeZone: string, instant: number): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(instant))
    .find((part) => part.type === 'timeZoneName')?.value;
  const parsed = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(name ?? '');
  // A bare "GMT" means the zone sits at UTC on that date.
  if (!parsed) return 0;
  return (
    (parsed[1] === '-' ? -1 : 1) * (Number(parsed[2]) * 60 + Number(parsed[3]))
  );
}

/**
 * The instant `hh:mm` local time falls on, on `date`, in `timeZone`. The offset
 * is read twice: once for the wall time read as UTC, then again at the instant
 * that produced, so a date on the far side of a DST change resolves correctly.
 */
function marketInstant(
  date: string,
  timeZone: string,
  hh: number,
  mm: number,
): number {
  const pad = (n: number) => String(n).padStart(2, '0');
  const naive = Date.parse(`${date}T${pad(hh)}:${pad(mm)}:00Z`);
  const first = naive - zoneOffsetMinutes(timeZone, naive) * 60_000;
  return naive - zoneOffsetMinutes(timeZone, first) * 60_000;
}

/**
 * The contract renders every calendar time in KST (`+09:00`), for both markets.
 * Seoul has no DST, so the rendering is a fixed nine-hour shift.
 */
function kst(instant: number): string {
  return `${new Date(instant + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
}

function localSession(
  date: string,
  market: Market,
  opens: readonly [number, number],
  closes: readonly [number, number],
): FakeCalendarSession {
  const zone = MARKET_TIME_ZONE[market];
  return {
    startTime: kst(marketInstant(date, zone, opens[0], opens[1])),
    endTime: kst(marketInstant(date, zone, closes[0], closes[1])),
  };
}

/**
 * The regular session a market runs on an unseeded weekday, defined in the
 * market's *own* clock (Seoul 09:00–15:30, New York 09:30–16:00) and rendered
 * in KST at that date's real offset. Hard-coding the KST window instead would
 * pin the US session to daylight time and put January's 08:45 EST inside the
 * regular session. Weekends are closed.
 */
const DEFAULT_REGULAR_SESSION: Readonly<
  Record<Market, (date: string) => FakeCalendarSession>
> = {
  KR: (date) => localSession(date, 'KR', [9, 0], [15, 30]),
  US: (date) => localSession(date, 'US', [9, 30], [16, 0]),
};

/**
 * One `KrMarketDay`. Only `regularMarket` follows the seed: the pre/after
 * markets keep the contract's canonical windows so a decoder that reads the
 * wrong session gets a visibly wrong answer rather than a plausible one.
 */
function krMarketDay(
  date: string,
  regular: FakeCalendarSession | null,
): object {
  if (regular === null) return { date, integrated: null };
  return {
    date,
    integrated: {
      preMarket: {
        startTime: `${date}T08:00:00+09:00`,
        singlePriceAuctionStartTime: `${date}T08:50:00+09:00`,
        endTime: `${date}T09:00:00+09:00`,
      },
      regularMarket: {
        startTime: regular.startTime,
        singlePriceAuctionStartTime: `${date}T15:20:00+09:00`,
        endTime: regular.endTime,
      },
      afterMarket: {
        startTime: `${date}T15:30:00+09:00`,
        singlePriceAuctionEndTime: `${date}T15:40:00+09:00`,
        endTime: `${date}T20:00:00+09:00`,
      },
    },
  };
}

/**
 * One `UsMarketDay`; a holiday is all four sessions null. Pre- and after-market
 * follow New York's clock like the regular session does; `dayMarket` is Toss's
 * own Korean-daytime session and stays anchored to the KST date.
 */
function usMarketDay(
  date: string,
  regular: FakeCalendarSession | null,
): object {
  if (regular === null)
    return {
      date,
      dayMarket: null,
      preMarket: null,
      regularMarket: null,
      afterMarket: null,
    };
  return {
    date,
    dayMarket: {
      startTime: `${date}T09:00:00+09:00`,
      endTime: `${date}T16:50:00+09:00`,
    },
    preMarket: localSession(date, 'US', [4, 0], [9, 30]),
    regularMarket: { startTime: regular.startTime, endTime: regular.endTime },
    afterMarket: localSession(date, 'US', [16, 0], [18, 0]),
  };
}

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
  readonly #instruments = new Map<
    string,
    { market: Market; symbol: string; name: string }
  >();
  readonly #calendar = new Map<string, FakeCalendarSession | null>();
  readonly #failNext = new Map<string, { status: number; remaining: number }>();
  readonly #requests: FakeRestRequestRecord[] = [];
  #tokenTtlSeconds = DEFAULT_TOKEN_TTL_SECONDS;
  #retryAfterSeconds = 1;
  #ipAllowed = true;
  #tokenRequests = 0;
  #port = 0;
  #onTokenIssued: ((token: string) => void) | undefined;

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
  seedInstrument(market: Market, symbol: string, name: string): void {
    this.#instruments.set(`${market}:${symbol}`, { market, symbol, name });
  }
  /**
   * Overrides one calendar day. `null` closes the market's regular session that
   * day; an unseeded day runs the canonical session on a weekday and is closed
   * on a weekend.
   */
  seedCalendarDay(
    market: Market,
    date: string,
    regularMarket: FakeCalendarSession | null,
  ): void {
    this.#calendar.set(`${market}:${date}`, regularMarket);
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
  /** Lets a harness hand freshly issued tokens to a fake WebSocket server. */
  onTokenIssued(listener: (token: string) => void): void {
    this.#onTokenIssued = listener;
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
      this.#requests.push({
        method,
        path: url.pathname,
        status,
        authorized,
        at: Date.now(),
      });
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
    if (url.pathname === '/api/v1/stocks/all') {
      record(200);
      json(response, 200, {
        success: true,
        result: [...this.#instruments.values()].map((instrument) => ({
          symbol: instrument.symbol,
          name: instrument.name,
          securityType: instrument.market === 'US' ? 'FOREIGN_STOCK' : 'STOCK',
          isCommonShare: true,
        })),
      });
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
    if (url.pathname.startsWith('/api/v1/market-calendar/')) {
      this.#calendarDay(url, response, record);
      return;
    }
    record(200);
    json(response, 200, { success: true, result: [] });
  }

  /**
   * `GET /api/v1/market-calendar/{KR,US}` in the contract's shape: `today` plus
   * the neighbouring business days. Without this the path fell through to the
   * empty catch-all envelope, which a decoder could only read as a holiday
   * (#122).
   */
  #calendarDay(
    url: URL,
    response: ServerResponse,
    record: (status: number) => void,
  ): void {
    const market = url.pathname.slice(
      '/api/v1/market-calendar/'.length,
    ) as Market;
    const requested = url.searchParams.get('date');
    // A real calendar date, round-tripped: `Date.parse` alone rolls 2026-02-31
    // over into March and would answer 200 for a day that does not exist.
    if (requested === null || !isCalendarDate(requested)) {
      record(400);
      json(response, 400, {
        error: {
          requestId: 'fake',
          code: 'unsupported-date',
          message: '요청한 조회 일자를 지원하지 않습니다.',
          data: { field: 'date' },
        },
      });
      return;
    }
    const date = requested;
    const day = (on: string): object => {
      const key = `${market}:${on}`;
      const session = this.#calendar.has(key)
        ? (this.#calendar.get(key) ?? null)
        : isWeekend(on)
          ? null
          : DEFAULT_REGULAR_SESSION[market](on);
      return market === 'KR'
        ? krMarketDay(on, session)
        : usMarketDay(on, session);
    };
    record(200);
    json(response, 200, {
      success: true,
      result: {
        today: day(date),
        previousBusinessDay: day(nearestWeekday(date, -1)),
        nextBusinessDay: day(nearestWeekday(date, 1)),
      },
    });
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
    this.#onTokenIssued?.(token);
    record(200);
    json(response, 200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.#tokenTtlSeconds,
    });
  }
}
