import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../lib/query-client';
import { TradePage } from './trade-page';

afterEach(() => {
  cleanup();
  // The page reads the wallets from the shared query cache; without this a
  // later test would render the balances an earlier one had cached.
  queryClient.clear();
});

const api = {
  get: vi.fn(async (path: string) => {
    if (path.startsWith('/api/v1/instruments'))
      return [
        { market: 'US', symbol: 'AAPL', name: 'Apple', tradable: true },
        { market: 'US', symbol: 'XYZ', name: 'Private', tradable: false },
        { market: 'KR', symbol: '005930', name: '005930', tradable: true },
      ];
    if (path.includes('/quote'))
      return {
        market: 'US',
        symbol: 'AAPL',
        price: '189.10',
        asOf: '2026-08-25T00:00:00Z',
        health: 'HEALTHY',
        recoveryEpoch: '1',
        marketDataVersion: '2',
        bids: [{ price: '189.09', size: '10' }],
        asks: [{ price: '189.11', size: '8' }],
      };
    if (path === '/api/v1/portfolio')
      return {
        wallets: [
          { currency: 'KRW', available: '1000', reserved: '10', total: '1010' },
          { currency: 'USD', available: '20', reserved: '2', total: '22' },
        ],
      };
    return [];
  }),
  post: vi.fn(),
};

// MemoryRouter keeps a real history stack; this exposes it to the test the
// way a browser's back/forward buttons would.
function WithHistoryControls({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>
        history back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        history forward
      </button>
      {children}
    </>
  );
}

describe('TradePage', () => {
  it('omits the duplicate parenthesized symbol for a fallback name', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade']}>{children}</MemoryRouter>
      ),
    });

    expect(
      await screen.findByRole('button', { name: /^005930$/ }),
    ).toBeVisible();
    expect(screen.queryByText('(005930)')).not.toBeInTheDocument();
  });

  it('renders search results, quote depth, and separate wallet amounts', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade?symbol=AAPL']}>
          {children}
        </MemoryRouter>
      ),
    });
    expect(await screen.findByText(/Apple/)).toBeVisible();
    expect(await screen.findByText('189.10')).toBeVisible();
    expect(screen.getByText('HEALTHY')).toBeVisible();
    expect(screen.getByText('KRW')).toBeVisible();
    expect(screen.getAllByText('available')).toHaveLength(2);
  });

  it('keeps the full list, toggles the selection off, and resets via Show all', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade?symbol=AAPL']}>
          {children}
        </MemoryRouter>
      ),
    });
    // Deep link selects AAPL but the list is not narrowed to it.
    expect(await screen.findByText('189.10')).toBeVisible();
    const apple = await screen.findByRole('button', {
      name: /Apple \(AAPL\)/,
    });
    expect(
      await screen.findByRole('button', { name: /Private \(XYZ\)/ }),
    ).toBeVisible();

    // Clicking the selected row again deselects it.
    fireEvent.click(apple);
    expect(
      await screen.findByText('Select an instrument to see its quote.'),
    ).toBeVisible();
    const reset = screen.getByRole('button', { name: 'Show all' });
    expect(reset).toBeDisabled();

    // A search enables the reset control, which clears the query.
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'AAPL' },
    });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    expect(screen.getByLabelText('Search')).toHaveValue('');
    expect(reset).toBeDisabled();

    // Keyboard fast path: tabbing out of the search box must reach the first
    // result, so the reset control has to follow the list in the DOM.
    const list = screen.getByRole('list');
    expect(
      list.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('focuses the deep-linked row once, like following an anchor link', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade?symbol=AAPL']}>
          {children}
        </MemoryRouter>
      ),
    });
    const apple = await screen.findByRole('button', { name: /Apple \(AAPL\)/ });
    await waitFor(() => expect(apple).toHaveFocus());

    // Spent: selecting another row must not move focus onto it. (jsdom does
    // not focus what a click activates, so focus staying on the old row is
    // exactly the absence of a programmatic move.)
    const other = screen.getByRole('button', { name: /Private \(XYZ\)/ });
    fireEvent.click(other);
    await screen.findByText('This instrument is not tradable');
    expect(other).not.toHaveFocus();
  });

  it('does not steal focus for an ordinary click selection', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade']}>{children}</MemoryRouter>
      ),
    });
    const apple = await screen.findByRole('button', { name: /Apple \(AAPL\)/ });
    fireEvent.click(apple);
    expect(await screen.findByText('189.10')).toBeVisible();
    // The browser focuses what the pointer activates; the page must not add a
    // programmatic focus of its own on top of that.
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus alone when the deep-linked symbol is not listed', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade?symbol=MSFT']}>
          {children}
        </MemoryRouter>
      ),
    });
    await screen.findByRole('button', { name: /Apple \(AAPL\)/ });
    expect(document.activeElement).toBe(document.body);
  });

  it('follows browser back and forward through the selection', async () => {
    render(
      <WithHistoryControls>
        <TradePage apiClient={api as never} />
      </WithHistoryControls>,
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/trade']}>{children}</MemoryRouter>
        ),
      },
    );
    // Select AAPL, which pushes ?symbol=AAPL.
    fireEvent.click(await screen.findByRole('button', { name: /Apple/ }));
    expect(await screen.findByText('189.10')).toBeVisible();

    // Back returns to the unselected URL and clears the quote.
    fireEvent.click(screen.getByRole('button', { name: 'history back' }));
    expect(
      await screen.findByText('Select an instrument to see its quote.'),
    ).toBeVisible();

    // Forward restores the selection from the URL alone.
    fireEvent.click(screen.getByRole('button', { name: 'history forward' }));
    expect(await screen.findByText('189.10')).toBeVisible();
  });

  it('marks non-tradable selections and disables the order ticket', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade?symbol=XYZ']}>
          {children}
        </MemoryRouter>
      ),
    });
    expect(
      await screen.findByText('This instrument is not tradable'),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /order/i })).toBeDisabled(),
    );
  });
});

