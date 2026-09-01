import type { InstrumentRef, Tick } from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import type { Reporter } from '../reporter.js';
import type { PaperApiClient } from '../transport/paper-api-client.js';

/**
 * The market feed of design §5, in its phase-B shape: **REST only**.
 *
 * ## Why every tick here is a `rest-snapshot`
 *
 * §5.2 lets a tick's price be a book mid-price or a REST snapshot price, and
 * asks for the mid to be rounded to the market's tick unit with the mode named
 * in configuration. Phase B derives no mid at all, and therefore configures no
 * rounding.
 *
 * `GET /api/v1/markets/:m/symbols/:s/quote` answers `projectQuote`, which has
 * already decided the price — last trade, then best ask, then best bid
 * (spec §16.33). Deriving a second price from the book that the same payload
 * carries would mean the runner and the paper API disagreed about what the
 * instrument costs, and it would mean inventing a rounding mode in B that C
 * then rewrites when the real book frames arrive. So `priceSource` is
 * `'rest-snapshot'` throughout, the mid-price path lands with the WS
 * subscription in phase C, and `bestBid`/`bestAsk` are reported from the same
 * payload for a strategy that wants them.
 *
 * ## What a gap is
 *
 * §5.3 says quote frames are not replayed, so prices either side of a gap are
 * not consecutive observations and an average across one is an average over a
 * discontinuity. Phase A acts on that hard: a `gapBefore` tick discards the
 * whole window.
 *
 * That makes deciding *when* it is true consequential, and the obvious rule —
 * "the first tick after a restart is a gap" — is wrong in both directions. It
 * would discard the window `snapshot()`/`onStart` exists to restore, on every
 * restart, including a two-second container replacement at a one-second poll;
 * and it would say nothing about a runner that stayed up for ten minutes while
 * every poll failed.
 *
 * So a gap is measured in **time not observing**: `gapBefore` is true when more
 * than `gapAfterMs` has passed since the last poll that actually saw this
 * instrument. One rule covers the first run, a restart, a poll outage, and an
 * API that was down — because all four are the same fact, which is that the
 * runner was not watching. A `recoveryEpoch` advance is a gap regardless of
 * time: the market runtime has re-derived its state, and versions before and
 * after it are not one series.
 *
 * Note what updates the clock: a poll that saw the instrument, whether or not
 * the price moved. A quiet market is being observed continuously even though it
 * produces no ticks, and treating a calm hour as a discontinuity would reset
 * every window for no reason.
 *
 * ## One observation, one tick
 *
 * A frame is emitted only when `(recoveryEpoch, marketDataVersion)` strictly
 * advances. §5.2 requires a frame that goes backwards to be dropped; an
 * unchanged one is dropped for a related reason — it is the same observation,
 * and feeding it to a strategy again would put one price into the window twice
 * and pull both averages towards it. The window is a series of distinct
 * observations, not a sampling of the clock.
 */

export interface InstrumentCursor {
  readonly recoveryEpoch: string;
  readonly marketDataVersion: string;
  /** When the runner last *saw* this instrument, epoch milliseconds. */
  readonly observedAtMs: number;
}

export type FeedCursors = Readonly<Record<string, InstrumentCursor>>;

export interface RestQuoteFeedOptions {
  readonly api: PaperApiClient;
  readonly instruments: readonly InstrumentRef[];
  readonly gapAfterMs: number;
  readonly reporter: Reporter;
  readonly now?: () => number;
  readonly cursors?: FeedCursors;
}

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

/** The touch of a book side, or `null` when the payload carries no book. */
function touch(levels: unknown): string | null {
  if (!Array.isArray(levels) || levels.length === 0) {
    return null;
  }

  const price = (levels[0] as { price?: unknown }).price;

  return typeof price === 'string' && price.length > 0 ? price : null;
}

export class RestQuoteFeed {
  readonly #api: PaperApiClient;
  readonly #instruments: readonly InstrumentRef[];
  readonly #gapAfterMs: number;
  readonly #reporter: Reporter;
  readonly #now: () => number;
  readonly #cursors = new Map<string, InstrumentCursor>();

  constructor(options: RestQuoteFeedOptions) {
    this.#api = options.api;
    this.#instruments = options.instruments;
    this.#gapAfterMs = options.gapAfterMs;
    this.#reporter = options.reporter;
    this.#now = options.now ?? Date.now;

    for (const [key, cursor] of Object.entries(options.cursors ?? {})) {
      this.#cursors.set(key, cursor);
    }
  }

  /** The cursors to persist, so a restart can tell a short break from a gap. */
  cursors(): FeedCursors {
    return Object.freeze(Object.fromEntries(this.#cursors));
  }

  /**
   * One pass over every configured instrument, newest observation each. A
   * failure on one instrument does not stop the others: they are independent
   * series, and a single symbol's outage should not blind the whole runner.
   */
  async poll(): Promise<readonly Tick[]> {
    const ticks: Tick[] = [];

    for (const reference of this.#instruments) {
      try {
        const tick = await this.#pollOne(reference);

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

  async #pollOne(reference: InstrumentRef): Promise<Tick | null> {
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

    const payload = (response.body ?? {}) as Record<string, unknown>;
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

    this.#cursors.set(key, cursor);

    if (gapBefore && previous !== undefined) {
      this.#reporter.report('warn', 'a market-data gap was observed', {
        instrument: key,
        sinceMs: at - previous.observedAtMs,
        recoveryEpoch: cursor.recoveryEpoch,
      });
    }

    return Object.freeze({
      market: reference.market,
      symbol: reference.symbol,
      price,
      priceSource: 'rest-snapshot' as const,
      bestBid: touch(payload.bids),
      bestAsk: touch(payload.asks),
      // The runner's receive time, as `Tick.asOf` documents. The payload's own
      // `asOf` is the instant the API projected the quote, which is a different
      // fact and not the one this field names.
      asOf: new Date(at).toISOString(),
      marketDataVersion: cursor.marketDataVersion,
      gapBefore,
    });
  }
}
