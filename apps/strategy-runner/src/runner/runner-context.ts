import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type {
  InstrumentRef,
  StrategyContext,
  StrategyPosition,
  Tick,
} from '@moi/strategy-sdk/strategy';
import { instrumentKey } from '../feed/rest-quote-feed.js';

/**
 * The whole of what a strategy may ask about the world (SDK `StrategyContext`).
 *
 * `position` comes from the ledger's own portfolio snapshot, never from an
 * accumulation of fills: design §7.3 makes the ledger the original of that fact
 * and the bot's state a cache, and the SDK's own contract says so at length.
 * What is projected is deliberately smaller than `BrokerPosition` — the strategy
 * type is not the wire type, so a change to the payload does not change the
 * strategy contract.
 *
 * `window` is a shared recent-tick view, kept short. Its length is the runner's
 * choice and a strategy that needs a specific number of consecutive prices keeps
 * its own in `snapshot()`, which is also the only window that survives a
 * restart. This one is a convenience for reporting and for a future strategy
 * that wants a glance backwards, not a substitute for that.
 */

export const WINDOW_LENGTH = 128;

export class RunnerContext implements StrategyContext {
  readonly #now: () => number;
  readonly #windows = new Map<string, Tick[]>();
  #portfolio: BrokerPortfolio | null = null;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  now(): string {
    return new Date(this.#now()).toISOString();
  }

  observePortfolio(portfolio: BrokerPortfolio): void {
    this.#portfolio = portfolio;
  }

  observeTick(tick: Tick): void {
    const key = instrumentKey(tick);
    const window = this.#windows.get(key) ?? [];

    // A gap makes the earlier prices non-consecutive with this one, so the
    // shared window is reset too. A strategy reading it after a gap would
    // otherwise see a series the market never traded — the same reasoning phase
    // A applies to its own ring.
    const kept = tick.gapBefore ? [] : window;

    kept.push(tick);
    this.#windows.set(key, kept.slice(-WINDOW_LENGTH));
  }

  position(instrument: InstrumentRef): StrategyPosition | null {
    const key = instrumentKey(instrument);
    const found = this.#portfolio?.positions.find(
      (position) => instrumentKey(position) === key,
    );

    return found === undefined
      ? null
      : Object.freeze({
          market: found.market,
          symbol: found.symbol,
          total: found.total,
          available: found.available,
          averageCost: found.averageCost,
        });
  }

  window(instrument: InstrumentRef): readonly Tick[] {
    return Object.freeze([
      ...(this.#windows.get(instrumentKey(instrument)) ?? []),
    ]);
  }
}
