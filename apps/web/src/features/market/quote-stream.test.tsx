import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../lib/i18n';
import { QuotePanel } from './quote-panel';
import { QuoteSparkline } from './quote-sparkline';
import type { TickPoint } from './sparkline';
import { useQuoteStream } from './use-quote-stream';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed: { code: number | undefined; reason: string | undefined } | undefined;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.onclose?.();
  }
  deliver(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

// Stable across renders: the hook re-subscribes when its options change.
const OPTIONS = {
  webSocketFactory: (url: string) => new FakeSocket(url) as never,
  random: () => 0.5,
};

const quotePayload = (price: string, asOf: string) => ({
  market: 'US',
  symbol: 'AAPL',
  price,
  asOf,
  health: 'HEALTHY',
});

function Harness({
  market,
  symbol,
  apiClient,
}: {
  market?: 'KR' | 'US';
  symbol?: string;
  apiClient: unknown;
}) {
  const { quote } = useQuoteStream(market, symbol, apiClient as never, OPTIONS);
  return <QuotePanel quote={quote} />;
}

describe('useQuoteStream', () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  it('subscribes to the selected symbol and renders pushed quotes', async () => {
    const api = { get: vi.fn().mockResolvedValue(quotePayload('200', 't0')) };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);

    expect(await screen.findByText('200')).toBeVisible();
    const socket = FakeSocket.instances[0];
    expect(socket?.url).toContain('quoteSymbols=US%3AAAPL');

    act(() => {
      socket?.deliver({
        type: 'quote',
        market: 'US',
        symbol: 'AAPL',
        recoveryEpoch: '1',
        marketDataVersion: '1',
        payload: quotePayload('205', 't1'),
      });
    });
    expect(await screen.findByText('205')).toBeVisible();
  });

  it('ignores pushes for another symbol', async () => {
    const api = { get: vi.fn().mockResolvedValue(quotePayload('200', 't0')) };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('200');

    act(() => {
      FakeSocket.instances[0]?.deliver({
        type: 'quote',
        market: 'US',
        symbol: 'MSFT',
        recoveryEpoch: '1',
        marketDataVersion: '1',
        payload: { ...quotePayload('999', 't1'), symbol: 'MSFT' },
      });
    });
    expect(screen.getByText('200')).toBeVisible();
    expect(screen.queryByText('999')).toBeNull();
  });

  it('closes the socket on unmount and opens a fresh one per symbol', async () => {
    const api = { get: vi.fn().mockResolvedValue(quotePayload('200', 't0')) };
    const view = render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('200');

    view.rerender(<Harness market="US" symbol="MSFT" apiClient={api} />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(FakeSocket.instances[0]?.closed?.code).toBe(1000);
    expect(FakeSocket.instances[1]?.url).toContain('quoteSymbols=US%3AMSFT');

    view.unmount();
    expect(FakeSocket.instances[1]?.closed?.code).toBe(1000);
  });

  it('never lets a slow snapshot overwrite the newer symbol', async () => {
    let resolveSlow: ((value: unknown) => void) | undefined;
    const api = {
      get: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSlow = resolve;
            }),
        )
        .mockResolvedValue({ ...quotePayload('300', 't9'), symbol: 'MSFT' }),
    };
    const view = render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    view.rerender(<Harness market="US" symbol="MSFT" apiClient={api} />);
    expect(await screen.findByText('300')).toBeVisible();

    // The AAPL response lands late and must be discarded.
    act(() => resolveSlow?.(quotePayload('200', 't0')));
    await waitFor(() => expect(screen.getByText('300')).toBeVisible());
  });

  it('clears the quote when the instrument load fails', async () => {
    const api = { get: vi.fn().mockRejectedValue(new Error('down')) };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    expect(
      await screen.findByText('Select an instrument to see its quote.'),
    ).toBeVisible();
  });
});

describe('QuoteSparkline', () => {
  const ticks = (prices: readonly string[]): TickPoint[] =>
    prices.map((price, index) => ({ asOf: `t${index}`, price }));

  it('draws a polyline and summarises the range for screen readers', () => {
    render(<QuoteSparkline ticks={ticks(['10', '20.50', '15'])} />);
    const polyline = document.querySelector('polyline');
    expect(polyline).not.toBeNull();
    expect(polyline?.getAttribute('points')?.split(' ')).toHaveLength(3);
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      screen.getByText('Last 3 ticks, high 20.50, low 10'),
    ).toBeInTheDocument();
  });

  it('shows the collecting state until a second point arrives', () => {
    render(<QuoteSparkline ticks={ticks(['10'])} />);
    expect(screen.getByText('Collecting chart data…')).toBeVisible();
    expect(document.querySelector('polyline')).toBeNull();
  });

  it('drops unparseable prices instead of throwing', () => {
    render(<QuoteSparkline ticks={ticks(['—', '10', 'N/A', '12'])} />);
    expect(document.querySelector('polyline')?.getAttribute('points')).toBe(
      '2.00,46.00 238.00,2.00',
    );
  });

  it('renders the Korean summary, the product default', async () => {
    await act(() => i18n.changeLanguage('ko'));
    render(<QuoteSparkline ticks={ticks(['10', '12'])} />);
    expect(screen.getByText('최근 2틱, 최고 12, 최저 10')).toBeInTheDocument();
  });
});
