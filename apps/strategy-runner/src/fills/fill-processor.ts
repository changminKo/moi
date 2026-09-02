import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { StrategyContext } from '@moi/strategy-sdk/strategy';
import { instrumentKey } from '../feed/quote-ticker.js';
import type { StreamAccountEvent } from '../feed/stream-client.js';
import type { OrderGateway } from '../gateway/order-gateway.js';
import type { Reporter } from '../reporter.js';
import type { StrategyHost } from '../runner/strategy-host.js';
import type { FillCommit } from '../state/fill-journal.js';
import type { DecisionRecord, StateStore } from '../state/state-store.js';
import { FillResolver } from './fill-resolver.js';

/**
 * One account event, processed exactly once (design §6.4).
 *
 * ## The five steps, and what a crash between any two of them leaves
 *
 * 1. **Skip what is already committed.** The journal's cursor and its `eventId`
 *    index answer this, and both come from the same records, so they cannot
 *    disagree. This is what makes a stream replay free: the server replays from
 *    `afterSequence`, and anything it re-sends that the runner already committed
 *    is dropped here before a strategy sees it.
 * 2. **Resolve the fills** off the event itself (`FillResolver`). Since `#43`
 *    the `ORDER_FILLED` payload carries priceable fill records, so this reads
 *    the event and, on the ordinary path, touches the network not at all.
 *    Nothing durable happens; a crash here leaves the cursor where it was.
 * 3. **Ask the strategy.** `onFill` is synchronous and pure, and each decision
 *    it returns takes a `decisionId` derived from
 *    `(accountSequence, strategy, index)` rather than a fresh UUID.
 * 4. **Record those decisions durably**, through `StateStore.appendDecision`,
 *    which is idempotent by `decisionId`.
 * 5. **Commit** — one durable line carrying the fills, the positions, the
 *    decision ids and the new cursor — and only then submit.
 *
 * A crash **between 4 and 5** leaves decisions on disk that the cursor does not
 * know about. The next start replays the event, step 3 recomputes the *same*
 * ids, step 4 recognises them and writes nothing, and step 5 commits. Nothing
 * is duplicated and nothing is lost. Better still, the decision was already
 * pending, so `OrderGateway.recoverPending` would have submitted it at startup
 * even if the replay never happened — the two paths converge on one order
 * because they converge on one `decisionId`.
 *
 * A crash **after 5, before submitting** leaves a committed event whose
 * decisions are recorded and unsettled — exactly the state phase B's
 * `recoverPending` was built for.
 *
 * A crash **during 5** leaves a torn trailing line, which `readAppendLog`
 * discards, which is the same as a crash before 5.
 *
 * ## Why the submission is outside the commit
 *
 * Because it has to be: submitting is a network call, and no ordering of a
 * local file and a remote effect makes them one atomic act. What can be
 * arranged is which side of the ledger's own idempotency the runner falls on,
 * and recording first (§6.2) puts it on the safe side — a resubmission replays
 * an order, a re-decision doubles a position.
 */

/**
 * The id a decision derived from a fill takes. Deterministic on purpose: it is
 * the entire reason an uncommitted step can be replayed without placing a
 * second order, because `deriveIdempotencyKey` is a pure function of it.
 */
export const fillDecisionId = (
  accountSequence: string,
  strategy: string,
  index: number,
): string => `fill:${accountSequence}:${strategy}:${index}`;

export interface FillProcessorOptions {
  readonly state: StateStore;
  readonly gateway: OrderGateway;
  readonly reporter: Reporter;
  readonly context: StrategyContext;
  /** The strategy that owns each instrument, keyed `MARKET:SYMBOL` (§6.3). */
  readonly owner: ReadonlyMap<string, StrategyHost>;
  /**
   * The ledger's own view. A supplier, and read lazily: since `#43` the happy
   * path resolves a fill entirely from the event, and the portfolio is needed
   * only to re-base a position whose basis the runner never saw, or to find the
   * cursor to adopt at a resync.
   */
  readonly portfolio: () => Promise<BrokerPortfolio>;
  readonly now?: () => number;
}

export class FillProcessor {
  readonly #options: FillProcessorOptions;
  readonly #resolver: FillResolver;
  readonly #now: () => number;

