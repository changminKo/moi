import { formatDecimal } from '../../lib/format-number';
import type { MessageKey } from '../../lib/i18n';

/**
 * Turning an `ORDER_FILLED` delivery into the one sentence a toast says, and
 * deciding whether it is news at all.
 *
 * ## Where a fill actually is on the wire
 *
 * The durable outbox row (`runtime/fill-persistence.ts`) carries only
 * `{ orderId, status, filledQuantity, recoveryEpoch, recoveryFill }` — no
 * symbol, no side, no price. What makes a sentence possible is
 * `ProductionRuntime.#enrichPayload`, which merges the session's whole
 * portfolio snapshot onto every event: `activeOrders` is *every* order the
 * session has (the repository query has no status filter, per spec §16.32),
 * each carrying its complete `fills` history with `{ id, quantity, price }`.
 * So the order named by `orderId` is in the payload, and so are its fills.
 *
 * Enrichment is also why the ledger only ever learns about the fills of the
 * order an `ORDER_FILLED` names. The snapshot rides on *every* event, and a
 * book with liquidity matches inside the placement itself, so `ORDER_PLACED`
 * is routinely enriched after the fill it precedes and already lists it.
 * Recording whatever a payload happens to carry would therefore silence the
 * fill's own event a moment later — and silence it precisely for the instant
 * fills that most deserve announcing.
 *
 * ## Why a ledger of fill ids
 *
 * `GET /api/v1/stream` without `afterSequence` replays the outbox **from
 * sequence 0** (`createOutboxEventSource.replay`), and the browser's first
 * connect always omits it — the snapshot that would supply a cursor has not
 * resolved yet. Every page load therefore re-delivers the account's whole
 * fill history as ordinary `event` frames. Announcing those would be worse
 * than not announcing at all, so nothing is announced twice: every fill id
 * this client has ever seen — in a snapshot or in an event — is remembered,
 * and only an unseen id speaks.
 *
 * The ledger is also *unarmed* until a snapshot has been recorded, which
 * covers the other race: a replay that lands before the snapshot resolves is
 * recorded in silence, exactly as `reducePortfolio` drops events that arrive
 * before there is state to patch.
 *
 * Only the *first* snapshot draws that line. Every later one is ignored,
 * because the portfolio is refetched constantly — `useOrderMutations`
 * invalidates it the instant an order is accepted — and a book that fills
 * immediately puts the new fill in that refetch before its event has even
 * been published. Counting a mid-session snapshot as history is therefore the
 * same as never announcing the fastest fills, which are the ones a reader is
 * least prepared for.
 */

/** One fill worth saying out loud. */
export type FillAnnouncement = Readonly<{
  /** The fill row's own id: the React key, and the handle that dedupes it. */
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  /** This delivery's own quantity and price — only when it carried one fill. */
  quantity?: string;
  price?: string;
  /** Cumulative, exactly as the server reported it. Never computed here. */
  filledQuantity: string;
  orderQuantity: string;
  complete: boolean;
}>;

export type FillLedger = Readonly<{
  known: ReadonlySet<string>;
  /** True once the first portfolio snapshot has been recorded. */
  armed: boolean;
}>;

/**
 * Bounded the way `portfolio-store.tsx` bounds `seenEventIds`. Eviction can
 * only cost a re-announcement for a fill both older than this bound and still
 * unpublished in the outbox — published rows are pruned, so a replay is short.
 */
const MAX_KNOWN_FILL_IDS = 4096;

export function createFillLedger(): FillLedger {
  return { known: new Set(), armed: false };
}

const asRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Every order in the payload, whatever else the payload turns out to be. */
function ordersOf(payload: unknown): readonly Record<string, unknown>[] {
  const orders = asRecord(payload)?.activeOrders;
  return Array.isArray(orders)
    ? orders.flatMap((entry) => {
        const order = asRecord(entry);
        return order ? [order] : [];
      })
    : [];
}

function fillsOf(
  order: Readonly<Record<string, unknown>>,
): readonly Record<string, unknown>[] {
  return Array.isArray(order.fills)
    ? order.fills.flatMap((entry) => {
        const fill = asRecord(entry);
        return fill ? [fill] : [];
      })
    : [];
}

function withKnown(
  ledger: FillLedger,
  ids: readonly string[],
  armed: boolean,
): FillLedger {
  if (ids.length === 0 && armed === ledger.armed) return ledger;
  const known = new Set(ledger.known);
  for (const id of ids) known.add(id);
  while (known.size > MAX_KNOWN_FILL_IDS)
    known.delete(known.values().next().value as string);
  return { known, armed };
}

const fillIds = (payload: unknown): readonly string[] =>
  ordersOf(payload).flatMap((order) =>
    fillsOf(order).flatMap((fill) => {
      const id = asString(fill.id);
      return id === undefined ? [] : [id];
    }),
  );

