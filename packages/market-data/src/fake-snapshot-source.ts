import type {
  Currency,
  Market,
  OrderBookSnapshot,
} from '@skipjack/trading-core';
import type {
  MarketOrderBookSnapshot,
  MarketPrice,
  MarketSnapshotSource,
  RecoverySnapshot,
} from './ports.js';

export interface FakeSnapshotSourceOptions {
  readonly now?: () => string;
}

/**
 * Deterministic REST snapshot source for tests and the `fake` bundle: every
 * value comes from an explicit `seed`, nothing is invented. Promoted from the
 * e2e system so the production runtime and the e2e harness share one fake.
 */
export class FakeSnapshotSource implements MarketSnapshotSource {
  readonly #books = new Map<string, OrderBookSnapshot>();
  readonly #now: () => string;
  #calls = 0;
  /** Optional barrier tests use to hold recovery in RECOVERING. */
  gate: Promise<void> | undefined;

  constructor(options: FakeSnapshotSourceOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get calls(): number {
    return this.#calls;
  }

  seed(book: OrderBookSnapshot): void {
    this.#books.set(`${book.market}:${book.symbol}`, book);
  }

  seedDefault(market: Market, symbol: string, price: string): void {
    const currency: Currency = market === 'US' ? 'USD' : 'KRW';
    this.seed({
      market,
      symbol,
      currency,
      bids: [{ price, volume: '100' }],
      asks: [{ price, volume: '100' }],
    });
  }

  async getPrice(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<MarketPrice> {
    const snapshot = await this.getRecoverySnapshot(market, symbol, signal);
    return {
      market,
      symbol,
      price: snapshot.price,
      sourceTimestamp: null,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async getOrderBook(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<MarketOrderBookSnapshot> {
    const snapshot = await this.getRecoverySnapshot(market, symbol, signal);
    return {
      market,
      symbol,
      book: snapshot.book,
      sourceTimestamp: null,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async getRecoverySnapshot(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<RecoverySnapshot> {
    this.#calls += 1;
    signal.throwIfAborted();
    if (this.gate) {
      await Promise.race([
        this.gate,
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            { once: true },
          ),
        ),
      ]);
    }
    signal.throwIfAborted();
    const book = this.#books.get(`${market}:${symbol}`);
    if (book === undefined)
      throw new Error(`recovery book is not seeded for ${market}:${symbol}`);
    return {
      market,
      symbol,
      price: book.asks[0]?.price ?? book.bids[0]?.price ?? '0',
      book,
      fetchedAt: this.#now(),
    };
  }
}
