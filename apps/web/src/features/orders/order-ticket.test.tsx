import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client';
import type { QuoteSnapshot } from '../../lib/api-types';
import '../../lib/i18n';
import { OrderTicket } from './order-ticket';

afterEach(cleanup);

const APPLE_QUOTE: QuoteSnapshot = {
  market: 'US',
  symbol: 'AAPL',
  price: '326.30',
  asOf: '2026-09-01T00:00:00Z',
  currency: 'USD',
  bids: [{ price: '326.31', volume: '10' }],
  asks: [{ price: '326.35', volume: '4' }],
};

const api = { post: vi.fn().mockResolvedValue({}) };

function renderTicket(props: Record<string, unknown> = {}) {
  // The ticket places orders through react-query; retries are off so a
  // rejected placement surfaces its error on the first attempt.
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OrderTicket
        market="US"
        symbol="AAPL"
        apiClient={api as never}
        quote={APPLE_QUOTE}
        currency="USD"
        {...props}
      />
    </QueryClientProvider>,
  );
}

const quantity = () => screen.getByLabelText('Quantity');
const estimate = () => document.querySelector('.order-estimate');

describe('OrderTicket estimate', () => {
  it('shows nothing until a quantity is typed', () => {
    renderTicket();

    expect(estimate()).toHaveTextContent('');
  });

  it('prices a MARKET BUY off the best ask, behind an approximation mark', () => {
    renderTicket();

    fireEvent.change(quantity(), { target: { value: '3' } });

    expect(screen.getByText('Estimated ≈ $979.05')).toBeVisible();
  });

  it('prices a MARKET SELL off the best bid, a client-side symmetry', () => {
    renderTicket();

    fireEvent.click(screen.getByRole('radio', { name: 'Sell' }));
    fireEvent.change(quantity(), { target: { value: '3' } });

    expect(screen.getByText('Estimated ≈ $978.93')).toBeVisible();
  });

  it("prices a LIMIT order off the reader's own price", () => {
    renderTicket();

    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'LIMIT' },
    });
    fireEvent.change(quantity(), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Price'), {
      target: { value: '300' },
    });

    expect(screen.getByText('Estimated ≈ $900')).toBeVisible();
  });

  it('spans both legs of an OCO order', () => {
    renderTicket();

    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'OCO' },
    });
    fireEvent.change(quantity(), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Price'), {
      target: { value: '340' },
    });
    fireEvent.change(screen.getByLabelText('Stop price'), {
      target: { value: '300' },
    });

    expect(screen.getByText('Estimated ≈ $600 – $680')).toBeVisible();
  });

  it('groups a won amount and uses the won symbol', () => {
    renderTicket({
      market: 'KR',
      symbol: '005930',
      currency: 'KRW',
      quote: {
        market: 'KR',
        symbol: '005930',
        price: '69900',
        asOf: '2026-09-01T00:00:00Z',
        currency: 'KRW',
        asks: [{ price: '70000', volume: '2' }],
      },
    });

    fireEvent.change(quantity(), { target: { value: '3' } });

    expect(screen.getByText('Estimated ≈ ₩210,000')).toBeVisible();
  });

  it('says so plainly when no price has arrived to estimate from', () => {
    renderTicket({ quote: null });

    fireEvent.change(quantity(), { target: { value: '3' } });

    expect(screen.getByText('Estimated — no price available')).toBeVisible();
  });

  // A deep link or a pending selection can leave the previous instrument's
  // quote beside a freshly mounted ticket; pricing an AAPL order off Samsung's
  // book would be worse than showing nothing.
  it('refuses a quote that names another instrument', () => {
    renderTicket({
      quote: { ...APPLE_QUOTE, market: 'KR', symbol: '005930' },
    });

    fireEvent.change(quantity(), { target: { value: '3' } });

    expect(screen.getByText('Estimated — no price available')).toBeVisible();
  });

  it.each(['0', '1.5', 'abc'])(
    'stays quiet rather than throwing on the quantity %o',
    (value) => {
      renderTicket();

      fireEvent.change(quantity(), { target: { value } });

      expect(estimate()).toHaveTextContent('');
    },
  );

  // A polite region that changes on every keystroke queues an announcement per
  // digit — "$326.35", "$3,263.5", "$32,635" for a quantity of 100 — for two
  // values the reader never meant. The visible line still updates instantly;
  // only what is spoken waits for the typing to settle.
  it('shows the estimate per keystroke but announces once typing settles', () => {
    vi.useFakeTimers();
    try {
      renderTicket();
      const live = document.querySelector('.order-estimate-live');
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(estimate()).not.toHaveAttribute('aria-live');

      fireEvent.change(quantity(), { target: { value: '1' } });
      fireEvent.change(quantity(), { target: { value: '10' } });

      expect(estimate()).toHaveTextContent('Estimated ≈ $3,263.5');
      expect(live).toHaveTextContent('');

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(live).toHaveTextContent('Estimated ≈ $3,263.5');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OrderTicket outcome', () => {
  const place = () =>
    screen.getByRole('button', { name: 'Order ticket — Place order' });

  it('says the order was accepted, not filled, and empties the quantity', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ id: 'o1', status: 'OPEN', filledQuantity: '0' });
    renderTicket({ apiClient: { post } });

    fireEvent.change(quantity(), { target: { value: '3' } });
    fireEvent.click(place());

    // The follow-up the old wording promised in prose is now a job the fill
    // toast does: this line only has to confirm the request landed.
    expect(await screen.findByText('Order accepted.')).toBeVisible();
    expect(quantity()).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says a conditional order is waiting for its trigger', async () => {
    const post = vi.fn().mockResolvedValue({
      id: 'o2',
      status: 'PENDING_TRIGGER',
      filledQuantity: '0',
    });
    renderTicket({ apiClient: { post } });

    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'STOP' },
    });
    fireEvent.change(quantity(), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Price'), {
      target: { value: '300' },
    });
    fireEvent.click(place());

    // A trigger order keeps its second sentence: nothing announces the
    // waiting, and waiting is the whole difference from a market order.
    expect(
      await screen.findByText(
        'Order accepted. It waits for its trigger price.',
      ),
    ).toBeVisible();
  });

  it('announces the outcome politely, not as an alert', async () => {
    const post = vi.fn().mockResolvedValue({ status: 'OPEN' });
    renderTicket({ apiClient: { post } });

    fireEvent.change(quantity(), { target: { value: '1' } });
    fireEvent.click(place());

    expect(await screen.findByRole('status')).toHaveAttribute(
      'id',
      'order-outcome',
    );
  });

  it('turns a public error code into a sentence and keeps the quantity', async () => {
    const post = vi.fn().mockRejectedValue(
      new ApiError(
        {
          code: 'INSUFFICIENT_AVAILABLE_CASH',
          message: 'not enough cash',
          retryable: false,
          requestId: 'req-9',
        },
        409,
      ),
    );
    renderTicket({ apiClient: { post } });

    fireEvent.change(quantity(), { target: { value: '3' } });
    fireEvent.click(place());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not enough available cash for this order',
    );
    // The order was refused: what the reader typed is still there to fix.
    expect(quantity()).toHaveValue('3');
    // The support handle is kept, but out of the sentence the reader reads.
    expect(screen.getByText('Request ID: req-9')).toBeVisible();
  });

  it('names an unrecognised code instead of rendering the error object', async () => {
    const post = vi.fn().mockRejectedValue(
      new ApiError(
        {
          code: 'BRAND_NEW_CODE',
          message: 'internal prose',
          retryable: false,
          requestId: 'req-3',
        },
        409,
      ),
    );
    renderTicket({ apiClient: { post } });

    fireEvent.change(quantity(), { target: { value: '3' } });
    fireEvent.click(place());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Order rejected (code: BRAND_NEW_CODE)',
    );
    expect(screen.queryByText(/internal prose/)).not.toBeInTheDocument();
  });

  it('falls back to a plain rejection when the request never reached the API', async () => {
    const post = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    renderTicket({ apiClient: { post } });

    fireEvent.change(quantity(), { target: { value: '3' } });
    fireEvent.click(place());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Order rejected',
    );
  });

  // The e2e keyboard journey asserts this exact string on the alert.
  it('still reports a client-side validation failure verbatim', () => {
    renderTicket();

    fireEvent.change(quantity(), { target: { value: '0' } });
    fireEvent.click(place());

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Quantity must be a positive whole number',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('replaces a standing success with the next attempt outcome', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 'OPEN' })
      .mockRejectedValueOnce(
        new ApiError(
          {
            code: 'RATE_LIMITED',
            message: 'slow down',
            retryable: true,
            requestId: 'req-4',
          },
          429,
        ),
      );
    renderTicket({ apiClient: { post } });

    fireEvent.change(quantity(), { target: { value: '1' } });
    fireEvent.click(place());
    await screen.findByRole('status');

    fireEvent.change(quantity(), { target: { value: '1' } });
    fireEvent.click(place());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests — try again in a moment',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
