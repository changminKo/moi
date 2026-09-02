import {
  applyFillToPosition,
  assertExactMoney,
  type DecimalString,
  moneyDecimal,
  type PositionCost,
} from '@moi/trading-core';
import type { Decimal } from 'decimal.js';
import { asCurrency, CURRENCIES, type Currency } from '../../lib/currency';

/**
 * Realized profit and loss, folded on the client from the session's fills.
 *
 * ## Why the client computes it
 *
 * The ledger does not keep a realized figure: `positions` holds quantities
 * and `average_cost`, and `fill-settlement.ts` feeds `realizedPnl: '0'` into
 * every settlement. What it *does* publish is every fill the session ever
 * had — the portfolio snapshot's `activeOrders` is every order (spec §16.32),
 * each carrying its `fills` as the same `FillRecord` that `GET /api/v1/fills`
 * answers (§16.45): side, price, fee, currency and `fillSequence`. That is
 * exactly the input `applyFillToPosition` needs, and the fold is the same one
 * the strategy runner's `fill-journal.ts` performs. This module uses the
 * core's arithmetic rather than restating it (AGENTS.md rule 5).
 *
 * ## Ordering
 *
 * Fills are sorted by `fillSequence`, never by array position: `activeOrders`
 * is ordered by order creation, so a sell placed *after* a buy can be listed
 * before it when the buy was placed earlier and filled later. Within a
 * session `fillSequence` is assigned in commit order (§16.37), which is the
 * order the ledger itself applied the fills in.
 *
 * ## Keying
 *
 * Positions are keyed by `(market, symbol)`, as the ledger keys them
 * (`unique (session_id, market_code, symbol)`), never by symbol alone: the
 * same ticker on two markets settles in two currencies and is two positions.
 * `realizedKey` is the one place the composite key is spelled.
 *
 * ## Failure shape
 *
 * A position whose rows cannot be folded — a field missing or unreadable, a
 * sell larger than what was held, fills that disagree about their currency —
 * is reported in `unavailable` with the reason, and left out of `byPosition`
 * and `totals`. The other positions are unaffected. Nothing here throws:
 * this runs on the render path of a page with no error boundary (#73), and a
 * dash beside one row is the right size of failure for one bad row. The
 * reason is kept rather than swallowed so the cell can say it and a reader
 * can tell a data fault from a coding one.
 *
 * ## Precision caveat (#81)
 *
 * The ledger's `average_cost` is rebuilt each fill from the *rounded* average
 * it already stored, while this fold keeps `totalCost` exact and rounds only
 * the weighted cost removed by each sale. The two drift by ~1e-8 after tens
 * of irregular partial fills; the display caps at two places, so it does not
 * show, but the figure here is not guaranteed bit-identical to what the
 * ledger would say if it kept one.
 */

export interface RealizedPnlEntry {
  readonly realizedPnl: DecimalString;
  readonly currency: Currency;
}

export interface RealizedPnlTotal {
  readonly currency: Currency;
  readonly realizedPnl: DecimalString;
}

export interface RealizedPnlReport {
  /** Keyed by `realizedKey(market, symbol)`. */
  readonly byPosition: ReadonlyMap<string, RealizedPnlEntry>;
  /** One row per currency any folded position settled in; KRW first. */
  readonly totals: readonly RealizedPnlTotal[];
  /** `realizedKey` → why that position could not be folded. */
  readonly unavailable: ReadonlyMap<string, string>;
}

/** The composite position key; U+0000 cannot occur in a market or symbol. */
export const realizedKey = (market: string, symbol: string): string =>
  `${market}\u0000${symbol}`;

type Row = Readonly<Record<string, unknown>>;

interface OrderedFill {
  readonly sequence: bigint;
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly quantity: string;
  readonly fee: string;
  readonly currency: Currency;
}

