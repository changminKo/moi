import type { PortfolioEvent, UserStreamMessage } from '../../lib/user-stream';
import type { PortfolioSnapshot } from './portfolio-model';

export type { PortfolioSnapshot } from './portfolio-model';

export type PortfolioSync = Readonly<{
  status: 'LIVE' | 'STALE';
  refreshRequested: boolean;
}>;
export type PortfolioState = Readonly<{
  snapshot: PortfolioSnapshot;
  sync: PortfolioSync;
  seenEventIds: ReadonlySet<string>;
}>;
export type PortfolioAction =
  | PortfolioSnapshot
  | Extract<UserStreamMessage, { type: 'event' }>
  | Extract<UserStreamMessage, { type: 'resync-required' }>;

const MAX_EVENT_IDS = 2048;
const sequence = (value: string): bigint | undefined => {
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};

export function createPortfolioState(
  snapshot: PortfolioSnapshot,
): PortfolioState {
  return {
    snapshot,
    sync: { status: 'LIVE', refreshRequested: false },
    seenEventIds: new Set(),
  };
}

/**
 * Whether an event payload is a whole snapshot rather than a piece of one.
 *
 * It asks for every collection and the market object, not just `wallets`.
 * `applyEvent` spreads the payload over the previous snapshot, so a field the
 * payload omits is carried forward silently — safe only while
 * `ProductionRuntime.#enrichPayload` happens to put the entire portfolio on
 * every event, which is the server's convenience and not a promise. Now that
 * what this produces is published to the `PORTFOLIO_QUERY_KEY` cache, a
 * half-applied snapshot stops being one screen's display bug and becomes what
 * every reader of that cache sees. Anything short of complete refuses to apply
 * and refetches — the answer this reducer already gave to a payload with no
 * snapshot shape at all.
 */
function isSnapshotPatch(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const patch = payload as Record<string, unknown>;
  const market = patch.market as Record<string, unknown> | undefined;
  return (
    typeof patch.sessionId === 'string' &&
    patch.sessionId.length > 0 &&
    Array.isArray(patch.wallets) &&
    Array.isArray(patch.positions) &&
    Array.isArray(patch.reservations) &&
    Array.isArray(patch.activeOrders) &&
    typeof market === 'object' &&
    market !== null &&
    typeof market.health === 'object' &&
    market.health !== null &&
    typeof market.recoveryFill === 'object' &&
    market.recoveryFill !== null
  );
}

/**
 * Named field by field rather than spread, because the payload is the
 * snapshot *plus the event's own fields* — `orderId`, `status`,
 * `filledQuantity`, `recoveryEpoch`, `recoveryFill`. Spreading carried those
 * onto the snapshot, which was survivable while the result stayed inside this
 * store and is not once it is published to the query cache: components that
 * never saw the event would read them as portfolio state, and they would
 * linger after the event that explained them.
 *
 * The caller has already established the payload is a complete snapshot, so
 * every collection is taken from it whole. `market` still merges: its two maps
 * are keyed by market code, and a snapshot naming only the market that moved
 * must not erase the other one's health.
 */
function applyEvent(
  snapshot: PortfolioSnapshot,
  payload: PortfolioEvent,
  accountSequence: string,
): PortfolioSnapshot {
  const patch = payload as unknown as PortfolioSnapshot;
  return {
    // Taken, never inherited. Carrying the previous session's id forward when
    // a payload omitted it is the same accident this reducer refuses for every
    // other field — and the gate above has already established it is there.
    sessionId: patch.sessionId,
    wallets: patch.wallets,
    positions: patch.positions,
    reservations: patch.reservations,
    activeOrders: patch.activeOrders,
    accountSequence,
    market: {
      health: { ...snapshot.market.health, ...patch.market.health },
      recoveryFill: {
        ...snapshot.market.recoveryFill,
        ...patch.market.recoveryFill,
      },
    },
  };
}

export function reducePortfolio(
  state: PortfolioState,
  action: PortfolioAction,
): PortfolioState {
  if ('accountSequence' in action && !('type' in action)) {
    return {
      snapshot: action,
      sync: { status: 'LIVE', refreshRequested: false },
      seenEventIds: new Set(),
    };
  }
  if (action.type === 'resync-required') {
    return state.sync.status === 'STALE'
      ? state
      : { ...state, sync: { status: 'STALE', refreshRequested: true } };
  }
  if (state.sync.status === 'STALE') return state;
  if (state.seenEventIds.has(action.eventId)) return state;
  const seen = new Set(state.seenEventIds);
  seen.delete(action.eventId);
  seen.add(action.eventId);
  while (seen.size > MAX_EVENT_IDS)
    seen.delete(seen.values().next().value as string);
  const current = sequence(state.snapshot.accountSequence);
  const next = sequence(action.accountSequence);
  // A payload without the snapshot shape (a bare durable event replayed
  // without enrichment) cannot be applied as a patch: fetch the snapshot.
  if (
    current === undefined ||
    next === undefined ||
    next !== current + 1n ||
    !isSnapshotPatch(action.payload)
  ) {
    return {
      ...state,
      seenEventIds: seen,
      sync: { status: 'STALE', refreshRequested: true },
    };
  }
  return {
    ...state,
    snapshot: applyEvent(
      state.snapshot,
      action.payload,
      action.accountSequence,
    ),
    seenEventIds: seen,
  };
}
