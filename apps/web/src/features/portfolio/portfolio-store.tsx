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

function applyEvent(
  snapshot: PortfolioSnapshot,
  payload: PortfolioEvent,
  accountSequence: string,
): PortfolioSnapshot {
  const patch = payload as Partial<PortfolioSnapshot>;
  return {
    ...snapshot,
    ...patch,
    accountSequence,
    market: patch.market
      ? {
          ...snapshot.market,
          ...patch.market,
          recoveryFill: {
            ...snapshot.market.recoveryFill,
            ...patch.market.recoveryFill,
          },
        }
      : snapshot.market,
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
  if (current === undefined || next === undefined || next !== current + 1n) {
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
