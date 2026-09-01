import type {
  InstrumentRef,
  Tick,
  TickPriceSource,
} from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';

/**
 * Turns a quote projection into a `Tick`, and owns the three judgements that
 * have to be made the same way whichever path the projection arrived on:
 * whether it is a *new* observation, whether a *gap* precedes it, and what the
 * book is once a frame that did not restate it has been merged in.
 *
 * ## One ticker, both paths
 *
 * Phase C has two market-data paths — the stream subscription and the REST read
 * that re-baselines after a reconnect (design §5.1). They carry the same
 * projection from the same builder, so the same observation can legitimately
 * reach the runner down both, and a strategy that saw it twice would have one
 * price in its window twice and both its averages pulled towards it.
 *
 * Putting the cursor here rather than in each path makes that impossible by
 * construction instead of by care: a projection is a tick only when
 * `(recoveryEpoch, marketDataVersion)` strictly advances past what this ticker
 * has already seen, whoever hands it over. That is what lets the reconnect
 * re-baseline run unconditionally — it costs a REST read and it cannot
 * duplicate a tick.
 *
 * ## The book a frame does not restate
 *
 * Quote-contract rule 3: `currency`, `bids` and `asks` are **omitted, not
 * emptied**, when the symbol's slot holds no book, and rule 4 says a frame
 * carries what the projection knew at that moment rather than restating
 * everything. A consumer therefore merges rather than replaces. Reading an
 * absent side as "now empty" is the bug that blanked the browser's depth when a
 * trade arrived before the first book (spec §16.36); here it would hand a
 * strategy `bestBid: null` on an instrument whose book is perfectly good.
 *
 * The merged book is held in memory only. It is market state, not runner state,
 * and a book restored from a file after a restart is a book from before the
 * outage being presented as current.
 *
 * ## What a gap is
 *
 * Unchanged from phase B, deliberately: `gapBefore` is true when more than
 * `gapAfterMs` has passed since this instrument was last *observed*, or when
 * the recovery epoch advanced. One rule covers a first run, a restart, a poll
 * outage, and — now — a reconnect, because all of them are the runner not
 * watching.
 *
 * Phase C does **not** add "a reconnect is always a gap". §5.3 says it in those
 * words, but the reason it gives is that quote frames are not replayed, and
 * that reason is a statement about elapsed time: a socket replaced in 200 ms
 * missed at most one book update, and phase A's response to a gap is to discard
 * the whole ring and withhold entries for `slowPeriod + 1` ticks. Declaring a
 * gap on every reconnect would pay that price for a blip, and would still say
 * nothing about a socket that stayed up while the market went quiet. The
 * elapsed-time rule already says the right thing about both.
 */

export interface InstrumentCursor {
  readonly recoveryEpoch: string;
  readonly marketDataVersion: string;
  /** When the runner last *saw* this instrument, epoch milliseconds. */
  readonly observedAtMs: number;
}

export type FeedCursors = Readonly<Record<string, InstrumentCursor>>;

export const instrumentKey = (reference: InstrumentRef): string =>
  `${reference.market}:${reference.symbol}`;

const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/u;

function readCounter(value: unknown, field: string): string {
  if (typeof value !== 'string' || !WHOLE_NUMBER.test(value)) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `the quote payload ${field} must be a whole number, got ${String(value)}`,
    );
  }

  return value;
}

/** Ordering over `(recoveryEpoch, marketDataVersion)`, both unbounded counters. */
function advances(next: InstrumentCursor, previous: InstrumentCursor): boolean {
  const epoch = BigInt(next.recoveryEpoch) - BigInt(previous.recoveryEpoch);

  if (epoch !== 0n) {
    return epoch > 0n;
  }

  return BigInt(next.marketDataVersion) > BigInt(previous.marketDataVersion);
}

/** The touch of a book side, or `null` when there is no level to read. */
function touch(levels: unknown): string | null {
  if (!Array.isArray(levels) || levels.length === 0) {
    return null;
  }

  const price = (levels[0] as { price?: unknown }).price;

  return typeof price === 'string' && price.length > 0 ? price : null;
}

/** The two sides the runner keeps between frames. `undefined` is "not stated". */
interface Book {
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
}

const EMPTY_BOOK: Book = Object.freeze({ bestBid: null, bestAsk: null });

/**
 * A gap the ticker declared over a series it had already been watching. A first
 * observation is a gap too, and is deliberately not reported: there is nothing
 * to have lost, and a line about it on every start is noise.
 */
export interface ObservedGap {
  readonly instrument: string;
  readonly sinceMs: number;
  readonly recoveryEpoch: string;
}

