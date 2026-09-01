import {
  type DecimalString,
  DomainError,
  type Market,
  type Quantity,
  type Side,
} from '@moi/trading-core';

import { type OrderIntent, readOrderIntent } from './order-intent.js';
import type { ParameterSchema } from './parameter-schema.js';
import {
  assertCommandObject,
  assertIdentifier,
  assertMember,
  readOptionalField,
} from './validation.js';

export {
  GATEWAY_FIELDS,
  ORDER_INTENT_PRICE_RULES,
  type OrderIntent,
  type PriceRule,
  type PriceRules,
  readOrderIntent,
} from './order-intent.js';
export {
  defineParameterSchema,
  enumParameter,
  integerParameter,
  type ParameterField,
  type ParameterFieldDescription,
  type ParameterSchema,
  quantityParameter,
  symbolParameter,
} from './parameter-schema.js';

/**
 * The strategy contract, as
 * `docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md` §6.1
 * defines it. A strategy is pure decision logic: it sees ticks and fills, and
 * answers with decisions. It never places an order, never reads a clock other
 * than `StrategyContext.now`, and never touches the network or the disk — the
 * runner owns all of that.
 */

/** JSON, as `snapshot()` is required to produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A strategy's own state, as it survives a restart. It is written to and read
 * back from the runner's state store, so it is JSON and nothing more — no
 * `Decimal`, no `Date`, no class instance.
 *
 * A strategy that reads one back in `onStart` is reading a *file*, not its own
 * memory: the operator may have edited it, the parameters may have changed
 * since it was written, and it may be from an older build. Validate it.
 */
export type StrategyState = { readonly [key: string]: JsonValue };

export interface InstrumentRef {
  readonly market: Market;
  readonly symbol: string;
}

/** Where a tick's price came from. See design §5.2. */
export type TickPriceSource = 'book-mid' | 'rest-snapshot';

/**
 * One price observation, as the runner derives it (design §5.2). The paper API
 * publishes an order book rather than trades, so `price` is a book mid-price or
 * a REST snapshot price and `priceSource` says which.
 *
 * `asOf` is the **runner's** receive time, not the provider's: the frame carries
 * no provider timestamp, and the name says so rather than pretending otherwise.
 * Ordering is by `marketDataVersion`, which is monotonic; a frame that goes
 * backwards is dropped before a strategy ever sees it.
 *
 * `gapBefore` marks the first tick after a market-data gap — a reconnect, or a
 * REST snapshot stitched in. Quote frames are not replayed (design §5.3), so
 * the prices either side of a gap are not consecutive observations, and any
 * indicator that averages across one is averaging over a discontinuity.
 */
export interface Tick {
  readonly market: Market;
  readonly symbol: string;
  readonly price: DecimalString;
  readonly priceSource: TickPriceSource;
  readonly bestBid: DecimalString | null;
  readonly bestAsk: DecimalString | null;
  readonly asOf: string;
  readonly marketDataVersion: string;
  readonly gapBefore: boolean;
}

/**
 * What the strategy is holding, as the *ledger* reports it.
 *
 * This is deliberately not `BrokerPosition`: that type mirrors the paper API's
 * wire payload field for field and is documented as doing so, and a strategy
 * contract that changes whenever the wire changes is not a contract. It is also
 * deliberately smaller — `reserved` is `total` minus `available` and a strategy
 * has no use for the difference.
 *
 * `available` is what can be sold right now; `total` includes quantity already
 * reserved by a resting order. A strategy sizes an exit from `available`, never
 * from `total`, or the ledger refuses the order with
 * `INSUFFICIENT_AVAILABLE_POSITION`.
 */
export interface StrategyPosition {
  readonly market: Market;
  readonly symbol: string;
  readonly total: Quantity;
  readonly available: Quantity;
  readonly averageCost: DecimalString;
}

/**
 * Everything a strategy may ask about the world. It is the *whole* of what a
 * strategy may ask: there is no escape hatch, which is what makes `onTick`
 * reproducible from a recorded tick series (design §8.2).
 *
 * `position` comes from the ledger, which is the source of truth for what is
 * held: design §7.3 is explicit that the ledger is the original of the fact and
 * the bot's state is a cache. A strategy that instead accumulates its own
 * position from fills is keeping a second copy of that fact, and a second copy
 * drifts across a restart. (§6.4 is sometimes cited for this and does not say
 * it — it binds the *runner's* fill replay and PnL bookkeeping to the
 * `accountSequence` cursor, and says nothing about what a strategy may keep.)
 *
 * `window` is the runner's shared recent-tick view for an instrument, newest
 * last. Its length is the runner's choice, and after a gap it may contain
 * REST-stitched prices, so a strategy that needs a *specific* number of
 * consecutive prices keeps its own window in `snapshot()` instead — which is
 * also the only window that survives a restart.
 */
