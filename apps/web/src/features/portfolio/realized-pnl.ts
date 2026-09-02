import {
  applyFillToPosition,
  assertExactMoney,
  type DecimalString,
  moneyDecimal,
  type PositionCost,
} from '@moi/trading-core';
import type { Decimal } from 'decimal.js';
import { asCurrency, type Currency } from '../../lib/currency';

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
 * ## Failure shape
 *
 * A symbol whose rows cannot be folded — a field missing or unreadable, a
 * sell larger than what was held, fills that disagree about their currency —
 * is reported in `unavailable` and left out of `bySymbol` and `totals`. The
 * other symbols are unaffected. Nothing here throws: this runs on the render
 * path of a page with no error boundary (#73), and a dash beside one symbol
 * is the right size of failure for one bad row.
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

export interface RealizedPnlSummary {
  readonly bySymbol: ReadonlyMap<string, RealizedPnlEntry>;
  /** One row per currency any folded symbol settled in; KRW first. */
  readonly totals: readonly RealizedPnlTotal[];
  /** Symbols whose fills could not be folded; see the module comment. */
  readonly unavailable: ReadonlySet<string>;
}

type Row = Readonly<Record<string, unknown>>;

interface OrderedFill {
  readonly sequence: bigint;
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly quantity: string;
  readonly fee: string;
  readonly currency: Currency;
}

const CURRENCY_ORDER: readonly Currency[] = ['KRW', 'USD'];
const FILL_SEQUENCE = /^\d{1,19}$/;
const EMPTY_POSITION = (symbol: string): PositionCost => ({
  symbol,
  quantity: '0',
  totalCost: '0',
  realizedPnl: '0',
});

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The fields the fold needs, or `undefined` when any is missing. */
function readFill(row: Row): OrderedFill | undefined {
  const sequence = text(row.fillSequence);
  const side = row.side;
  const price = text(row.price);
  const quantity = text(row.quantity);
  const fee = text(row.fee);
  const currency = asCurrency(row.currency);
  if (
    sequence === undefined ||
    !FILL_SEQUENCE.test(sequence) ||
    (side !== 'BUY' && side !== 'SELL') ||
    price === undefined ||
    quantity === undefined ||
    fee === undefined ||
    currency === undefined
  )
    return undefined;
  return { sequence: BigInt(sequence), side, price, quantity, fee, currency };
}

/** Every fill row in the snapshot, grouped by symbol, unread. */
function groupBySymbol(orders: readonly Row[]): ReadonlyMap<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const order of orders) {
    if (!Array.isArray(order.fills)) continue;
    for (const fill of order.fills as unknown[]) {
      if (typeof fill !== 'object' || fill === null) continue;
      const row = fill as Row;
      const symbol = text(row.symbol);
      if (symbol === undefined) continue;
      groups.set(symbol, [...(groups.get(symbol) ?? []), row]);
    }
  }
  return groups;
}

function foldSymbol(symbol: string, rows: readonly Row[]): RealizedPnlEntry {
  const fills = rows.map((row) => {
    const fill = readFill(row);
    if (fill === undefined) throw new Error('unreadable fill');
    return fill;
  });
  const [first] = fills;
  if (first === undefined) throw new Error('no fills');
  if (fills.some((fill) => fill.currency !== first.currency))
    throw new Error('mixed currencies');
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
    EMPTY_POSITION(symbol),
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
  return CURRENCY_ORDER.flatMap((currency) => {
    const total = sums.get(currency);
    return total === undefined
      ? []
      : [{ currency, realizedPnl: total.toString() }];
  });
}

export function realizedPnlFromOrders(
  orders: readonly Row[],
): RealizedPnlSummary {
  const bySymbol = new Map<string, RealizedPnlEntry>();
  const unavailable = new Set<string>();
  for (const [symbol, rows] of groupBySymbol(orders)) {
    try {
      bySymbol.set(symbol, foldSymbol(symbol, rows));
    } catch {
      unavailable.add(symbol);
    }
  }
  return {
    bySymbol,
    totals: sumByCurrency(bySymbol.values()),
    unavailable,
  };
}
