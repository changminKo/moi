import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Wallet } from '../../lib/api-types';
import { WalletSummary } from './wallet-summary';

afterEach(cleanup);

describe('WalletSummary', () => {
  it('caps a longer fraction to 2 digits for display, same rule as the FX ticket', () => {
    const wallets: readonly Wallet[] = [
      {
        currency: 'USD',
        available: '233.3331',
        reserved: '0',
        total: '233.3331',
      },
    ];
    render(<WalletSummary wallets={wallets} />);
    // "233.3331" caps to "233.33" — the ledger value itself is untouched,
    // only this render trims it.
    expect(screen.getAllByText(/\$233\.33$/)).toHaveLength(2);
    expect(screen.queryByText(/233\.3331/)).not.toBeInTheDocument();
  });

  it('never pads a KRW balance that has no fraction at all', () => {
    const wallets: readonly Wallet[] = [
      {
        currency: 'KRW',
        available: '10000000',
        reserved: '0',
        total: '10000000',
      },
    ];
    render(<WalletSummary wallets={wallets} />);
    expect(screen.getAllByText('₩10,000,000')).toHaveLength(2);
    expect(screen.getByText('₩0')).toBeVisible();
  });

  it('applies the same cap to available, reserved, and total alike', () => {
    const wallets: readonly Wallet[] = [
      {
        currency: 'USD',
        available: '10.1',
        reserved: '5.005',
        total: '15.105',
      },
    ];
    render(<WalletSummary wallets={wallets} />);
    // "10.1" is already within the cap and must not be padded to "10.10".
    expect(screen.getByText('$10.1')).toBeVisible();
    // "5.005" and "15.105" both round half-up across the cap boundary.
    expect(screen.getByText('$5.01')).toBeVisible();
    expect(screen.getByText('$15.11')).toBeVisible();
  });
});
