import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../lib/i18n';
import { PORTFOLIO_QUERY_KEY } from '../portfolio/use-portfolio-stream';
import { FillToastProvider } from './fill-toasts';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly close = vi.fn();
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

const order = (fills: readonly Record<string, unknown>[]) => ({
  id: 'o1',
  market: 'US',
  symbol: 'AAPL',
  type: 'MARKET',
  side: 'BUY',
  quantity: '3',
  filledQuantity: '3',
  status: 'FILLED',
  fills,
});

const fill = (id: string, quantity: string, price: string) => ({
  id,
  symbol: 'AAPL',
  quantity,
  price,
  fee: '0',
  recoveryFill: false,
});

const snapshot = (fills: readonly Record<string, unknown>[]) => ({
  wallets: [],
  positions: [],
  reservations: [],
  activeOrders: [order(fills)],
  accountSequence: '42',
  market: { health: {}, recoveryFill: {} },
});

const event = (
  payload: Readonly<Record<string, unknown>>,
  fills: readonly Record<string, unknown>[],
) => ({
  type: 'event',
  eventId: 'e1',
  accountSequence: '43',
  eventType: 'ORDER_FILLED',
  payload: { ...snapshot(fills), ...payload },
});

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(PORTFOLIO_QUERY_KEY, snapshot([]));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    <FillToastProvider
      webSocketFactory={() => new FakeSocket() as unknown as WebSocket}
    >
      <p>the page the reader was already on</p>
    </FillToastProvider>,
    { wrapper },
  );
  return FakeSocket.instances[0] as FakeSocket;
}

beforeEach(() => {
  FakeSocket.instances = [];
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('FillToastProvider', () => {
  it('announces a complete fill in the live region without moving focus', () => {
    const socket = mount();
    const region = screen.getByRole('list', { name: 'Fill notifications' });
    expect(region).toBeEmptyDOMElement();
    const before = document.activeElement;
    act(() =>
      socket.receive(
        event({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
          fill('f1', '3', '325.26'),
        ]),
      ),
    );
    expect(region).toHaveTextContent(
      'AAPL Buy 3 filled · 325.26 · order complete',
    );
    expect(document.activeElement).toBe(before);
  });

  it('announces a partial fill as progress against the order', () => {
    const socket = mount();
    act(() =>
      socket.receive(
        event(
          { orderId: 'o1', status: 'PARTIALLY_FILLED', filledQuantity: '2' },
          [fill('f1', '2', '70000')],
        ),
      ),
    );
    expect(
      screen.getByRole('list', { name: 'Fill notifications' }),
    ).toHaveTextContent('AAPL Buy 2 filled · 70,000 · 2/3');
  });

  it('speaks Korean when the app does', async () => {
    await act(async () => {
      await i18n.changeLanguage('ko');
    });
    const socket = mount();
    act(() =>
      socket.receive(
        event({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
          fill('f1', '3', '325.26'),
        ]),
      ),
    );
    expect(screen.getByRole('list', { name: '체결 알림' })).toHaveTextContent(
      'AAPL 매수 3주 체결 · 325.26 · 주문 완료',
    );
  });
});
