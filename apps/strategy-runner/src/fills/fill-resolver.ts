import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { FillEvent } from '@moi/strategy-sdk/strategy';
import {
  applyFillToPosition,
  assertExactMoney,
  type DecimalString,
  type Market,
  moneyDecimal,
  type PositionCost,
  type Quantity,
  type Side,
} from '@moi/trading-core';
import type { StreamAccountEvent } from '../feed/stream-client.js';
import type { Reporter } from '../reporter.js';
import type { CommittedFill, FillJournal } from '../state/fill-journal.js';

/**
 * Turns an account event into the fills the strategy has not seen yet, and
 * works out what each of them realised.
 *
 * ## The event describes itself
 *
 * It did not always. Until `#43` the `ORDER_FILLED` payload was
 * `{orderId, status, filledQuantity, recoveryEpoch, recoveryFill}` — a
 * cumulative quantity and nothing priceable — so this class had to read
 * `GET /api/v1/portfolio` and walk `activeOrders[].fills`, bounded by the
 * quantity the event announced, to recover a price and a fee. That worked and
 * it was a workaround, and phase B was right to be uneasy about the shape of it.
 *
 * `#43` made the payload carry `fills: FillRecord[]` — id, order, market,
 * symbol, side, quantity, price, fee, and the `accountSequence` of the event
 * publishing them — built by the same `fillRecord` builder behind
 * `GET /api/v1/fills`. So the workaround is gone, and with it the bound walk,
 * the "the portfolio showed fewer fills than the event announced" self-heal,
 * and a portfolio round trip on every account event. What is left is a read of
 * the event and nothing else.
 *
 * That is not merely shorter. The old path took its numbers from a snapshot
 * captured at a *different instant* than the event and had to reason about the
 * difference; the payload is the fill as it was committed, in the transaction
 * that committed it.
 *
 * ## The portfolio is still needed, but only when the accounting is already wrong
 *
 * It is passed as a supplier and awaited on exactly one path: a sell whose
 * quantity exceeds the basis the runner has been tracking. On the ordinary path
 * an event costs no network read at all.
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
 * same judgement `StateStore.dailyEntryNotional` makes about the notional limit,
 * and it is the right one for a limit whose job is to stop this bot.
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

const key = (market: string, symbol: string): string => `${market}:${symbol}`;

const opening = (symbol: string): PositionCost =>
  Object.freeze({
    symbol,
    quantity: '0',
    totalCost: '0',
    realizedPnl: '0',
  });

/**
 * One fill off the wire. The payload is a network message, so every field is
 * read once into a frozen snapshot before anything acts on it — the same
 * treatment `readOrderIntent` gives a strategy's answer.
 *
 * `feeCurrency`, `isRecoveryFill`, `fillSequence` and `occurredAt` are on the
 * record and are deliberately not read. `fillSequence` is the cursor for
 * `GET /api/v1/fills`, which this runner does not page; the runner's cursor is
 * `accountSequence`, because that is what the stream replays from. Reading a
 * second cursor it does not advance would invite someone to believe it did.
 */
interface WireFill {
  readonly id: string;
  readonly orderId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: DecimalString;
  readonly fee: DecimalString;
  readonly accountSequence: string | null;
}

const WHOLE = /^(?:0|[1-9][0-9]*)$/u;