const FILL_SEQUENCE = /^\d{1,19}$/;
const emptyPosition = (symbol: string): PositionCost => ({
  symbol,
  quantity: '0',
  totalCost: '0',
  realizedPnl: '0',
});

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The fields the fold needs; throws naming the first one that is unusable. */
function readFill(row: Row): OrderedFill {
  const sequence = text(row.fillSequence);
  if (sequence === undefined || !FILL_SEQUENCE.test(sequence))
    throw new Error('fill has no readable fillSequence');
  const side = row.side;
  if (side !== 'BUY' && side !== 'SELL')
    throw new Error('fill has no readable side');
  const price = text(row.price);
  if (price === undefined) throw new Error('fill has no readable price');
  const quantity = text(row.quantity);
  if (quantity === undefined) throw new Error('fill has no readable quantity');
  const fee = text(row.fee);
  if (fee === undefined) throw new Error('fill has no readable fee');
  const currency = asCurrency(row.currency);
  if (currency === undefined) throw new Error('fill has no known currency');
  return { sequence: BigInt(sequence), side, price, quantity, fee, currency };
}

interface Group {
  readonly market: string;
  readonly symbol: string;
  readonly rows: Row[];
}

/**
 * Every fill row in the snapshot, grouped by position key, unread. A row with
 * no market or symbol has no position to belong to and is reported under a key
 * of its own rather than dropped. The arrays are appended in place: they are
 * local to this function, and a copy per row would make the grouping
 * quadratic in the session's fill count on the render path.
 */
function groupByPosition(orders: readonly Row[]): ReadonlyMap<string, Group> {
  const groups = new Map<string, Group>();
  for (const order of orders) {
    if (!Array.isArray(order.fills)) continue;
    for (const fill of order.fills as unknown[]) {
      if (typeof fill !== 'object' || fill === null) continue;
      const row = fill as Row;
      const market = text(row.market) ?? '';
      const symbol = text(row.symbol) ?? '';
      const key = realizedKey(market, symbol);
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { market, symbol, rows: [row] });
    }
  }
  return groups;
}

function foldPosition({ market, symbol, rows }: Group): RealizedPnlEntry {
  if (market === '') throw new Error('fill has no readable market');
  if (symbol === '') throw new Error('fill has no readable symbol');
  const fills = rows.map(readFill);
  const [first] = fills;
  if (first === undefined) throw new Error('no fills');
  if (fills.some((fill) => fill.currency !== first.currency))
    throw new Error('fills disagree about the currency');
  const ordered = [...fills].sort((a, b) =>
    a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0,
  );
  const position = ordered.reduce(
    (current, fill) =>
      applyFillToPosition(current, {
        symbol,
        side: fill.side,
        price: fill.price,
        quantity: fill.quantity,
        fee: fill.fee,
      }),
    emptyPosition(symbol),
  );
  return { realizedPnl: position.realizedPnl, currency: first.currency };
}

function sumByCurrency(
  entries: Iterable<RealizedPnlEntry>,
): readonly RealizedPnlTotal[] {
  const sums = new Map<Currency, Decimal>();
  for (const entry of entries) {
    const current = sums.get(entry.currency) ?? moneyDecimal(0);
    sums.set(
      entry.currency,
      assertExactMoney(
        current.plus(moneyDecimal(entry.realizedPnl)),
        'Realized PnL total',
      ),
    );
  }
  return CURRENCIES.flatMap((currency) => {
    const total = sums.get(currency);
    return total === undefined
      ? []
      : [{ currency, realizedPnl: total.toString() }];
  });
}

/** What a fold failure says: the core's error code when it has one. */
const reasonOf = (error: unknown): string =>
  error instanceof Error
    ? 'code' in error && typeof error.code === 'string'
      ? `${error.code}: ${error.message}`
      : error.message
    : String(error);

export function realizedPnlFromOrders(
  orders: readonly Row[],
): RealizedPnlReport {
  const byPosition = new Map<string, RealizedPnlEntry>();
  const unavailable = new Map<string, string>();
  for (const [key, group] of groupByPosition(orders)) {
    try {
      byPosition.set(key, foldPosition(group));
    } catch (error) {
      unavailable.set(key, reasonOf(error));
    }
  }
  return {
    byPosition,
    totals: sumByCurrency(byPosition.values()),
    unavailable,
  };
}