/**
 * Draws the line between everything that happened before this client arrived
 * and everything that happens from now on. Silent by construction, and a
 * once-only act: the caller may hand over every snapshot it fetches, but only
 * the first one counts as history.
 */
export function recordFills(ledger: FillLedger, snapshot: unknown): FillLedger {
  return ledger.armed ? ledger : withKnown(ledger, fillIds(snapshot), true);
}

function announcementFor(
  payload: unknown,
  fresh: readonly Readonly<Record<string, unknown>>[],
): FillAnnouncement | undefined {
  const event = asRecord(payload);
  const orderId = asString(event?.orderId);
  const order = ordersOf(payload).find((row) => asString(row.id) === orderId);
  const last = fresh.at(-1);
  const id = last ? asString(last.id) : undefined;
  const symbol = asString(order?.symbol);
  const side = order?.side;
  const orderQuantity = asString(order?.quantity);
  const filledQuantity = asString(event?.filledQuantity);
  if (
    order === undefined ||
    id === undefined ||
    symbol === undefined ||
    orderQuantity === undefined ||
    filledQuantity === undefined ||
    (side !== 'BUY' && side !== 'SELL')
  )
    return undefined;
  // A single fill has one exact price to name. Two or more in one delivery do
  // not: naming one would be false, and blending them would be arithmetic on
  // money. Those fall back to the cumulative wording the server supplied.
  const only = fresh.length === 1 ? fresh[0] : undefined;
  const quantity = only ? asString(only.quantity) : undefined;
  const price = only ? asString(only.price) : undefined;
  return {
    id,
    symbol,
    side,
    ...(quantity !== undefined && price !== undefined
      ? { quantity, price }
      : {}),
    filledQuantity,
    orderQuantity,
    complete: asString(event?.status) === 'FILLED',
  };
}

/**
 * Folds one user-stream event into the ledger. Only an `ORDER_FILLED` is read
 * at all, and only the fills of the order it names are recorded; the answer
 * carries an announcement when one of those fills is new to this client.
 *
 * Total: any shape it does not recognise yields no announcement rather than a
 * throw — this runs inside the socket's `onmessage`, and there is still no
 * `ErrorBoundary` above the app (#73).
 */
export function announceFill(
  ledger: FillLedger,
  eventType: string | undefined,
  payload: unknown,
): Readonly<{ ledger: FillLedger; announcement?: FillAnnouncement }> {
  if (eventType !== 'ORDER_FILLED') return { ledger };
  const orderId = asString(asRecord(payload)?.orderId);
  const order = ordersOf(payload).find((row) => asString(row.id) === orderId);
  const fresh = order
    ? fillsOf(order).filter((fill) => {
        const id = asString(fill.id);
        return id !== undefined && !ledger.known.has(id);
      })
    : [];
  // Only this order's fills, and only from its own event. See the note above.
  const next = withKnown(
    ledger,
    fresh.flatMap((fill) => {
      const id = asString(fill.id);
      return id === undefined ? [] : [id];
    }),
    ledger.armed,
  );
  if (!ledger.armed || fresh.length === 0) return { ledger: next };
  const announcement = announcementFor(payload, fresh);
  return announcement === undefined
    ? { ledger: next }
    : { ledger: next, announcement };
}

/**
 * The catalogue key and the interpolation values for one announcement. Kept
 * apart from the component so the wording is testable without a DOM, and so
 * every decimal passes `formatDecimal` at this one render boundary — the
 * quantities and prices stay the exact strings the server sent until here.
 *
 * No currency symbol: neither the fill row nor the order row carries a
 * currency, and `lib/currency.ts` is explicit that deriving one from `market`
 * would restate a server invariant. A bare number is the honest option.
 */
export function fillToastMessage(announcement: FillAnnouncement): Readonly<{
  key: MessageKey;
  sideKey: MessageKey;
  values: Readonly<Record<string, string>>;
}> {
  const sideKey: MessageKey =
    announcement.side === 'SELL' ? 'ticket.sell' : 'ticket.buy';
  const symbol = announcement.symbol;
  const total = formatDecimal(announcement.orderQuantity);
  const filled = formatDecimal(announcement.filledQuantity);
  if (announcement.quantity === undefined || announcement.price === undefined)
    return announcement.complete
      ? {
          key: 'fillToast.completeCumulative',
          sideKey,
          values: { symbol, total },
        }
      : {
          key: 'fillToast.partialCumulative',
          sideKey,
          values: { symbol, filled, total },
        };
  const quantity = formatDecimal(announcement.quantity);
  const price = formatDecimal(announcement.price);
  return announcement.complete
    ? {
        key: 'fillToast.complete',
        sideKey,
        values: { symbol, quantity, price },
      }
    : {
        key: 'fillToast.partial',
        sideKey,
        values: { symbol, quantity, price, filled, total },
      };
}
