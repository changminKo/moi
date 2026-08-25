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
    expect(await screen.findByText(/0\.0007/)).toBeVisible();
    const submit = screen.getByRole('button', { name: /convert/i });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(invalidateQueries).toHaveBeenCalled();
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
