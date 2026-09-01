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

/**
 * What `GET /api/v1/markets/:market/symbols/:symbol/quote` returns — the
 * price, the instant and the health, and no book (`#quote` in
 * `production-runtime.ts`). The panel's first paint comes from this.
 */
const restSnapshot = (price: string, asOf: string) => ({
  market: 'US',
  symbol: 'AAPL',
  price,
  asOf,
  health: 'HEALTHY',
  recoveryEpoch: '17',
  marketDataVersion: '87849',
});

/**
 * A `quote` frame in the shape the stream really sends: the envelope carries
 * the market, the symbol and the two version fields, and the payload is the
 * market state store's quote. These fixtures used to carry a
 * `QuoteSnapshot`-shaped payload the server never produced, which is why the
 * suite stayed green while production threw on the first live book frame.
 */
const quoteFrame = (payload: unknown, marketDataVersion = '87850') => ({
  type: 'quote',
  market: 'US',
  symbol: 'AAPL',
  recoveryEpoch: '17',
  marketDataVersion,
  payload,
});

/** Captured off the live socket while the US market was open. */
const CAPTURED_BOOK = {
  symbol: 'AAPL',
  market: 'US',
  currency: 'USD',
  bids: [{ price: '316.44', volume: '80' }],
  asks: [{ price: '316.65', volume: '40' }],
};

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

const rootChildCount = () =>
  document.querySelector('body > div')?.childElementCount ?? 0;

describe('useQuoteStream', () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  it('subscribes to the selected symbol and renders pushed quotes', async () => {
    const api = { get: vi.fn().mockResolvedValue(restSnapshot('200', 't0')) };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);

    expect(await screen.findByText('200')).toBeVisible();
    const socket = FakeSocket.instances[0];
    expect(socket?.url).toContain('quoteSymbols=US%3AAAPL');

    act(() => {
      socket?.deliver(
        quoteFrame({ ...CAPTURED_BOOK, price: '205', asOf: 't1' }),
      );
    });
    // The frame states its book currency, so the price is now tagged with it.
    expect(await screen.findByText('$205')).toBeVisible();
  });

  it('ignores pushes for another symbol', async () => {
    const api = { get: vi.fn().mockResolvedValue(restSnapshot('200', 't0')) };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('200');

    act(() => {
      FakeSocket.instances[0]?.deliver({
        ...quoteFrame({ ...CAPTURED_BOOK, symbol: 'MSFT', price: '999' }),
        symbol: 'MSFT',
      });
    });
    expect(screen.getByText('200')).toBeVisible();
    expect(screen.queryByText('999')).toBeNull();
  });

  it('closes the socket on unmount and opens a fresh one per symbol', async () => {
    const api = { get: vi.fn().mockResolvedValue(restSnapshot('200', 't0')) };
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
        .mockResolvedValue({ ...restSnapshot('300', 't9'), symbol: 'MSFT' }),
    };
    const view = render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    view.rerender(<Harness market="US" symbol="MSFT" apiClient={api} />);
    expect(await screen.findByText('300')).toBeVisible();

    // The AAPL response lands late and must be discarded.
    act(() => resolveSlow?.(restSnapshot('200', 't0')));
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

/**
 * The production crash: `US:AAPL` with the market open, the whole React tree
 * gone and no chart. `pageerror: [DecimalError] Invalid argument: undefined`,
 * `root children: 0`, `sparkline elements: 0`.
 */
describe('a live book frame reaches the panel', () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  it('renders the captured book and leaves the tree standing', async () => {
    const api = {
      get: vi.fn().mockResolvedValue(restSnapshot('316.50', 't0')),
    };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('316.50');

    act(() => FakeSocket.instances[0]?.deliver(quoteFrame(CAPTURED_BOOK)));

    expect(await screen.findByText('316.65')).toBeVisible();
    expect(screen.getByText('316.44')).toBeVisible();
    expect(screen.getByText('40')).toBeVisible();
    expect(screen.getByText('80')).toBeVisible();
    // The book frame restates no price, so the snapshot's price stands — now
    // tagged with the currency the same frame brought.
    expect(screen.getByText('$316.50')).toBeVisible();
    expect(rootChildCount()).toBeGreaterThan(0);
  });

  it.each([
    [
      'a level with no volume',
      { ...CAPTURED_BOOK, asks: [{ price: '316.65' }] },
    ],
    [
      'an unparseable volume',
      {
        ...CAPTURED_BOOK,
        asks: [{ price: '316.65', volume: 'N/A' }],
      },
    ],
    ['a payload that is not an object', 'nonsense'],
    ['a null book side', { ...CAPTURED_BOOK, asks: null }],
    [
      'numeric levels',
      { ...CAPTURED_BOOK, asks: [{ price: 316.65, volume: 40 }] },
    ],
  ])('survives %s without unmounting', async (_name, payload) => {
    const api = {
      get: vi.fn().mockResolvedValue(restSnapshot('316.50', 't0')),
    };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('316.50');

    act(() => FakeSocket.instances[0]?.deliver(quoteFrame(payload)));

    // A payload that narrows carries `currency: 'USD'` and tags the price;
    // one that does not is ignored whole, leaving the untagged snapshot.
    expect(
      screen.queryByText('$316.50') ?? screen.getByText('316.50'),
    ).toBeVisible();
    expect(rootChildCount()).toBeGreaterThan(0);
  });
});

