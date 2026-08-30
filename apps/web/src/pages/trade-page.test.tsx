import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TradePage } from './trade-page';

afterEach(cleanup);

const api = {
  get: vi.fn(async (path: string) => {
    if (path.startsWith('/api/v1/instruments'))
      return [
        { market: 'US', symbol: 'AAPL', name: 'Apple', tradable: true },
        { market: 'US', symbol: 'XYZ', name: 'Private', tradable: false },
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

describe('TradePage', () => {
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
  });

  it('marks non-tradable selections and disables the order ticket', async () => {
    render(<TradePage apiClient={api as never} />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/trade?symbol=XYZ']}>
          {children}
        </MemoryRouter>
      ),
    });
    expect(await screen.findByText('SYMBOL_NOT_TRADABLE')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /order/i })).toBeDisabled(),
    );
  });
});