export interface QuoteTickerOptions {
  readonly gapAfterMs: number;
  readonly now?: () => number;
  readonly cursors?: FeedCursors;
  /**
   * Where a declared gap is announced. A callback rather than a `Reporter` so
   * the ticker stays a pure judgement over quotes — the caller decides whether
   * that judgement is a log line, a Discord embed, or both.
   */
  readonly onGap?: (gap: ObservedGap) => void;
}

export class QuoteTicker {
  readonly #gapAfterMs: number;
  readonly #now: () => number;
  readonly #onGap: ((gap: ObservedGap) => void) | undefined;
  readonly #cursors = new Map<string, InstrumentCursor>();
  readonly #books = new Map<string, Book>();

  constructor(options: QuoteTickerOptions) {
    this.#gapAfterMs = options.gapAfterMs;
    this.#now = options.now ?? Date.now;
    this.#onGap = options.onGap;

    for (const [key, cursor] of Object.entries(options.cursors ?? {})) {
      this.#cursors.set(key, cursor);
    }
  }

  /** The cursors to persist, so a restart can tell a short break from a gap. */
  cursors(): FeedCursors {
    return Object.freeze(Object.fromEntries(this.#cursors));
  }

  /**
   * A projection observed on `source`. Answers the tick it produced, or `null`
   * when it produced none — an empty slot, or an observation already seen.
   */
  observe(
    reference: InstrumentRef,
    payload: Readonly<Record<string, unknown>>,
    source: TickPriceSource,
  ): Tick | null {
    const price = payload.price;

    // `price: null` is a symbol whose slot holds nothing yet — before the first
    // book, or after a recovery. There is no observation to report, and the
    // clock is deliberately not touched: a symbol that never quotes is a symbol
    // the runner is not seeing.
    if (typeof price !== 'string' || price.length === 0) {
      return null;
    }

    const key = instrumentKey(reference);
    const at = this.#now();
    const previous = this.#cursors.get(key);
    const cursor: InstrumentCursor = {
      recoveryEpoch: readCounter(payload.recoveryEpoch, 'recoveryEpoch'),
      marketDataVersion: readCounter(
        payload.marketDataVersion,
        'marketDataVersion',
      ),
      observedAtMs: at,
    };

    if (previous !== undefined && !advances(cursor, previous)) {
      // Seen, but nothing new. The clock advances so a calm market is not
      // mistaken for a gap; no tick is produced because there is no new
      // observation to produce one from.
      this.#cursors.set(key, { ...previous, observedAtMs: at });

      return null;
    }

    const gapBefore =
      previous === undefined ||
      previous.recoveryEpoch !== cursor.recoveryEpoch ||
      at - previous.observedAtMs > this.#gapAfterMs;
    const book = this.#merge(key, payload, gapBefore);

    this.#cursors.set(key, cursor);

    if (gapBefore && previous !== undefined) {
      this.#onGap?.({
        instrument: key,
        sinceMs: at - previous.observedAtMs,
        recoveryEpoch: cursor.recoveryEpoch,
      });
    }

    return Object.freeze({
      market: reference.market,
      symbol: reference.symbol,
      price,
      priceSource: source,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      // The runner's receive time, as `Tick.asOf` documents. The payload's own
      // `asOf` is the instant the API projected the quote, which is a different
      // fact and not the one this field names.
      asOf: new Date(at).toISOString(),
      marketDataVersion: cursor.marketDataVersion,
      gapBefore,
    });
  }

  /** How long since this instrument was observed, or `null` if it never was. */
  sinceObservedMs(reference: InstrumentRef): number | null {
    const cursor = this.#cursors.get(instrumentKey(reference));

    return cursor === undefined ? null : this.#now() - cursor.observedAtMs;
  }

  /**
   * Applies a frame's book onto the one already held. A frame that states a
   * side replaces it — including with an empty array, which is a real "this
   * side is now empty" and not an omission. A frame that omits it leaves it
   * alone.
   *
   * A gap wipes the held book first. Across a recovery epoch the market runtime
   * has re-derived its state, and across a long silence the depth the runner
   * remembers is not depth anybody can trade against.
   */
  #merge(
    key: string,
    payload: Readonly<Record<string, unknown>>,
    gapBefore: boolean,
  ): Book {
    const held = gapBefore ? EMPTY_BOOK : (this.#books.get(key) ?? EMPTY_BOOK);
    const book: Book = Object.freeze({
      bestBid: 'bids' in payload ? touch(payload.bids) : held.bestBid,
      bestAsk: 'asks' in payload ? touch(payload.asks) : held.bestAsk,
    });

    this.#books.set(key, book);

    return book;
  }
}
