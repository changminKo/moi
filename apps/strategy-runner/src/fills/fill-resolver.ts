import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { FillEvent } from '@moi/strategy-sdk/strategy';
import {
  applyFillToPosition,
  assertExactMoney,
  type DecimalString,
  moneyDecimal,
  type PositionCost,
} from '@moi/trading-core';
import type { StreamAccountEvent } from '../feed/stream-client.js';
import type { Reporter } from '../reporter.js';
import type { CommittedFill, FillJournal } from '../state/fill-journal.js';

/**
 * Turns an account event into the fills the strategy has not seen yet, and
 * works out what each of them realised.
 *
 * ## Why an event is not enough on its own
 *
 * Design §6.4 says "fills arrive as account events", and they nearly do. What
 * the outbox actually carries for a fill (`runtime/fill-persistence.ts`) is
 *
 * ```json
 * { "orderId": …, "status": …, "filledQuantity": …, "recoveryEpoch": …, "recoveryFill": … }
 * ```
 *
 * — the order's *cumulative* filled quantity, and no price, no fee, no fill id.
 * The SDK's `FillEvent` needs all three, and realised PnL cannot be computed
 * without price and fee at all. So the event is the **trigger and the
 * ordering**, and the detail comes from `GET /api/v1/portfolio`, whose
 * `activeOrders[].fills` the SDK already documents as "currently the only path
 * by which a client can reach fill data".
 *
 * That is *not* the cursorless fill path phase B warned against. The distinction
 * is which side decides that a fill happened: nothing here is emitted unless an
 * account event at a known `accountSequence` announced it, and every fill is
 * committed with that sequence. The portfolio is consulted for fields, never for
 * existence.
 *
 * ## Bounded by the quantity the event announced
 *
 * The portfolio is read *after* the event, so it can already hold fills from a
 * later event that has not been processed yet. Emitting those would attribute a
 * fill to the wrong sequence and let the cursor claim work it had not done. So
 * the order's fills are walked oldest first and stop once the running quantity
 * reaches the `filledQuantity` this event announced.
 *
 * The bound is also what makes a short read self-heal. If the portfolio somehow
 * shows fewer fills than the event claims, the next event for the same order
 * carries a larger cumulative quantity, and the fills missed the first time are
 * inside the new bound and not yet in the journal — so they are emitted then.
 *
 * ## Realised PnL is the ledger's own arithmetic
 *
 * Every fill goes through `applyFillToPosition` from `@moi/trading-core` — the
 * function the ledger itself uses, with the same weighted-cost division and the
 * same fee treatment (a buy's fee joins the cost basis, a sell's comes off the
 * proceeds). `realizedDelta` is the movement in that function's own
 * `realizedPnl`. There is no second accounting here to disagree with the first
 * (AGENTS.md rule 5).
 *
 * The basis starts at zero at the first fill the runner commits, so realised PnL
 * measures **the bot's own trading**, not the account's history. That is the
 * same judgement `StateStore.dailyNotional` makes about the notional limit, and
 * it is the right one for a limit whose job is to stop this bot.
 *
 * When the ledger holds a position the runner never saw itself acquire — a
 * session with holdings from before the bot, or one whose events it had to skip
 * at a resync — a sell can exceed the basis. `applyFillToPosition` refuses that,
 * correctly. The fill is then recorded realising nothing, the basis is reset
 * from the ledger's own `averageCost`, and it is reported at `error`: the PnL
 * series has a hole in it and a limit computed over it is not trustworthy until
 * a person looks. Guessing a number would hide that.
 */

export interface ResolvedFill {
  /** What `onFill` is handed. */
  readonly event: FillEvent;
  /** What the journal records in the same line as the cursor. */
  readonly committed: CommittedFill;
}

export interface Resolution {
  readonly fills: readonly ResolvedFill[];
  /** Every position the fills moved, after applying them. Keyed `MARKET:SYMBOL`. */
  readonly positions: Readonly<Record<string, PositionCost>>;
}

const EMPTY: Resolution = Object.freeze({
  fills: Object.freeze([]),
  positions: Object.freeze({}),
});

/** Account events that announce a fill. Everything else only moves the cursor. */
const FILL_EVENTS: ReadonlySet<string> = new Set([
  'ORDER_FILLED',
  'ORDER_PARTIALLY_FILLED',
]);

export const isFillEvent = (eventType: string): boolean =>
  FILL_EVENTS.has(eventType);

type PortfolioOrder = BrokerPortfolio['activeOrders'][number];

const key = (market: string, symbol: string): string => `${market}:${symbol}`;

const opening = (symbol: string): PositionCost =>
  Object.freeze({
    symbol,
    quantity: '0',
    totalCost: '0',
    realizedPnl: '0',
  });

export interface FillResolverOptions {
  readonly journal: FillJournal;
  readonly reporter: Reporter;
}

export class FillResolver {
  readonly #journal: FillJournal;
  readonly #reporter: Reporter;

  constructor(options: FillResolverOptions) {
    this.#journal = options.journal;
    this.#reporter = options.reporter;
  }

  resolve(event: StreamAccountEvent, portfolio: BrokerPortfolio): Resolution {
    if (!isFillEvent(event.eventType)) {
      return EMPTY;
    }

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const orderId = payload.orderId;

    if (typeof orderId !== 'string' || orderId.length === 0) {
      this.#reporter.report(
        'warn',
        'a fill event named no order and could not be resolved',
        { accountSequence: event.accountSequence, eventType: event.eventType },
      );

      return EMPTY;
    }

