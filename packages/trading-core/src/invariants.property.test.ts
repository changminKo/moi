import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { assertAccountInvariants } from './invariants.js';
import {
  type PositionSnapshot,
  releaseReservation,
  reserveCash,
  reservePosition,
  type WalletSnapshot,
} from './reservation.js';

const propertySeed = 220826;

type CashOperation =
  | { readonly type: 'reserve'; readonly amount: string }
  | { readonly type: 'release'; readonly amount: string };

const cashOperationArbitrary = fc.array(
  fc.record({
    type: fc.constantFrom('reserve', 'release'),
    amount: fc.integer({ min: 0, max: 1000 }).map(String),
  }),
  { maxLength: 100 },
);

const initialWallet = (): WalletSnapshot => ({
  currency: 'KRW',
  total: '1000',
  available: '1000',
  reserved: '0',
  version: 1n,
});

const initialPosition = (): PositionSnapshot => ({
  symbol: '005930',
  total: '1000',
  available: '1000',
  reserved: '0',
  version: 1n,
});

const assertProperty = (property: fc.IProperty<unknown>): void => {
  try {
    fc.assert(property, { seed: propertySeed, verbose: 2 });
  } catch (error) {
    throw new Error(
      `Reservation property failed with deterministic seed ${propertySeed}; fast-check reports the replay path in the cause.`,
      { cause: error },
    );
  }
};

describe('account reservation invariants', () => {
  it('preserves independently calculated cash conservation through serializable reserve/release sequences', () => {
    assertProperty(
      fc.property(cashOperationArbitrary, (operations) => {
        const serializedFixture = JSON.stringify(operations);
        let wallet = initialWallet();
        let available = 1000n;
        let reserved = 0n;

        for (const operation of operations as CashOperation[]) {
          const amount = BigInt(operation.amount);
          if (operation.type === 'reserve' && amount <= available) {
            wallet = reserveCash(wallet, operation.amount);
            available -= amount;
            reserved += amount;
          }

          if (operation.type === 'release' && amount <= reserved) {
            wallet = releaseReservation(wallet, operation.amount);
            available += amount;
            reserved -= amount;
          }

          expect(JSON.stringify(operations)).toBe(serializedFixture);
          expect(wallet).toMatchObject({
            total: '1000',
            available: available.toString(),
            reserved: reserved.toString(),
          });
          assertAccountInvariants({ wallets: [wallet], positions: [] });
        }
      }),
    );
  });

  it('keeps KRW/USD wallets and independently tracked symbols separate', () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (krwAmount, usdAmount, samsungAmount) => {
          const krw = reserveCash(initialWallet(), String(krwAmount));
          const usd = reserveCash(
            { ...initialWallet(), currency: 'USD', version: 4n },
            String(usdAmount),
          );
          const samsung = reservePosition(
            initialPosition(),
            String(samsungAmount),
          );
          const skHynix = initialPosition();
          const skHynixWithSymbol = { ...skHynix, symbol: '000660' };

          expect(krw.currency).toBe('KRW');
          expect(usd.currency).toBe('USD');
          expect(samsung.symbol).toBe('005930');
          expect(skHynixWithSymbol).toEqual({
            ...initialPosition(),
            symbol: '000660',
          });
          assertAccountInvariants({
            wallets: [krw, usd],
            positions: [samsung, skHynixWithSymbol],
          });
        },
      ),
    );
  });

  it('rejects broken totals, negative balances, and duplicate asset identities', () => {
    expect(() =>
      assertAccountInvariants({
        wallets: [{ ...initialWallet(), available: '999' }],
        positions: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
    expect(() =>
      assertAccountInvariants({
        wallets: [],
        positions: [
          { ...initialPosition(), available: '-1', reserved: '1001' },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
    expect(() =>
      assertAccountInvariants({
        wallets: [initialWallet(), { ...initialWallet(), version: 2n }],
        positions: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });
});