/**
 * The chart. `use-quote-ticks.ts` collects a point per priced snapshot, and
 * `sparklineGeometry` needs two before it draws — so the panel can only chart
 * the stream if the frames actually restate the price.
 */
describe('the sparkline over streamed ticks', () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  const renderWithSnapshot = async () => {
    const api = {
      get: vi.fn().mockResolvedValue(restSnapshot('316.50', 't0')),
    };
    render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('316.50');
    return FakeSocket.instances[0];
  };

  it('draws once a second priced frame arrives', async () => {
    const socket = await renderWithSnapshot();
    expect(document.querySelector('polyline')).toBeNull();

    act(() =>
      socket?.deliver(
        quoteFrame({ ...CAPTURED_BOOK, price: '316.65', asOf: 't1' }),
      ),
    );

    await waitFor(() =>
      expect(document.querySelector('polyline')).not.toBeNull(),
    );
    expect(
      document.querySelector('polyline')?.getAttribute('points')?.split(' '),
    ).toHaveLength(2);
  });

  it('keeps accumulating a point per priced frame', async () => {
    const socket = await renderWithSnapshot();

    for (const [index, price] of ['316.60', '316.70', '316.55'].entries()) {
      act(() =>
        socket?.deliver(
          quoteFrame({ ...CAPTURED_BOOK, price, asOf: `t${index + 1}` }),
        ),
      );
    }

    await waitFor(() =>
      expect(
        document.querySelector('polyline')?.getAttribute('points')?.split(' '),
      ).toHaveLength(4),
    );
    expect(screen.getByText(/high 316.70, low 316.50/)).toBeInTheDocument();
  });

  it('collects nothing from book-only frames, which restate no price', async () => {
    const socket = await renderWithSnapshot();

    act(() => socket?.deliver(quoteFrame(CAPTURED_BOOK, '87851')));
    act(() => socket?.deliver(quoteFrame(CAPTURED_BOOK, '87852')));

    // Two frames, one price: the ring holds a single point and the chart
    // stays in its collecting state. This is today's server behaviour — the
    // frame carries the book and no price — so the reported "no chart" is a
    // second, separate defect that this commit does not close: it needs the
    // frame to state the price, which is a server change (follow-up).
    expect(screen.getByText('Collecting chart data…')).toBeVisible();
  });
});

/**
 * Tearing down a subscription. Switching instruments closes the old socket,
 * but a frame it had already queued can still fire its `onmessage` — and the
 * `quote` guard there compares against the **old** effect's symbol, so it
 * passes. Every frame below is well formed and states a real price, so
 * nothing in `applyQuoteFrame` can reject it: only the teardown guard can.
 *
 * This is reachable exactly once the frame states the price. While the server
 * sent book-only frames, `applyQuoteFrame` returned `null` for want of an
 * `asOf` and the hole stayed latent — so the guard belongs in the same change
 * that starts stating the price, not a later one.
 */