    const order = portfolio.activeOrders.find((each) => each.id === orderId);

    if (order === undefined) {
      this.#reporter.report(
        'warn',
        'a fill event named an order the portfolio does not list',
        { accountSequence: event.accountSequence, orderId },
      );

      return EMPTY;
    }

    return this.#walk(event, order, portfolio, this.#bound(payload, order));
  }

  /**
   * How much of this order the event says is filled. The event's own
   * `filledQuantity` when it stated one; the order's otherwise, which is the
   * honest fallback — the portfolio was read after the event, so the order's
   * own cumulative quantity is at least as new as the event's.
   */
  #bound(
    payload: Readonly<Record<string, unknown>>,
    order: PortfolioOrder,
  ): bigint {
    const announced = payload.filledQuantity;

    if (typeof announced === 'string' && /^[0-9]+$/u.test(announced)) {
      return BigInt(announced);
    }

    return BigInt(order.filledQuantity);
  }

  #walk(
    event: StreamAccountEvent,
    order: PortfolioOrder,
    portfolio: BrokerPortfolio,
    bound: bigint,
  ): Resolution {
    const resolved: ResolvedFill[] = [];
    const positions = new Map<string, PositionCost>();
    const instrument = key(order.market, order.symbol);
    let running = 0n;

    for (const fill of order.fills) {
      const quantity = BigInt(fill.quantity);

      // Past what this event announced: it belongs to a later sequence, and
      // claiming it here would attribute a fill to a cursor that had not
      // reached it.
      if (running + quantity > bound) {
        break;
      }

      running += quantity;

      if (this.#journal.hasFill(fill.id)) {
        continue;
      }

      const before =
        positions.get(instrument) ??
        this.#journal.position(instrument) ??
        opening(order.symbol);
      const after = this.#apply(before, order, fill, portfolio, instrument);

      positions.set(instrument, after.position);
      resolved.push({
        event: Object.freeze({
          orderId: order.id,
          fillId: fill.id,
          market: order.market,
          symbol: order.symbol,
          side: order.side,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
          accountSequence: event.accountSequence,
        }),
        committed: Object.freeze({
          fillId: fill.id,
          orderId: order.id,
          market: order.market,
          symbol: order.symbol,
          side: order.side,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
          realizedDelta: after.realizedDelta,
        }),
      });
    }

    if (running < bound) {
      this.#reporter.report(
        'warn',
        'the portfolio showed fewer fills than the event announced; the rest will resolve on the next event for this order',
        {
          orderId: order.id,
          accountSequence: event.accountSequence,
          seen: running.toString(),
          announced: bound.toString(),
        },
      );
    }

    return Object.freeze({
      fills: Object.freeze(resolved),
      positions: Object.freeze(Object.fromEntries(positions)),
    });
  }

  #apply(
    before: PositionCost,
    order: PortfolioOrder,
    fill: PortfolioOrder['fills'][number],
    portfolio: BrokerPortfolio,
    instrument: string,
  ): {
    readonly position: PositionCost;
    readonly realizedDelta: DecimalString;
  } {
    try {
      const after = applyFillToPosition(before, {
        symbol: order.symbol,
        side: order.side,
        price: fill.price,
        quantity: fill.quantity,
        fee: fill.fee,
      });

      return {
        position: after,
        realizedDelta: assertExactMoney(
          moneyDecimal(after.realizedPnl).minus(before.realizedPnl),
          'realised delta',
        ).toString(),
      };
    } catch (error) {
      // The basis the runner kept does not cover this sell. It is not a
      // question the runner can answer — the missing cost was incurred before
      // it was watching — so it says so and re-bases from the ledger rather
      // than inventing a number that a loss limit would then act on.
      this.#reporter.report(
        'error',
        'a fill could not be applied to the position the runner was tracking; realised PnL is discontinuous from here and the basis has been re-read from the ledger',
        {
          instrument,
          fillId: fill.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );

      return {
        position: this.#fromLedger(order, portfolio, before),
        realizedDelta: '0',
      };
    }
  }

  /**
   * The ledger's own view of the basis: quantity and average cost, multiplied
   * back into a total. The product is not necessarily the ledger's exact
   * `totalCost` — `calculateAverageCost` rounds its division to ten places —
   * and this is a recovery from a state that was already wrong, so the residue
   * is smaller than the hole it is patching and is reported alongside it.
   */
  #fromLedger(
    order: PortfolioOrder,
    portfolio: BrokerPortfolio,
    before: PositionCost,
  ): PositionCost {
    const held = portfolio.positions.find(
      (position) =>
        key(position.market, position.symbol) ===
        key(order.market, order.symbol),
    );

    if (held === undefined) {
      return Object.freeze({
        ...opening(order.symbol),
        realizedPnl: before.realizedPnl,
      });
    }

    return Object.freeze({
      symbol: order.symbol,
      quantity: held.total,
      totalCost: assertExactMoney(
        moneyDecimal(held.averageCost).times(held.total),
        'rebased position cost',
      ).toString(),
      realizedPnl: before.realizedPnl,
    });
  }
}
