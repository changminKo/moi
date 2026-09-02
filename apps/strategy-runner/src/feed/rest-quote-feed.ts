import type { InstrumentRef, Tick } from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import type { Reporter } from '../reporter.js';
import type { PaperApiClient } from '../transport/paper-api-client.js';
import { instrumentKey, type QuoteTicker } from './quote-ticker.js';

export {
  type FeedCursors,
  type InstrumentCursor,
  instrumentKey,
} from './quote-ticker.js';

/**
 * The REST half of the market feed (design §5.1):
 * `GET /api/v1/markets/:m/symbols/:s/quote`, one read per instrument.
 *
 * In phase B this was the whole feed. In phase C it is the second path, and it
 * has two jobs the stream cannot do:
 *
 * - **Re-baseline after a reconnect.** §5.3: account events are replayed from
 *   `afterSequence`, quotes are not. A socket that comes back is a socket that
 *   knows nothing until the book next moves, and on a quiet instrument that can
 *   be minutes. One REST read per subscribed instrument puts a current price in
 *   front of the strategy immediately.
 * - **Cover an instrument the stream is not carrying.** A subscription the
 *   upgrade refused, or a symbol whose slot was empty when the socket opened.
 *
 * What it is *not* is a fallback the runner slides into silently. Configuration
 * that exceeds the subscription limit is refused at startup (§5.3), not quietly
 * demoted to polling.
 *
 * ## Why every tick here is a `rest-snapshot`, and none is a `book-mid`
 *
 * `GET …/quote` answers `projectQuote`, which has already decided the price —
 * last trade, then best ask, then best bid (spec §16.33). So does the stream
 * frame, from the same builder (`docs/api/quote-contract.md`). Deriving a
 * second price from the book in the same payload would mean the runner and the
 * paper API disagreed about what the instrument costs; the SDK's
 * `TickPriceSource` records that judgement and why §5.2's mid-price is not
 * built.
 *
 * ## Ordering, gaps and the shared cursor
 *
 * All three live in `QuoteTicker`, which this feed and the stream feed share
 * one of. That is what makes the reconnect re-baseline safe to run
 * unconditionally: an observation the stream already delivered does not become
 * a second tick because REST also saw it.
 */

export interface RestQuoteFeedOptions {
  readonly api: PaperApiClient;
  readonly instruments: readonly InstrumentRef[];
  readonly reporter: Reporter;
  /**
   * The cursor and gap judgement, shared with every other market-data path.
   * Phase B built its own from `gapAfterMs`; phase C hands one in, because two
   * paths with two cursors would tick the same observation twice.
   */
  readonly ticker: QuoteTicker;
}

export class RestQuoteFeed {
  readonly #api: PaperApiClient;
  readonly #instruments: readonly InstrumentRef[];
  readonly #reporter: Reporter;
  readonly #ticker: QuoteTicker;

  constructor(options: RestQuoteFeedOptions) {
    this.#api = options.api;
    this.#instruments = options.instruments;
    this.#reporter = options.reporter;
    this.#ticker = options.ticker;
  }

  /**
   * One pass over every configured instrument, newest observation each. A
   * failure on one instrument does not stop the others: they are independent
   * series, and a single symbol's outage should not blind the whole runner.
   */
  async poll(): Promise<readonly Tick[]> {
    return this.read(this.#instruments);
  }

  /** The same pass, over a named subset. What a reconnect re-baselines with. */
  async read(instruments: readonly InstrumentRef[]): Promise<readonly Tick[]> {
    const ticks: Tick[] = [];

    for (const reference of instruments) {
      try {
        const tick = await this.#readOne(reference);

        if (tick !== null) {
          ticks.push(tick);
        }
      } catch (error) {
        // Not recorded as an observation, so the elapsed-time clock keeps
        // running and a sustained outage becomes a gap on its own.
        this.#reporter.report('warn', 'a quote poll failed', {
          instrument: instrumentKey(reference),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Object.freeze(ticks);
  }

  async #readOne(reference: InstrumentRef): Promise<Tick | null> {
    const response = await this.#api.send({
      method: 'GET',
      path: `/api/v1/markets/${encodeURIComponent(reference.market)}/symbols/${encodeURIComponent(reference.symbol)}/quote`,
      // Public reference data: no session needed, and asking for one would make
      // the feed stop while a session is being re-established.
      authenticated: false,
    });

    if (response.status !== 200) {
      throw new DomainError(
        'SERVICE_UNAVAILABLE',
        `the quote endpoint answered ${response.status}`,
      );
    }

    return this.#ticker.observe(
      reference,
      (response.body ?? {}) as Record<string, unknown>,
      'rest-snapshot',
    );
  }
}