function text(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

function money(source: Record<string, unknown>, field: string): string | null {
  const value = text(source, field);

  if (value === null) {
    return null;
  }

  try {
    assertExactMoney(moneyDecimal(value), field);
  } catch {
    return null;
  }

  return value;
}

/** `null` when the entry is not a fill this runner can act on. */
function readWireFill(value: unknown): WireFill | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const id = text(source, 'id');
  const orderId = text(source, 'orderId');
  const symbol = text(source, 'symbol');
  const market = source.market;
  const side = source.side;
  const quantity = text(source, 'quantity');
  const price = money(source, 'price');
  const fee = money(source, 'fee');

  if (
    id === null ||
    orderId === null ||
    symbol === null ||
    (market !== 'KR' && market !== 'US') ||
    (side !== 'BUY' && side !== 'SELL') ||
    quantity === null ||
    !WHOLE.test(quantity) ||
    price === null ||
    fee === null
  ) {
    return null;
  }

  const accountSequence = text(source, 'accountSequence');

  return Object.freeze({
    id,
    orderId,
    market,
    symbol,
    side,
    quantity,
    price,
    fee,
    accountSequence,
  });
}

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

  /**
   * `portfolio` is a supplier, and it is awaited only when a sell exceeds the
   * basis the runner tracks. On every ordinary event it is not called.
   */
  async resolve(
    event: StreamAccountEvent,
    portfolio: () => Promise<BrokerPortfolio>,
  ): Promise<Resolution> {
    if (!isFillEvent(event.eventType)) {
      return EMPTY;
    }

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const entries = payload.fills;

    if (!Array.isArray(entries)) {
      // A fill event with no fills on it. Before `#43` every one looked like
      // this; after it, one does only if something upstream changed shape, and
      // the runner must not quietly carry on believing it saw the whole event.
      this.#reporter.report(
        'warn',
        'a fill event carried no fill records and could not be resolved',
        {
          accountSequence: event.accountSequence,
          eventType: event.eventType,
        },
      );

      return EMPTY;
    }

    const resolved: ResolvedFill[] = [];
    const positions = new Map<string, PositionCost>();

    for (const entry of entries) {
      const fill = readWireFill(entry);

      if (fill === null) {
        this.#reporter.report(
          'warn',
          'a fill record was malformed and was not applied',
          { accountSequence: event.accountSequence },
        );

        continue;
      }

      // The ledger allocates the sequence before the rows precisely so each
      // fill names the event publishing it. A mismatch means the payload was
      // assembled from two events, and attributing a fill to the wrong cursor
      // is how a replay loses one.
      if (
        fill.accountSequence !== null &&
        fill.accountSequence !== event.accountSequence
      ) {
        this.#reporter.report(
          'warn',
          'a fill record named a different account sequence than the event carrying it',
          {
            accountSequence: event.accountSequence,
            fillAccountSequence: fill.accountSequence,
            fillId: fill.id,
          },
        );

        continue;
      }

      if (this.#journal.hasFill(fill.id)) {
        continue;
      }

      const instrument = key(fill.market, fill.symbol);
      const before =
        positions.get(instrument) ??
        this.#journal.position(instrument) ??
        opening(fill.symbol);
      const after = await this.#apply(before, fill, instrument, portfolio);

      positions.set(instrument, after.position);
      resolved.push({
        event: Object.freeze({
          orderId: fill.orderId,
          fillId: fill.id,
          market: fill.market,
          symbol: fill.symbol,
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
          accountSequence: event.accountSequence,
        }),
        committed: Object.freeze({
          fillId: fill.id,
          orderId: fill.orderId,
          market: fill.market,
          symbol: fill.symbol,
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
          realizedDelta: after.realizedDelta,
        }),
      });
    }

    return Object.freeze({
      fills: Object.freeze(resolved),
      positions: Object.freeze(Object.fromEntries(positions)),
    });
  }

  async #apply(
    before: PositionCost,
    fill: WireFill,
    instrument: string,
    portfolio: () => Promise<BrokerPortfolio>,
  ): Promise<{
    readonly position: PositionCost;
    readonly realizedDelta: DecimalString;
  }> {
    try {
      const after = applyFillToPosition(before, {
        symbol: fill.symbol,
        side: fill.side,
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
        position: await this.#fromLedger(fill, portfolio, before),
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
  async #fromLedger(
    fill: WireFill,
    portfolio: () => Promise<BrokerPortfolio>,
    before: PositionCost,
  ): Promise<PositionCost> {
    const held = (await portfolio()).positions.find(
      (position) =>
        key(position.market, position.symbol) === key(fill.market, fill.symbol),
    );

    if (held === undefined) {
      return Object.freeze({
        ...opening(fill.symbol),
        realizedPnl: before.realizedPnl,
      });
    }

    return Object.freeze({
      symbol: fill.symbol,
      quantity: held.total,
      totalCost: assertExactMoney(
        moneyDecimal(held.averageCost).times(held.total),
        'rebased position cost',
      ).toString(),
      realizedPnl: before.realizedPnl,
    });
  }
}
