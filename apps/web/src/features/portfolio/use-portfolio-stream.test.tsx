import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortfolioSnapshot } from './portfolio-store';
import {
  PORTFOLIO_QUERY_KEY,
  usePortfolioStream,
} from './use-portfolio-stream';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readonly send = vi.fn();
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.onclose?.({ code, reason } as CloseEvent);
  });
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  open(): void {
    this.onopen?.(new Event('open'));
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

const snapshot = (accountSequence: string): PortfolioSnapshot => ({
  sessionId: 's-1',
  wallets: [],
  positions: [],
  reservations: [],
  activeOrders: [],
  accountSequence,
  market: { health: {}, recoveryFill: {} },
});

function setup(
  seed?: PortfolioSnapshot | { accountSequence: string },
  extra: Partial<Parameters<typeof usePortfolioStream>[0]> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  if (seed) queryClient.setQueryData(PORTFOLIO_QUERY_KEY, seed);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const factory = vi.fn(
    (url: string) => new FakeSocket(url) as unknown as WebSocket,
  );
  const options = { webSocketFactory: factory, random: () => 0.5, ...extra };
  const hook = renderHook(() => usePortfolioStream(options), { wrapper });
  return { hook, factory, queryClient };
}
const urlOf = (factory: ReturnType<typeof vi.fn>, call = 0) =>
  new URL(factory.mock.calls[call]?.[0] as string);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('usePortfolioStream stream protocol (§7.5)', () => {
  it('W1: encodes the snapshot accountSequence as a query parameter and never sends a frame', () => {
    const { factory } = setup(snapshot('42'));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(urlOf(factory).pathname).toBe('/api/v1/stream');
    expect(urlOf(factory).searchParams.get('afterSequence')).toBe('42');
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());
    act(() =>
      socket.receive({
        type: 'ready',
        accountSequence: '42',
        heartbeatIntervalMs: 30_000,
      }),
    );
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('W1b: omits afterSequence when the snapshot is missing or not a decimal sequence', () => {
    const none = setup();
    expect(urlOf(none.factory).searchParams.has('afterSequence')).toBe(false);
    act(() => (FakeSocket.instances[0] as FakeSocket).open());
    expect((FakeSocket.instances[0] as FakeSocket).send).not.toHaveBeenCalled();
    none.hook.unmount();
    FakeSocket.instances = [];
    const bad = setup(snapshot('abc'));
    expect(urlOf(bad.factory).searchParams.has('afterSequence')).toBe(false);
    act(() => (FakeSocket.instances[0] as FakeSocket).open());
    expect((FakeSocket.instances[0] as FakeSocket).send).not.toHaveBeenCalled();
  });

  it('W2: reconnects with the latest accountSequence after events advanced it', () => {
    const { factory } = setup(snapshot('42'));
    const first = FakeSocket.instances[0] as FakeSocket;
    act(() => first.open());
    act(() =>
      first.receive({
        type: 'ready',
        accountSequence: '42',
        heartbeatIntervalMs: 30_000,
      }),
    );
    // A whole snapshot, as `#enrichPayload` sends: a partial payload is
    // refused and refetched now, so `{ wallets: [] }` would never advance the
    // sequence this test is about.
    for (const sequence of ['43', '44', '45'])
      act(() =>
        first.receive({
          type: 'event',
          eventId: `e${sequence}`,
          accountSequence: sequence,
          payload: snapshot(sequence),
        }),
      );
    act(() => first.onclose?.({ code: 1006 } as CloseEvent));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(urlOf(factory, 1).searchParams.get('afterSequence')).toBe('45');
    expect(first.send).not.toHaveBeenCalled();
  });

  it('W3: stays connected while heartbeats arrive and closes with 4000 after two missed beats', () => {
    const { factory } = setup(snapshot('42'));
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());
    act(() =>
      socket.receive({
        type: 'ready',
        accountSequence: '42',
        heartbeatIntervalMs: 30_000,
      }),
    );
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      act(() =>
        socket.receive({
          type: 'heartbeat',
          serverTime: new Date().toISOString(),
        }),
      );
    }
    expect(socket.close).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(socket.close).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(socket.close).toHaveBeenCalledWith(4000, 'heartbeat timeout');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('usePortfolioStream fill announcements', () => {
  const fill = (id: string) => ({
    id,
    symbol: 'AAPL',
    quantity: '1',
    price: '325.26',
    fee: '0',
    recoveryFill: false,
  });
  const withOrder = (
    accountSequence: string,
    fills: readonly Record<string, unknown>[],
  ): PortfolioSnapshot => ({
    ...snapshot(accountSequence),
    activeOrders: [
      {
        id: 'o1',
        market: 'US',
        symbol: 'AAPL',
        type: 'MARKET',
        side: 'BUY',
        quantity: '1',
        filledQuantity: '1',
        status: 'FILLED',
      } as unknown as Record<string, string | null>,
    ].map((order, index) => ({
      ...order,
      fills: index === 0 ? fills : [],
    })) as unknown as PortfolioSnapshot['activeOrders'],
  });

  function setupWithFills(seed: PortfolioSnapshot) {
    const onFill = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(PORTFOLIO_QUERY_KEY, seed);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const options = {
      webSocketFactory: (url: string) =>
        new FakeSocket(url) as unknown as WebSocket,
      random: () => 0.5,
      onFill,
    };
    renderHook(() => usePortfolioStream(options), { wrapper });
    return { onFill, socket: FakeSocket.instances[0] as FakeSocket };
  }

  const filledEvent = (
    accountSequence: string,
    fills: readonly Record<string, unknown>[],
  ) => ({
    type: 'event',
    eventId: `e-${accountSequence}`,
    accountSequence,
    eventType: 'ORDER_FILLED',
    payload: {
      orderId: 'o1',
      status: 'FILLED',
      filledQuantity: '1',
      ...withOrder(accountSequence, fills),
    },
  });

  it('announces a fill the snapshot had not already reported', () => {
    const { onFill, socket } = setupWithFills(withOrder('42', []));
    act(() => socket.open());
    act(() => socket.receive(filledEvent('43', [fill('f1')])));
    expect(onFill).toHaveBeenCalledTimes(1);
    expect(onFill.mock.calls[0]?.[0]).toMatchObject({
      id: 'f1',
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '1',
      price: '325.26',
      complete: true,
    });
  });

  it('says nothing when the server replays the fill the snapshot already had', () => {
    // Every first connect omits `afterSequence`, so the server replays the
    // outbox from zero: this is the ordinary page load, not an edge case.
    const { onFill, socket } = setupWithFills(withOrder('42', [fill('f1')]));
    act(() => socket.open());
    act(() => socket.receive(filledEvent('43', [fill('f1')])));
    expect(onFill).not.toHaveBeenCalled();
  });

  it('says nothing twice when the same delivery is repeated', () => {
    const { onFill, socket } = setupWithFills(withOrder('42', []));
    act(() => socket.open());
    act(() => socket.receive(filledEvent('43', [fill('f1')])));
    act(() => socket.receive(filledEvent('44', [fill('f1')])));
    expect(onFill).toHaveBeenCalledTimes(1);
  });

  it('still announces after the store has gone stale', () => {
    // A sequence gap only means the patch cannot be applied; the fill in the
    // payload still happened, and the reader still needs to hear about it.
    const { onFill, socket } = setupWithFills(withOrder('42', []));
    act(() => socket.open());
    act(() =>
      socket.receive({ type: 'resync-required', reason: 'OUTBOX_GAP' }),
    );
    act(() => socket.receive(filledEvent('99', [fill('f1')])));
    expect(onFill).toHaveBeenCalledTimes(1);
  });
});

/**
 * The write itself. `portfolio-cache-contract.test.ts` fixes what a snapshot
 * must look like before it may go into the cache; these fix that it goes there
 * at all, and that a refused patch does not.
 *
 * Red on purpose until the implementation lands — nothing writes the cache
 * today, which is why the trade page's wallets and sell-side holding sit still
 * between invalidations while the portfolio page beside them is live.
 */
describe('usePortfolioStream writing through to the query cache', () => {
  const complete = (accountSequence: string, krw: string) =>
    ({
      sessionId: 's-1',
      wallets: [{ currency: 'KRW', total: krw, available: krw, reserved: '0' }],
      positions: [],
      reservations: [],
      activeOrders: [],
      accountSequence,
      market: { health: {}, recoveryFill: {} },
    }) as unknown as PortfolioSnapshot;

  const patch = (accountSequence: string, krw: string) => ({
    type: 'event',
    eventId: `e-${accountSequence}`,
    accountSequence,
    eventType: 'ORDER_FILLED',
    payload: {
      orderId: 'o-1',
      status: 'FILLED',
      filledQuantity: '1',
      ...complete(accountSequence, krw),
    },
  });

  it('publishes an applied patch so every cache reader sees it', () => {
    // The trade page reads its wallets and the sell-side holding straight out
    // of this cache entry. Patching only the hook's own state leaves that
    // page a version behind until something happens to invalidate.
    const { queryClient } = setup(complete('42', '1000'));
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());

    act(() => socket.receive(patch('43', '900')));

    const cached = queryClient.getQueryData(
      PORTFOLIO_QUERY_KEY,
    ) as PortfolioSnapshot;
    expect(cached.accountSequence).toBe('43');
    expect(cached.wallets[0]?.available).toBe('900');
  });

  it('publishes nothing the REST response would not have answered', () => {
    const { queryClient } = setup(complete('42', '1000'));
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());

    act(() => socket.receive(patch('43', '900')));

    // The sequence is asserted alongside the key set on purpose. Checking the
    // keys alone would pass while nothing writes at all — the seeded snapshot
    // is already REST-shaped — and a test that cannot tell "written correctly"
    // from "never written" is worse than no test, because it reads as cover.
    const cached = queryClient.getQueryData(
      PORTFOLIO_QUERY_KEY,
    ) as PortfolioSnapshot;
    expect(cached.accountSequence).toBe('43');
    expect(Object.keys(cached).sort()).toEqual([
      'accountSequence',
      'activeOrders',
      'market',
      'positions',
      'reservations',
      'sessionId',
      'wallets',
    ]);
  });

  it('never lets a slow refetch land a sequence older than the cache holds', async () => {
    // The publish guard only governs this hook's own writes. A refetch — an
    // order invalidating the portfolio, the FX ticket, `requestRefresh` after
    // a reconnect — lands through react-query's own success path, and one
    // issued before the stream moved can answer with an older snapshot. The
    // cache would go backwards, wallets and all, until the next event tripped
    // the gap check: the very staleness this change exists to remove.
    const fetchSnapshot = vi.fn(async () => complete('43', '700'));
    const { queryClient } = setup(complete('42', '1000'), { fetchSnapshot });
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());
    act(() => socket.receive(patch('43', '900')));
    act(() => socket.receive(patch('44', '800')));

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: PORTFOLIO_QUERY_KEY });
    });

    const cached = queryClient.getQueryData(
      PORTFOLIO_QUERY_KEY,
    ) as PortfolioSnapshot;
    expect(cached.accountSequence).toBe('44');
    expect(cached.wallets[0]?.available).toBe('800');
  });

  it('still lets a refetch answering the same sequence win', async () => {
    // The FX conversion case: balances move without the sequence advancing,
    // so a tie must go to the refetch. Only strictly backwards is refused.
    const fetchSnapshot = vi.fn(async () => complete('43', '700'));
    const { queryClient } = setup(complete('42', '1000'), { fetchSnapshot });
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());
    act(() => socket.receive(patch('43', '900')));

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: PORTFOLIO_QUERY_KEY });
    });

    expect(
      (queryClient.getQueryData(PORTFOLIO_QUERY_KEY) as PortfolioSnapshot)
        .wallets[0]?.available,
    ).toBe('700');
  });

  it('never writes back over a refetch that did not advance the sequence', () => {
    // An FX conversion moves balances through `invalidateQueries` and is
    // answered by a refetch that does not advance the account sequence — the
    // stream carries no event for it. Publishing a snapshot that merely
    // restates the cached sequence would put the pre-conversion balances back
    // over that refetch, which is exactly what an e2e journey caught.
    const { queryClient } = setup(complete('42', '1000'));
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());
    act(() => socket.receive(patch('43', '900')));

    // The refetch answers the same sequence with balances only it knows about.
    act(() => {
      queryClient.setQueryData(PORTFOLIO_QUERY_KEY, complete('43', '800'));
    });

    expect(
      (queryClient.getQueryData(PORTFOLIO_QUERY_KEY) as PortfolioSnapshot)
        .wallets[0]?.available,
    ).toBe('800');
  });

  it('leaves the cache alone when the patch is refused', () => {
    // A gap means the snapshot in hand is no longer trustworthy. Writing a
    // half-applied one would hand every reader a state the server never sent,
    // which is worse than the staleness this whole change is fixing.
    const { queryClient } = setup(complete('42', '1000'));
    const socket = FakeSocket.instances[0] as FakeSocket;
    act(() => socket.open());

    act(() => socket.receive(patch('99', '900')));

    expect(
      (queryClient.getQueryData(PORTFOLIO_QUERY_KEY) as PortfolioSnapshot)
        .wallets[0]?.available,
    ).toBe('1000');
  });
});
