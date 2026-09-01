import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../lib/i18n';
import { FxTicket, formatKrwPerUsd } from './fx-ticket';

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
    // "≈" because toFixed(2) is a rounded display value, not the wire rate.
    expect(await screen.findByText(/1 USD ≈ 1,428\.57 KRW/)).toBeVisible();
    // Amounts are grouped and carry their currency, matching the input field
    // right above the quote block and the wallet panel's ₩/$ convention.
    // The fraction is capped to 2 places for display ("0.6993" -> "0.70",
    // shown without a trailing zero) — the exact wire value is untouched;
    // only the FX ticket's own render trims it.
    expect(screen.getByText(/₩1,000/)).toBeVisible();
    expect(screen.getByText(/\$0\.7$/)).toBeVisible();
    const submit = screen.getByRole('button', { name: /convert/i });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(invalidateQueries).toHaveBeenCalled();

    // The conversion is done, so the form that produced it is done too: the
    // quote block goes and the amount that was converted goes with it.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /convert/i })).toBeNull(),
    );
    expect(screen.getByLabelText(/amount/i)).toHaveValue('');
  });

  it('keeps the amount when the conversion is refused', async () => {
    const api = {
      post: vi
        .fn()
        .mockResolvedValueOnce({
          quoteId: 'q5',
          rate: '0.0007',
          fee: '1',
          sourceAmount: '1000',
          destinationAmount: '0.6993',
          expiresAt: '2099-01-01T00:00:00Z',
        })
        .mockRejectedValueOnce({ code: 'INSUFFICIENT_AVAILABLE_BALANCE' }),
    };
    render(<FxTicket apiClient={api as never} />);
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /quote/i }));
    fireEvent.click(await screen.findByRole('button', { name: /convert/i }));

    expect(await screen.findByText(/insufficient|available/i)).toBeVisible();
    expect(screen.getByLabelText(/amount/i)).toHaveValue('1,000');
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
    // "233.3331" caps to 2 fraction digits for display, not 4.
    expect(screen.getByText(/\$233\.33$/)).toBeVisible();
  });

  it('rejects non-positive amounts', () => {
    render(<FxTicket apiClient={{ post: vi.fn() } as never} />);
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: /quote/i }));
    expect(screen.getByText(/positive/i)).toBeVisible();
  });

  it('falls back to the raw rate instead of crashing on a malformed wire value', async () => {
    // quote.rate comes straight off the wire with no schema validation; a
    // non-numeric value must not unmount the panel (or the whole app — there
    // is no ErrorBoundary above it).
    const api = {
      post: vi.fn().mockResolvedValueOnce({
        quoteId: 'q3',
        rate: 'not-a-number',
        fee: '0',
        sourceAmount: '1000',
        destinationAmount: '0.6993',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    };
    render(<FxTicket apiClient={api as never} />);
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /quote/i }));
    expect(await screen.findByText(/not-a-number/)).toBeVisible();
  });

  it('falls back to the raw rate when the inverted ratio is unreadably large', async () => {
    const tinyRate = '0.000000000000000000000000000001'; // 1e-30
    const api = {
      post: vi.fn().mockResolvedValueOnce({
        quoteId: 'q4',
        rate: tinyRate,
        fee: '0',
        sourceAmount: '1000',
        destinationAmount: '0.001',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    };
    render(<FxTicket apiClient={api as never} />);
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /quote/i }));
    expect(
      await screen.findByText(new RegExp(tinyRate.replaceAll('.', '\\.'))),
    ).toBeVisible();
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });
});

describe('FxTicket in Korean', () => {
  afterEach(async () => {
    // Global test setup forces 'en'; other describes in this file assume it.
    await i18next.changeLanguage('en');
  });

  it('renders the reworded send/receive labels, not the old jargon', async () => {
    await i18next.changeLanguage('ko');
    const api = {
      post: vi.fn().mockResolvedValueOnce({
        quoteId: 'q6',
        rate: '0.0007',
        fee: '0',
        sourceAmount: '333333',
        destinationAmount: '233.3331',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    };
    render(<FxTicket apiClient={api as never} />);
    fireEvent.change(screen.getByLabelText('금액'), {
      target: { value: '333333' },
    });
    fireEvent.click(screen.getByRole('button', { name: '환율 조회' }));
    expect(await screen.findByText(/보내는 금액.*₩333,333/)).toBeVisible();
    expect(screen.getByText(/받는 금액.*\$233\.33$/)).toBeVisible();
    expect(screen.getByText(/1 USD ≈ 1,428\.57 KRW/)).toBeVisible();
    // The retired labels must not linger anywhere in the panel.
    expect(screen.queryByText('출금')).not.toBeInTheDocument();
    expect(screen.queryByText('수취')).not.toBeInTheDocument();
  });
});

describe('formatKrwPerUsd', () => {
  it('inverts and formats a plain wire rate', () => {
    expect(formatKrwPerUsd('0.0007')).toBe('1,428.57');
  });

  it('returns null for values format-number.ts would also pass through unchanged', () => {
    expect(formatKrwPerUsd('')).toBeNull();
    expect(formatKrwPerUsd('abc')).toBeNull();
    expect(formatKrwPerUsd('NaN')).toBeNull();
  });

  it('returns null for zero and negative rates instead of dividing by zero', () => {
    expect(formatKrwPerUsd('0')).toBeNull();
    expect(formatKrwPerUsd('-0.0007')).toBeNull();
  });

  it('returns null when the inverted ratio is too large to read as a rate', () => {
    expect(formatKrwPerUsd('0.000000000000000000000000000001')).toBeNull();
  });
});
