import { decimal } from './decimal.js';
import { DomainError } from './domain-errors.js';
import type { PositionSnapshot, WalletSnapshot } from './reservation.js';

export interface AccountSnapshot {
  readonly wallets: readonly WalletSnapshot[];
  readonly positions: readonly PositionSnapshot[];
}

function invariantViolation(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function nonNegativeDecimal(value: string, description: string) {
  try {
    const result = decimal(value);
    if (result.isNegative()) {
      invariantViolation(`${description} must not be negative`);
    }
    return result;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    invariantViolation(`${description} must be a decimal string`);
  }
}

export function assertAccountInvariants(account: AccountSnapshot): void {
  const currencies = new Set<string>();
  for (const wallet of account.wallets) {
    if (
      (wallet.currency !== 'KRW' && wallet.currency !== 'USD') ||
      currencies.has(wallet.currency)
    ) {
      invariantViolation(
        'Account must contain at most one wallet per currency',
      );
    }
    currencies.add(wallet.currency);

    const total = nonNegativeDecimal(
      wallet.total,
      `Wallet ${wallet.currency} total`,
    );
    const available = nonNegativeDecimal(
      wallet.available,
      `Wallet ${wallet.currency} available`,
    );
    const reserved = nonNegativeDecimal(
      wallet.reserved,
      `Wallet ${wallet.currency} reserved`,
    );
    if (!total.eq(available.plus(reserved))) {
      invariantViolation(
        `Wallet ${wallet.currency} total must equal available plus reserved`,
      );
    }
  }

  const symbols = new Set<string>();
  for (const position of account.positions) {
    if (position.symbol.trim().length === 0 || symbols.has(position.symbol)) {
      invariantViolation(
        'Account must contain at most one position per symbol',
      );
    }
    symbols.add(position.symbol);

    const total = nonNegativeDecimal(
      position.total,
      `Position ${position.symbol} total`,
    );
    const available = nonNegativeDecimal(
      position.available,
      `Position ${position.symbol} available`,
    );
    const reserved = nonNegativeDecimal(
      position.reserved,
      `Position ${position.symbol} reserved`,
    );
    if (!total.eq(available.plus(reserved))) {
      invariantViolation(
        `Position ${position.symbol} total must equal available plus reserved`,
      );
    }
  }
}