/**
 * The wallet panel on this page used to hold a private, one-shot copy of the
 * portfolio: an effect read `/api/v1/portfolio` once into local state, and the
 * `invalidateQueries` the FX ticket was handed fired a request whose answer
 * nobody kept. So a conversion could never move the balances on screen. The
 * wallets now read from the shared `PORTFOLIO_QUERY_KEY` cache, the one the FX
 * ticket and `useOrderMutations` already invalidate.
 */
describe('TradePage wallet after a conversion', () => {
  // Distinct reserved/total, so the available figure asserted below is the
  // only node carrying that text.
  const wallets = (usd: string, total: string) => ({
    wallets: [
      { currency: 'KRW', available: '1000', reserved: '3', total: '1003' },
      { currency: 'USD', available: usd, reserved: '2', total },
    ],
  });

  function fakeApi() {
    let conversions = 0;
    return {
      conversions: () => conversions,
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/api/v1/instruments')) return [];
        if (path === '/api/v1/portfolio')
          return conversions === 0
            ? wallets('20', '22')
            : wallets('720.7', '722.7');
        return [];
      }),
      post: vi.fn(async (path: string) => {
        if (path === '/api/v1/fx/quotes')
          return {
            quoteId: 'q1',
            rate: '0.0007',
            fee: '1',
            sourceAmount: '1000',
            destinationAmount: '700.7',
            expiresAt: '2099-01-01T00:00:00Z',
          };
        conversions += 1;
        return { ok: true };
      }),
    };
  }

  it('refetches the portfolio so the new balances are on screen', async () => {
    const api = fakeApi();
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade']}>{children}</MemoryRouter>
      ),
    });
    expect(await screen.findByText('$20')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Convert' }));

    expect(await screen.findByText('$720.7')).toBeVisible();
    expect(api.conversions()).toBe(1);
  });
});

describe('TradePage order estimate', () => {
  it('hands the selected instrument quote and currency to the ticket', async () => {
    const api = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/api/v1/instruments'))
          return [
            {
              market: 'US',
              symbol: 'AAPL',
              name: 'Apple',
              tradable: true,
              currency: 'USD',
            },
          ];
        if (path.includes('/quote'))
          return {
            market: 'US',
            symbol: 'AAPL',
            price: '326.30',
            asOf: '2026-09-01T00:00:00Z',
            health: 'HEALTHY',
            currency: 'USD',
            bids: [{ price: '326.31', volume: '10' }],
            asks: [{ price: '326.35', volume: '4' }],
          };
        if (path === '/api/v1/portfolio') return { wallets: [] };
        return [];
      }),
      post: vi.fn(),
    };
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade?symbol=AAPL']}>
          {children}
        </MemoryRouter>
      ),
    });
    // The panel prices in dollars now that the instrument states its currency.
    expect(await screen.findByText('$326.30')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Quantity'), {
      target: { value: '3' },
    });

    expect(screen.getByText('Estimated ≈ $979.05')).toBeVisible();
  });
});
