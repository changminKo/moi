import { Decimal } from 'decimal.js';

import { assertExactMoney, decimal, readExactMoney } from './decimal.js';
import { DomainError } from './domain-errors.js';
import type {
  Currency,
  DecimalString,
  Market,
  Quantity,
  Side,
} from './domain-types.js';

export type FeeRoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN';

export interface FeeScheduleConfig {
  readonly version: string;
  readonly market: Market;
  readonly currency: Currency;
  readonly commissionRate: DecimalString;
  readonly sellTaxRate: DecimalString;
  readonly roundingDecimals: number;
  readonly roundingMode: FeeRoundingMode;
}

export interface FeeCalculationInput {
  readonly market: Market;
  readonly side: Side;
  readonly price: DecimalString;
  readonly quantity: Quantity;
}

export interface FeeModel {
  readonly version: string;
  readonly market: Market;
  readonly currency: Currency;
  calculate(input: FeeCalculationInput): DecimalString;
}

const roundingModes: Record<FeeRoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
};

function invariantViolation(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function readConfiguredRate(
  value: DecimalString,
  description: string,
): Decimal {
  if (typeof value !== 'string') {
    invariantViolation(`${description} must be a decimal string`);
  }
  try {
    const rate = readExactMoney(value, 'INVARIANT_VIOLATION', description);
    if (!rate.isFinite() || rate.isNegative()) {
      invariantViolation(
        `${description} must be a finite non-negative decimal`,
      );
    }
    return rate;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    invariantViolation(`${description} must be a decimal string`);
  }
}

function readPrice(value: DecimalString): Decimal {
  if (typeof value !== 'string') {
    throw new DomainError('INVALID_PRICE', 'Price must be a decimal string');
  }
  try {
    const price = readExactMoney(value, 'INVALID_PRICE', 'Price');
    if (!price.isFinite() || !price.gt(0)) {
      throw new DomainError('INVALID_PRICE', 'Price must be positive');
    }
    return price;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError('INVALID_PRICE', 'Price must be a decimal string');
  }
}

function readQuantity(value: Quantity): bigint {
  if (typeof value !== 'string') {
    throw new DomainError(
      'INVALID_QUANTITY',
      'Quantity must be a positive whole number',
    );
  }
  try {
    const quantity = decimal(value);
    if (!quantity.isFinite() || !quantity.isInteger() || !quantity.gt(0)) {
      throw new DomainError(
        'INVALID_QUANTITY',
        'Quantity must be a positive whole number',
      );
    }
    return BigInt(quantity.toFixed());
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      'INVALID_QUANTITY',
      'Quantity must be a positive whole number',
    );
  }
}

export function createFeeModel(config: FeeScheduleConfig): FeeModel {
  if (typeof config !== 'object' || config === null) {
    invariantViolation('Fee schedule config must be an object');
  }
  if (
    typeof config.version !== 'string' ||
    config.version.trim().length === 0
  ) {
    invariantViolation('Fee model version must not be empty');
  }
  if (config.market !== 'KR' && config.market !== 'US') {
    invariantViolation('Fee model market must be KR or US');
  }
  if (config.currency !== 'KRW' && config.currency !== 'USD') {
    invariantViolation('Fee model currency must be KRW or USD');
  }
  if (
    (config.market === 'KR' && config.currency !== 'KRW') ||
    (config.market === 'US' && config.currency !== 'USD')
  ) {
    invariantViolation('Fee model currency must match its market');
  }
  if (
    !Number.isInteger(config.roundingDecimals) ||
    config.roundingDecimals < 0 ||
    config.roundingDecimals > 20
  ) {
    invariantViolation('Fee rounding decimals must be an integer from 0 to 20');
  }
  if (
    typeof config.roundingMode !== 'string' ||
    !Object.hasOwn(roundingModes, config.roundingMode)
  ) {
    invariantViolation('Fee rounding mode is unsupported');
  }

  const version = config.version;
  const market = config.market;
  const currency = config.currency;
  const roundingDecimals = config.roundingDecimals;
  const commissionRate = readConfiguredRate(
    config.commissionRate,
    'Commission rate',
  );
  const sellTaxRate = readConfiguredRate(config.sellTaxRate, 'Sell tax rate');
  const roundingMode = roundingModes[config.roundingMode];

  return {
    version,
    market,
    currency,
    calculate(input): DecimalString {
      if (typeof input !== 'object' || input === null) {
        throw new DomainError(
          'INVALID_ORDER',
          'Fee calculation input must be an object',
        );
      }
      if (input.market !== market) {
        throw new DomainError(
          'INVALID_ORDER',
          'Fee model does not cover the order market',
        );
      }
      if (input.side !== 'BUY' && input.side !== 'SELL') {
        throw new DomainError('INVALID_ORDER', 'Order side is invalid');
      }

      const quantity = readQuantity(input.quantity);
      const notional = assertExactMoney(
        readPrice(input.price).mul(quantity.toString()),
        'Fee notional',
      );
      const commission = assertExactMoney(
        notional.mul(commissionRate),
        'Commission amount',
      );
      const sellTax =
        input.side === 'SELL'
          ? assertExactMoney(notional.mul(sellTaxRate), 'Sell tax amount')
          : readExactMoney('0', 'INVARIANT_VIOLATION', 'Sell tax amount');
      const rawFee = assertExactMoney(
        commission.plus(sellTax),
        'Combined fee amount',
      );
      return assertExactMoney(
        rawFee.toDecimalPlaces(roundingDecimals, roundingMode),
        'Rounded fee amount',
      ).toString();
    },
  };
}