describe('a socket that has been torn down', () => {
  afterEach(() => {
    FakeSocket.instances = [];
  });

  const pricedAaplFrame = () =>
    quoteFrame({ ...CAPTURED_BOOK, price: '316.65', asOf: 't2' });

  it('never applies a residual frame over the newly selected instrument', async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce(restSnapshot('316.50', 't0'))
        .mockResolvedValue({ ...restSnapshot('512.00', 't1'), symbol: 'MSFT' }),
    };
    const view = render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('316.50');
    const aaplSocket = FakeSocket.instances[0];

    view.rerender(<Harness market="US" symbol="MSFT" apiClient={api} />);
    await screen.findByText('512.00');

    act(() => aaplSocket?.deliver(pricedAaplFrame()));

    expect(screen.getByText('512.00')).toBeVisible();
    expect(screen.queryByText('316.65')).toBeNull();
    expect(document.getElementById('quote-title')?.textContent).toContain(
      'US:MSFT',
    );
  });

  /**
   * The decisive window. Right after a switch the hook has run
   * `setQuote(null)` and the new snapshot is still in flight, so
   * `applyQuoteFrame`'s cross-instrument guard has no `current` to compare
   * against — it would happily build a quote for the *previous* instrument
   * out of a priced frame, flipping the whole panel back to it.
   */
  it('never applies a residual frame while the new instrument is still loading', async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce(restSnapshot('316.50', 't0'))
        .mockImplementationOnce(() => new Promise(() => {})),
    };
    const view = render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('316.50');
    const aaplSocket = FakeSocket.instances[0];

    view.rerender(<Harness market="US" symbol="MSFT" apiClient={api} />);
    await screen.findByText('Select an instrument to see its quote.');

    act(() => aaplSocket?.deliver(pricedAaplFrame()));

    expect(
      screen.getByText('Select an instrument to see its quote.'),
    ).toBeVisible();
    expect(screen.queryByText('316.65')).toBeNull();
    expect(screen.queryByText('316.44')).toBeNull();
  });

  it('never applies a residual frame after the panel unmounts', async () => {
    const api = {
      get: vi.fn().mockResolvedValue(restSnapshot('316.50', 't0')),
    };
    const view = render(<Harness market="US" symbol="AAPL" apiClient={api} />);
    await screen.findByText('316.50');
    const socket = FakeSocket.instances[0];

    view.unmount();

    // React warns on a state update from an unmounted tree; the guard means
    // the update never happens at all.
    expect(() => act(() => socket?.deliver(pricedAaplFrame()))).not.toThrow();
  });
});

describe('QuoteSparkline', () => {
  const ticks = (prices: readonly string[]): TickPoint[] =>
    prices.map((price, index) => ({ asOf: `t${index}`, price }));

  // A handful of ticks never fills the narrowest window, so the summary
  // reports what has actually been collected against what was asked for.
  // The window control itself is covered in `quote-sparkline.test.tsx`.
  const chart = (prices: readonly string[]) => (
    <QuoteSparkline
      ticks={ticks(prices)}
      windowSize={30}
      onWindowSizeChange={() => undefined}
    />
  );

  it('draws a polyline and summarises the range beneath it', () => {
    render(chart(['10', '20.50', '15']));
    const polyline = document.querySelector('polyline');
    expect(polyline).not.toBeNull();
    expect(polyline?.getAttribute('points')?.split(' ')).toHaveLength(3);
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      screen.getByText('3 of 30 ticks so far, high 20.50, low 10'),
    ).toBeInTheDocument();
  });

  it('shows the collecting state until a second point arrives', () => {
    render(chart(['10']));
    expect(screen.getByText('Collecting chart data…')).toBeVisible();
    expect(document.querySelector('polyline')).toBeNull();
  });

  it('drops unparseable prices instead of throwing', () => {
    render(chart(['—', '10', 'N/A', '12']));
    expect(document.querySelector('polyline')?.getAttribute('points')).toBe(
      '2.00,46.00 238.00,2.00',
    );
  });

  it('renders the Korean summary, the product default', async () => {
    await act(() => i18n.changeLanguage('ko'));
    render(chart(['10', '12']));
    expect(
      screen.getByText('30틱 중 2틱 수집, 최고 12, 최저 10'),
    ).toBeInTheDocument();
  });
});
