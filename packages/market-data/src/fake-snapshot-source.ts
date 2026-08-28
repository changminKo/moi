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
/** Decrements the last decimal place of a positive decimal string (e.g. 190.25 → 190.24, 70000 → 69999). */
export function oneTickBelow(price: string): string {
  const [whole, fraction = ''] = price.split('.');
  const scale = fraction.length;
  const units = BigInt(`${whole}${fraction}`) - 1n;
  if (units <= 0n) throw new Error(`cannot step below ${price}`);
  const text = units.toString().padStart(scale + 1, '0');
  return scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

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

  /**
   * Seeds a one-level book with a real spread: `ask` on the offer side and
   * `bid` (default one tick below) on the bid side. A locked book (bid == ask)
   * is rejected by the engine, so a default seed must never produce one.
   */
  seedDefault(market: Market, symbol: string, ask: string, bid?: string): void {
    const currency: Currency = market === 'US' ? 'USD' : 'KRW';
    const bidPrice = bid ?? oneTickBelow(ask);
    this.seed({
      market,
      symbol,
      currency,
      bids: [{ price: bidPrice, volume: '100' }],
      asks: [{ price: ask, volume: '100' }],
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
