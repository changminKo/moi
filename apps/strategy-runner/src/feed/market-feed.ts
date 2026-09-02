import type { InstrumentRef, Tick } from '@moi/strategy-sdk/strategy';
import type { Reporter } from '../reporter.js';
import { instrumentKey, type QuoteTicker } from './quote-ticker.js';
import type { RestQuoteFeed } from './rest-quote-feed.js';
import type { StreamClient } from './stream-client.js';

/**
 * The market feed of design §5, whole: a stream subscription for the
 * observations, a REST read for the ones the stream cannot give, and one
 * `QuoteTicker` so the two cannot deliver the same observation twice.
 *
 * ## The stream observes, the cycle decides
 *
 * Quote frames arrive whenever the book moves; the runner's cycle turns
 * observations into decisions on its own schedule. So frames are turned into
 * ticks as they arrive — the cursor and the merged book have to advance in
 * arrival order — and queued for the next `drain()`.
 *
 * The strategy therefore sees **every** observation, in order, rather than the
 * sample a poll takes, and pays up to one `pollIntervalMs` of latency for it.
 * That trade is the honest one for this runner: the decision path already reads
 * the portfolio once per cycle and puts every decision through a risk gate that
 * reads a market session, so shaving the queue delay would not make the runner
 * meaningfully faster, and draining a batch keeps a burst of book updates from
 * becoming a burst of portfolio reads.
 *
 * ## What REST is for, now that there is a stream
 *
 * Two things, and neither is a silent fallback.
 *
 * **Re-baselining a connection.** §5.3: account events are replayed from
 * `afterSequence`; quotes are not. A socket that comes back knows nothing until
 * the book next moves, which on a quiet instrument can be minutes. Every
 * established connection therefore reads each subscribed instrument once.
 *
 * **Keeping the risk gate's freshness rule answerable.** §6.3 refuses an entry
 * on a tick older than `maxQuoteAgeMs`. An instrument whose book has not moved
 * for that long is not a fault, but it does leave the gate with nothing recent
 * to judge on, so the feed re-reads an instrument once its last observation is
 * older than half that limit. Half, and derived from the limit the operator
 * already set, rather than a new knob: the value that matters is the one the
 * gate enforces, and a refresh interval configured separately from it is a
 * second place for the two to disagree.
 *
 * ## What a gap backfill can and cannot do
 *
 * It cannot backfill. There is no historical-quote endpoint — design §8.4 says
 * so, and the Toss contract's candles have no adapter behind them — so the REST
 * read after an outage restores the *level*, not the series. The prices the
 * market traded through while the socket was down are simply not available to
 * anyone, and inventing them by interpolation would put fabricated observations
 * into an average a strategy trades on.
 *
 * So the re-baseline is a re-baseline. When the outage was long enough for
 * `QuoteTicker` to call it a gap, the stitched tick carries `gapBefore`, phase
 * A discards the ring, and the strategy withholds entries for `slowPeriod + 1`
 * ticks while a real series rebuilds. What the REST read buys is that those
 * ticks start arriving immediately instead of whenever the book next moves.
 */

/** The share of `maxQuoteAgeMs` after which an unobserved instrument is re-read. */
export const REFRESH_AT_AGE_FRACTION = 0.5;

export interface MarketFeedOptions {
  readonly instruments: readonly InstrumentRef[];
  readonly ticker: QuoteTicker;
  readonly rest: RestQuoteFeed;
  readonly stream: StreamClient;
  readonly reporter: Reporter;
  /** The risk gate's own freshness limit (§6.3). */
  readonly maxQuoteAgeMs: number;
}

export class MarketFeed {
  readonly #options: MarketFeedOptions;
  #queue: Tick[] = [];

  constructor(options: MarketFeedOptions) {
    this.#options = options;
  }

  /** Turns a `quote` frame into a tick, now, and queues it for the next drain. */
  observeFrame(
    market: string,
    symbol: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const reference = this.#options.instruments.find(
      (each) => each.market === market && each.symbol === symbol,
    );

    if (reference === undefined) {
      // A symbol the runner did not subscribe to. The server does not send one,
      // and acting on it would mean trading an instrument no strategy owns.
      return;
    }

    try {
      const tick = this.#options.ticker.observe(
        reference,
        payload,
        'stream-quote',
      );

      if (tick !== null) {
        this.#queue.push(tick);
      }
    } catch (error) {
      this.#options.reporter.report('warn', 'a quote frame could not be read', {
        instrument: instrumentKey(reference),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Every subscribed instrument, read from REST. What a new connection does. */
  async rebaseline(): Promise<void> {
    this.#enqueue(await this.#options.rest.read(this.#options.instruments));
  }

  /**
   * The ticks observed since the last drain, oldest first — with a REST read
   * first for any instrument that has gone quiet long enough to trouble the
   * freshness rule.
   */
  async drain(): Promise<readonly Tick[]> {
    this.#enqueue(await this.#options.rest.read(this.#stale()));

    const ticks = this.#queue;

    this.#queue = [];

    return Object.freeze(ticks);
  }

  #stale(): readonly InstrumentRef[] {
    const limit = this.#options.maxQuoteAgeMs * REFRESH_AT_AGE_FRACTION;

    return this.#options.instruments.filter((reference) => {
      const since = this.#options.ticker.sinceObservedMs(reference);

      // Never observed: read it. That is the first cycle of a fresh runner, and
      // waiting for the book to move would leave the strategy with no series at
      // all on an instrument nobody is trading.
      return since === null || since > limit;
    });
  }

  #enqueue(ticks: readonly Tick[]): void {
    for (const tick of ticks) {
      this.#queue.push(tick);
    }
  }
}