  constructor(options: FillProcessorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#resolver = new FillResolver({
      journal: options.state.fills,
      reporter: options.reporter,
    });
  }

  /** The committed cursor the next stream connect replays from. */
  cursor(): string | null {
    return this.#options.state.fills.cursor;
  }

  async process(event: StreamAccountEvent): Promise<void> {
    const journal = this.#options.state.fills;
    const cursor = journal.cursor;

    if (
      journal.hasEvent(event.eventId) ||
      (cursor !== null && BigInt(event.accountSequence) <= BigInt(cursor))
    ) {
      // A replay of something already committed. The server replays from
      // `afterSequence` on every connect, so this is the ordinary path, not an
      // anomaly, and it is deliberately silent.
      return;
    }

    // Memoised for the span of one event: the two paths that need it must not
    // read two different snapshots, and the ordinary path reads none.
    let snapshot: Promise<BrokerPortfolio> | null = null;
    const portfolio = (): Promise<BrokerPortfolio> => {
      snapshot ??= this.#options.portfolio();

      return snapshot;
    };
    const resolution = await this.#resolver.resolve(event, portfolio);
    const decisions: DecisionRecord[] = [];

    for (const { event: fill } of resolution.fills) {
      const host = this.#options.owner.get(instrumentKey(fill));

      if (host === undefined) {
        // A fill on an instrument no configured strategy owns. It still counts
        // towards realised PnL — it is the account's money either way — and
        // there is nobody to ask what to do about it.
        continue;
      }

      for (const [index, decision] of host
        .onFill(fill, this.#options.context)
        .entries()) {
        const record = this.#options.gateway.record(
          host.name,
          decision,
          // There is no tick here — the decision came from an execution, not
          // from an observation — and `record()` reads this only to price the
          // order through `notionalOf`. The fill's own price is the right
          // number for that: a `MARKET` order sized against the last *quote*
          // would be measured against something older than the execution that
          // prompted it, and a priced order ignores this field entirely.
          //
          // `priceSource` is the one field here that cannot tell the truth. The
          // SDK's union names market-data paths and a fill is not one, and
          // adding a member for an object that never reaches a strategy would
          // put a case in every consumer's switch for a value none of them can
          // ever see. It is unread on this path; the honest statement is this
          // comment rather than a fourth enum member.
          {
            market: fill.market,
            symbol: fill.symbol,
            price: fill.price,
            priceSource: 'rest-snapshot',
            bestBid: null,
            bestAsk: null,
            asOf: new Date(this.#now()).toISOString(),
            marketDataVersion: '0',
            gapBefore: false,
          },
          {
            decisionId: fillDecisionId(event.accountSequence, host.name, index),
          },
        );

        if (record !== null) {
          decisions.push(record);
        }
      }
    }

    const commit: FillCommit = {
      accountSequence: event.accountSequence,
      at: new Date(this.#now()).toISOString(),
      eventId: event.eventId,
      eventType: event.eventType,
      fills: resolution.fills.map((each) => each.committed),
      positions: resolution.positions,
      decisions: decisions.map((each) => each.decisionId),
    };

    journal.commit(commit);

    for (const fill of resolution.fills) {
      this.#options.reporter.report('info', 'a fill was applied', {
        instrument: instrumentKey(fill.event),
        side: fill.event.side,
        quantity: fill.event.quantity,
        price: fill.event.price,
        realized: fill.committed.realizedDelta,
        accountSequence: event.accountSequence,
      });
    }

    for (const record of decisions) {
      await this.#options.gateway.submit(record);
    }
  }

  /**
   * The server refused the replay the runner asked for: events between the
   * committed cursor and now will never arrive. The cursor is moved to the
   * ledger's own `accountSequence` and the jump is written down as such, so
   * every realised-PnL number after it is visibly measured over a series with a
   * hole in it rather than silently wrong.
   */
  async resync(reason: string): Promise<void> {
    const portfolio = await this.#options.portfolio();
    const journal = this.#options.state.fills;
    const from = journal.cursor;

    if (from !== null && BigInt(portfolio.accountSequence) <= BigInt(from)) {
      // Nothing to skip. The server refused for some other reason and the
      // runner's cursor is not the thing that is behind.
      this.#options.reporter.report(
        'warn',
        'a resync was demanded but the ledger is not ahead of the committed cursor',
        { reason, cursor: from },
      );

      return;
    }

    journal.commit({
      accountSequence: portfolio.accountSequence,
      at: new Date(this.#now()).toISOString(),
      eventId: `resync:${portfolio.accountSequence}`,
      eventType: 'RESYNC',
      fills: [],
      positions: {},
      decisions: [],
      resync: reason,
    });
    this.#options.reporter.report(
      'error',
      'the account cursor was advanced over events that were never delivered; realised PnL from here is measured over an incomplete series',
      {
        reason,
        from: from ?? 'none',
        to: portfolio.accountSequence,
      },
    );
  }
}