export interface StrategyContext {
  /** The runner's clock. The only time a strategy may read. */
  now(): string;
  position(instrument: InstrumentRef): StrategyPosition | null;
  window(instrument: InstrumentRef): readonly Tick[];
}

/**
 * One fill, as the runner replays it from the account event stream.
 * `accountSequence` is the ledger's cursor for the event (design §6.4), so a
 * strategy can recognise a replayed fill it has already seen.
 */
export interface FillEvent {
  readonly orderId: string;
  readonly fillId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: DecimalString;
  readonly fee: DecimalString;
  readonly accountSequence: DecimalString;
}

/**
 * A `noop` is not silence: `reason` is what appears in the decision log, so an
 * operator can see *why* a strategy stood still on a tick it might have traded.
 */
export interface NoopDecision {
  readonly kind: 'noop';
  readonly reason?: string;
}

/**
 * An order the strategy wants placed. The intent carries no session and no
 * idempotency key — see `OrderIntent`. `reason` is required, because an order
 * with no recorded reason cannot be reviewed after the fact.
 */
export interface PlaceDecision {
  readonly kind: 'place';
  readonly intent: OrderIntent;
  readonly reason: string;
}

export interface CancelDecision {
  readonly kind: 'cancel';
  readonly orderId: string;
  readonly reason: string;
}

export type StrategyDecision = NoopDecision | PlaceDecision | CancelDecision;

export interface Strategy<P = unknown> {
  /** Stable across releases: it keys the registry and every state file. */
  readonly id: string;
  readonly parameterSchema: ParameterSchema<P>;
  /**
   * The instruments this strategy wants ticks for. The runner refuses to start
   * if two configured strategies claim the same instrument (design §6.3), and
   * if the total exceeds the API's quote-subscription limit (design §5.3).
   */
  subscriptions(params: P): readonly InstrumentRef[];
  /** Restores `state` — untrusted JSON from the state store. */
  onStart?(state: StrategyState, context: StrategyContext, params: P): void;
  /**
   * Synchronous and pure: same state, same tick, same context answers, same
   * decisions. No clock but `context.now()`, no randomness, no I/O. The lint
   * override on `packages/strategy-sdk/src/strategies/**` in `biome.json`
   * denies the globals that would break this.
   */
  onTick(
    tick: Tick,
    context: StrategyContext,
    params: P,
  ): readonly StrategyDecision[];
  onFill?(
    fill: FillEvent,
    context: StrategyContext,
    params: P,
  ): readonly StrategyDecision[];
  /** State to restore after a restart. JSON-serialisable. */
  snapshot?(): StrategyState;
}

const DECISION_KINDS: Readonly<Record<StrategyDecision['kind'], true>> = {
  noop: true,
  place: true,
  cancel: true,
};

function readStrategyDecision(decision: unknown): StrategyDecision {
  assertCommandObject(decision, 'strategy decision');

  const source: Record<string, unknown> = decision;
  const { kind } = source;

  assertMember(kind, DECISION_KINDS, 'kind');

  if (kind === 'noop') {
    const { supplied, value } = readOptionalField(source, 'reason');

    if (!supplied) {
      return Object.freeze({ kind });
    }

    assertIdentifier(value, 'reason');

    return Object.freeze({ kind, reason: value });
  }

  const { reason } = source;

  assertIdentifier(reason, 'reason');

  if (kind === 'cancel') {
    const { orderId } = source;

    assertIdentifier(orderId, 'orderId');

    return Object.freeze({ kind, orderId, reason });
  }

  return Object.freeze({
    kind,
    intent: readOrderIntent(source.intent),
    reason,
  });
}

/**
 * Validates what a strategy returned, and snapshots it.
 *
 * A strategy is caller code from the runner's point of view — a registry entry,
 * possibly written by someone else — so its answer crosses a boundary exactly
 * like a command from a JavaScript caller does, and gets the same treatment:
 * every field read once, into a frozen snapshot, and it is the snapshot the
 * gateway acts on rather than the array the strategy still holds a reference to.
 */
export function readStrategyDecisions(
  decisions: unknown,
): readonly StrategyDecision[] {
  if (!Array.isArray(decisions)) {
    throw new DomainError(
      'INVALID_ORDER',
      'strategy decisions must be an array',
    );
  }

  return Object.freeze(decisions.map(readStrategyDecision));
}
