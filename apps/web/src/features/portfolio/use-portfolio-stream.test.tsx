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
  wallets: [],
  positions: [],
  reservations: [],
  activeOrders: [],
  accountSequence,
  market: { health: {}, recoveryFill: {} },
});

function setup(seed?: PortfolioSnapshot | { accountSequence: string }) {
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
  const options = { webSocketFactory: factory, random: () => 0.5 };
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
    for (const sequence of ['43', '44', '45'])
      act(() =>
        first.receive({
          type: 'event',
          eventId: `e${sequence}`,
          accountSequence: sequence,
          payload: {},
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
