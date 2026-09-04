import type { Currency, Market, OrderBookSnapshot } from '@moi/trading-core';
import type {
  FxRate,
  FxRateSource,
  Instrument,
  InstrumentCatalog,
  MarketCalendarDay,
  MarketCalendarSource,
  MarketOrderBookSnapshot,
  MarketPrice,
  MarketSession,
  MarketSnapshotSource,
  RecoverySnapshot,
  TokenProvider,
} from '../ports.js';
import {
  MarketDataError,
  readDecimalString,
  readOptionalTimestamp,
} from '../types.js';
import { parseRetryAfterMs } from './oauth-token-provider.js';
import type { FetchLike } from './types-internal.js';

export interface TossRestOptions {
  baseUrl: URL | string;
  tokenProvider: TokenProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
type JsonObject = Record<string, unknown>;

function calendarObject(value: unknown, description: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid Toss calendar response: ${description}`);
  return value as JsonObject;
}

function calendarTime(value: unknown, description: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new MarketDataError(
      'UNSUPPORTED_DATA',
      `Invalid Toss calendar response: ${description} must be an ISO timestamp`,
    );
  return value;
}

/**
 * The contract's `regularMarket`: both bounds, or `null` when that session does
 * not run today. An absent key is not a closed session — it is a shape the
 * decoder does not recognise, so it throws rather than invent a holiday.
 * `singlePriceAuction*` is deliberately ignored: it is a phase inside the
 * regular session, not a bound of it.
 */
function calendarSession(
  value: unknown,
  description: string,
): MarketSession | null {
  if (value === null) return null;
  const session = calendarObject(value, `${description} must be an object`);
  return {
    opensAt: calendarTime(session.startTime, `${description}.startTime`),
    closesAt: calendarTime(session.endTime, `${description}.endTime`),
  };
}

export class TossRestClient
  implements
    MarketSnapshotSource,
    InstrumentCatalog,
    MarketCalendarSource,
    FxRateSource
{
  private readonly baseUrl: URL;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(private readonly options: TossRestOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep =
      options.sleep ??
      ((ms, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              );
            },
            { once: true },
          );
        }));
  }
  async getPrice(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<MarketPrice> {
    const body = await this.request(
      `/api/v1/prices?market=${market}&symbols=${encodeURIComponent(symbol)}`,
      signal,
    );
    const row = Array.isArray(body.result) ? body.result[0] : body.result;
    if (!row || typeof row.symbol !== 'string')
      throw new Error('Invalid Toss price response');
    return {
      market,
      symbol: row.symbol,
      price: readDecimalString(row.lastPrice, 'price'),
      sourceTimestamp: readOptionalTimestamp(
        row.timestamp ?? null,
        'price timestamp',
      ),
      fetchedAt: new Date().toISOString(),
    };
  }
  async getOrderBook(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<MarketOrderBookSnapshot> {
    const body = await this.request(
      `/api/v1/orderbook?market=${market}&symbol=${encodeURIComponent(symbol)}`,
      signal,
    );
    const row = body.result as JsonObject;
    if (
      !row ||
      typeof row !== 'object' ||
      !Array.isArray(row.bids) ||
      !Array.isArray(row.asks)
    )
      throw new Error('Invalid Toss orderbook response');
    const currency = row.currency as Currency;
    if (currency !== (market === 'US' ? 'USD' : 'KRW'))
      throw new Error('Invalid Toss orderbook currency');
    const levels = (xs: unknown[]) =>
      xs.map((x) => {
        if (!x || typeof x !== 'object')
          throw new Error('Invalid Toss orderbook level');
        const a = x as Record<string, unknown>;
        return {
          price: readDecimalString(a.price, 'orderbook price'),
          volume: readDecimalString(a.volume, 'orderbook volume'),
        };
      });
    const book: OrderBookSnapshot = {
      market,
      symbol,
      currency,
      bids: levels(row.bids),
      asks: levels(row.asks),
    };
    return {
      market,
      symbol,
      book,
      sourceTimestamp: readOptionalTimestamp(
        row.timestamp ?? null,
        'orderbook timestamp',
      ),
      fetchedAt: new Date().toISOString(),
    };
  }
  async getRecoverySnapshot(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<RecoverySnapshot> {
    const [price, book] = await Promise.all([
      this.getPrice(market, symbol, signal),
      this.getOrderBook(market, symbol, signal),
    ]);
    return {
      market,
      symbol,
      price: price.price,
      book: book.book,
      fetchedAt: new Date().toISOString(),
    };
  }
  async searchInstruments(
    query: string,
    signal: AbortSignal,
  ): Promise<readonly Instrument[]> {
    const body = await this.request('/api/v1/stocks/all', signal);
    if (!Array.isArray(body.result))
      throw new Error('Invalid Toss instruments response');
    const q = query.toLowerCase();
    return body.result
      .filter(
        (x: unknown): x is JsonObject =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as JsonObject).symbol === 'string' &&
          (String((x as JsonObject).symbol)
            .toLowerCase()
            .includes(q) ||
            String((x as JsonObject).name ?? '')
              .toLowerCase()
              .includes(q)),
      )
      .map((x) => ({
        market: x.securityType === 'FOREIGN_STOCK' ? 'US' : 'KR',
        symbol: String(x.symbol),
        name: String(x.name ?? ''),
        currency: x.securityType === 'FOREIGN_STOCK' ? 'USD' : 'KRW',
        tradable: x.isCommonShare !== false,
      }));
  }
  async getInstrument(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<Instrument | null> {
    const rows = await this.searchInstruments(symbol, signal);
    return rows.find((x) => x.market === market && x.symbol === symbol) ?? null;
  }
  async getCalendarDay(
    market: Market,
    tradingDate: string,
    signal: AbortSignal,
  ): Promise<MarketCalendarDay> {
    const body = await this.request(
      `/api/v1/market-calendar/${market}?date=${encodeURIComponent(tradingDate)}`,
      signal,
    );
    const result = calendarObject(body.result, 'result must be an object');
    const today = calendarObject(
      result.today,
      'result.today must be an object',
    );
    if (typeof today.date !== 'string' || today.date === '')
      throw new Error('Invalid Toss calendar response: today.date is missing');
    // KR nests the day's sessions under `integrated` (null when KRX and NXT are
    // both shut); US carries the four sessions on the day itself. Only the
    // regular session is read, and `isTradingDay` means "a regular session runs
    // today" for both markets: that is the fact `derivePhase` and the
    // MARKET-order gate need, and a day whose pre/after markets run without a
    // regular session is not one this platform can trade (§16.57).
    const regular =
      market === 'KR'
        ? today.integrated === null
          ? null
          : calendarObject(
              today.integrated,
              'today.integrated must be an object or null',
            ).regularMarket
        : today.regularMarket;
    const session = calendarSession(
      regular,
      market === 'KR'
        ? 'today.integrated.regularMarket'
        : 'today.regularMarket',
    );
    return {
      market,
      tradingDate: today.date,
      isTradingDay: session !== null,
      regularSession: session,
    };
  }
  async getFxRate(
    base: Currency,
    quote: Currency,
    signal: AbortSignal,
  ): Promise<FxRate> {
    const body = await this.request(
      `/api/v1/exchange-rate?baseCurrency=${base}&quoteCurrency=${quote}`,
      signal,
    );
    const x = body.result;
    if (!x || typeof x !== 'object')
      throw new Error('Invalid Toss FX response');
    const r = x as Record<string, unknown>;
    return {
      base: r.baseCurrency as Currency,
      quote: r.quoteCurrency as Currency,
      rate: readDecimalString(r.rate, 'exchange rate'),
      asOf: String(r.validFrom),
    };
  }
  private async request(
    path: string,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    let last: unknown;
    let invalidated = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
      const abort = () => timeout.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const token = await this.options.tokenProvider.getAccessToken(signal);
        const response = await this.fetcher(new URL(path, this.baseUrl), {
          signal: timeout.signal,
          headers: { Authorization: `Bearer ${token}` },
        });
        if (
          response.status === 401 &&
          !invalidated &&
          this.options.tokenProvider.invalidate
        ) {
          // The provider invalidates the previous token on reissue (§5.5): refresh once.
          invalidated = true;
          this.options.tokenProvider.invalidate(token);
          last = new MarketDataError(
            'AUTH_FAILED',
            'Toss REST rejected the access token',
            { statusCode: 401 },
          );
          continue;
        }
        if (response.status === 401 || response.status === 403)
          throw new MarketDataError(
            'AUTH_FAILED',
            response.status === 403
              ? 'Toss REST rejected the client IP'
              : 'Toss REST rejected the access token',
            { statusCode: response.status },
          );
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(
            response.headers.get('retry-after'),
          );
          last = new MarketDataError('RATE_LIMITED', 'Toss REST rate limited', {
            statusCode: 429,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          });
          if (attempt === this.maxRetries) throw last;
          await this.sleep(retryAfterMs ?? 2 ** attempt * 100, signal);
          continue;
        }
        if (!response.ok) throw new Error(`Toss REST HTTP ${response.status}`);
        const body = await response.json();
        if (!body || typeof body !== 'object' || body.success === false)
          throw new Error('Invalid Toss REST envelope');
        return body;
      } catch (e) {
        last = e;
        if (signal.aborted) throw e;
        if (e instanceof MarketDataError && e.code === 'AUTH_FAILED') throw e;
        if (attempt === this.maxRetries) throw e;
        await this.sleep(2 ** attempt * 100, signal);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }
    throw last;
  }
}
