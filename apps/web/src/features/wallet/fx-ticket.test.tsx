import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FxTicket } from './fx-ticket';

afterEach(cleanup);

describe('FxTicket', () => {
  it('quotes positive input and submits once with fresh idempotency', async () => {
    const api = {
      post: vi
        .fn()
        .mockResolvedValueOnce({
          quoteId: 'q1',
          rate: '0.0007',
          fee: '1',
          sourceAmount: '1000',
          destinationAmount: '0.6993',
          expiresAt: '2099-01-01T00:00:00Z',
        })
        .mockResolvedValueOnce({ ok: true }),
    };
    const invalidateQueries = vi.fn();
    render(
      <FxTicket
        apiClient={api as never}
        invalidateQueries={invalidateQueries}
      />,
    );
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /quote/i }));
    // The wire rate (USD per KRW, "0.0007") is inverted for display into the
    // direction and precision a person actually reads exchange rates in.
    expect(await screen.findByText(/1 USD = 1,428\.57 KRW/)).toBeVisible();
    // Amounts are grouped and carry their currency, matching the input field
    // right above the quote block and the wallet panel's ₩/$ convention.
    expect(screen.getByText(/₩1,000/)).toBeVisible();
    expect(screen.getByText(/\$0\.6993/)).toBeVisible();
    const submit = screen.getByRole('button', { name: /convert/i });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it('groups large amounts and labels a zero fee, matching the reported case', async () => {
    const api = {
      post: vi.fn().mockResolvedValueOnce({
        quoteId: 'q2',
        rate: '0.0007',
        fee: '0',
        sourceAmount: '333333',
        destinationAmount: '233.3331',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    };
    render(<FxTicket apiClient={api as never} />);
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: '333333' },
    });
    fireEvent.click(screen.getByRole('button', { name: /quote/i }));
    expect(await screen.findByText(/₩333,333/)).toBeVisible();
    expect(screen.getByText(/₩0/)).toBeVisible();
    expect(screen.getByText(/\$233\.3331/)).toBeVisible();
  });

  it('rejects non-positive amounts', () => {
    render(<FxTicket apiClient={{ post: vi.fn() } as never} />);
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: /quote/i }));
    expect(screen.getByText(/positive/i)).toBeVisible();
  });
});
