import {
  assertExactMoney,
  decimal,
  moneyDecimal,
  readExactMoney,
} from './decimal.js';
import { DomainError } from './domain-errors.js';
import type {
  Currency,
  DecimalString,
  Market,
  Quantity,
  Side,
} from './domain-types.js';
import type { FeeModel } from './fee-model.js';

export interface OrderBookLevel {
  readonly price: DecimalString;
  readonly volume: Quantity;
}

export interface OrderBookSnapshot {
  readonly symbol: string;
  readonly market: Market;
  readonly currency: Currency;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
}

export interface ExecutionOrder {
  readonly id: string;
  readonly side: Side;
  readonly type: 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT';
  readonly market: Market;
  readonly currency: Currency;
  readonly symbol: string;
  readonly quantity: Quantity;
  readonly filledQuantity?: Quantity;
  readonly limitPrice?: DecimalString;
}

export interface PriceProtection {
  readonly referenceMid: DecimalString;
  readonly maxDeviationBps: number;
}

export interface ExecutionFill {
  readonly price: DecimalString;
  readonly quantity: Quantity;
  readonly fee: DecimalString;
}

export interface ConsumedOrderBookLevel {
  readonly side: 'BID' | 'ASK';
  readonly index: number;
  readonly price: DecimalString;
  readonly availableVolume: Quantity;
  readonly consumedQuantity: Quantity;
}

export interface ExecutionResult {
  readonly fills: readonly ExecutionFill[];
  readonly consumedLevels: readonly ConsumedOrderBookLevel[];
  readonly filledQuantity: Quantity;
  readonly unfilledQuantity: Quantity;
  readonly grossAmount: DecimalString;
  readonly feeTotal: DecimalString;
  readonly netAmount: DecimalString;
  readonly slippageAmount: DecimalString;
  readonly feeModelVersion: string;
  readonly terminalReason?: 'IOC_REMAINDER' | 'PRICE_PROTECTION';
}

function invalidOrder(message: string): never {
  throw new DomainError('INVALID_ORDER', message);
}

function invalidPrice(message: string): never {
  throw new DomainError('INVALID_PRICE', message);
}

function invalidQuantity(message: string): never {
  throw new DomainError('INVALID_QUANTITY', message);
}

function readFeeModelFee(value: unknown) {
  if (typeof value !== 'string' || value.startsWith('-')) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'Fee model returned an invalid fee',
    );
  }
  try {
    return readExactMoney(value, 'INVARIANT_VIOLATION', 'Fee model result');
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'Fee model returned an invalid fee',
    );
  }
}

function readPositivePrice(value: DecimalString, description: string) {
  if (typeof value !== 'string') {
    invalidPrice(`${description} must be a decimal string`);
  }
  try {
    const price = readExactMoney(value, 'INVALID_PRICE', description);
    if (!price.isFinite() || !price.gt(0)) {
      invalidPrice(`${description} must be positive`);
    }
    return price;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    invalidPrice(`${description} must be a decimal string`);
  }
}

function readPositiveWhole(value: Quantity, description: string) {
  if (typeof value !== 'string') {
    invalidQuantity(`${description} must be a positive whole quantity`);
  }
  try {
    const quantity = decimal(value);
    if (!quantity.isFinite() || !quantity.isInteger() || !quantity.gt(0)) {
      invalidQuantity(`${description} must be a positive whole quantity`);
    }
    return BigInt(quantity.toFixed());
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    invalidQuantity(`${description} must be a positive whole quantity`);
  }
}

function readNonNegativeWhole(value: Quantity, description: string) {
  if (typeof value !== 'string') {
    invalidQuantity(`${description} must be a non-negative whole quantity`);
  }
  try {
    const quantity = decimal(value);
    if (
      !quantity.isFinite() ||
      !quantity.isInteger() ||
      quantity.isNegative()
    ) {
      invalidQuantity(`${description} must be a non-negative whole quantity`);
    }
    return BigInt(quantity.toFixed());
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    invalidQuantity(`${description} must be a non-negative whole quantity`);
  }
}

function assertProtection(protection: PriceProtection): void {
  if (typeof protection !== 'object' || protection === null) {
    invalidOrder('Price protection must be an object');
  }
  readPositivePrice(protection.referenceMid, 'Protection reference mid');
  if (
    !Number.isSafeInteger(protection.maxDeviationBps) ||
    protection.maxDeviationBps < 0
  ) {
    invalidOrder('Protection basis points must be a non-negative integer');
  }
}

export function withinProtection(
  price: DecimalString,
  mid: DecimalString,
  bps: number,
): boolean {
  const executionPrice = readPositivePrice(price, 'Execution price');
  const referenceMid = readPositivePrice(mid, 'Protection reference mid');
  if (!Number.isSafeInteger(bps) || bps < 0) {
    invalidOrder('Protection basis points must be a non-negative integer');
  }
  const deviation = assertExactMoney(
    executionPrice.minus(referenceMid).abs(),
    'Price protection deviation',
  );
  const scaledDeviation = assertExactMoney(
    deviation.mul(10_000),
    'Scaled price protection deviation',
  );
  const permittedDeviation = assertExactMoney(
    referenceMid.mul(bps.toString()),
    'Permitted price protection deviation',
  );
  return scaledDeviation.lte(permittedDeviation);
}

function assertOrder(order: ExecutionOrder) {
  if (
    typeof order !== 'object' ||
    order === null ||
    typeof order.id !== 'string' ||
    order.id.trim().length === 0 ||
    typeof order.symbol !== 'string' ||
    order.symbol.trim().length === 0 ||
    (order.side !== 'BUY' && order.side !== 'SELL') ||
    (order.type !== 'MARKET' &&
      order.type !== 'LIMIT' &&
      order.type !== 'STOP' &&
      order.type !== 'TAKE_PROFIT') ||
    (order.market !== 'KR' && order.market !== 'US') ||
    (order.currency !== 'KRW' && order.currency !== 'USD')
  ) {
    invalidOrder('Execution order has an invalid identity or discriminant');
  }
  if (
    (order.market === 'KR' && order.currency !== 'KRW') ||
    (order.market === 'US' && order.currency !== 'USD')
  ) {
    invalidOrder('Execution order currency must match its market');
  }

  const quantity = readPositiveWhole(order.quantity, 'Order quantity');
  const filled = readNonNegativeWhole(
    order.filledQuantity ?? '0',
    'Filled quantity',
  );
  if (filled >= quantity) {
    invalidOrder('Execution order must have a positive remaining quantity');
  }

  if (
    (order.type === 'MARKET' && order.limitPrice !== undefined) ||
    (order.type === 'LIMIT' && order.limitPrice === undefined)
  ) {
    invalidOrder('Execution price fields do not match the order type');
  }
  if (order.limitPrice !== undefined) {
    readPositivePrice(order.limitPrice, 'Limit price');
  }

  return { quantity, filled };
}

function assertBook(order: ExecutionOrder, book: OrderBookSnapshot): void {
  if (
    typeof book !== 'object' ||
    book === null ||
    typeof book.symbol !== 'string' ||
    book.symbol !== order.symbol ||
    book.market !== order.market ||
    book.currency !== order.currency ||
    !Array.isArray(book.bids) ||
    !Array.isArray(book.asks)
  ) {
    invalidOrder('Order book does not match the execution order');
  }
  if (book.bids.length === 0 || book.asks.length === 0) {
    throw new DomainError('CANCEL_ONLY', 'Order book must be two-sided');
  }

  const validatedBids = book.bids.map((level, index) => ({
    index,
    price: readPositivePrice(level?.price, 'Bid price'),
    volume: readPositiveWhole(level?.volume, 'Bid volume'),
  }));
  const validatedAsks = book.asks.map((level, index) => ({
    index,
    price: readPositivePrice(level?.price, 'Ask price'),
    volume: readPositiveWhole(level?.volume, 'Ask volume'),
  }));

  for (let index = 1; index < validatedBids.length; index += 1) {
    const previous = validatedBids[index - 1];
    const current = validatedBids[index];
    if (
      previous === undefined ||
      current === undefined ||
      !previous.price.gt(current.price)
    ) {
      invalidOrder('Bid levels must be strictly descending');
    }
  }
  for (let index = 1; index < validatedAsks.length; index += 1) {
    const previous = validatedAsks[index - 1];
    const current = validatedAsks[index];
    if (
      previous === undefined ||
      current === undefined ||
      !previous.price.lt(current.price)
    ) {
      invalidOrder('Ask levels must be strictly ascending');
    }
  }

  const bestBid = validatedBids[0];
  const bestAsk = validatedAsks[0];
  if (
    bestBid === undefined ||
    bestAsk === undefined ||
    bestBid.price.gte(bestAsk.price)
  ) {
    throw new DomainError(
      'CANCEL_ONLY',
      'Order book must not be locked or crossed',
    );
  }
}

export function calculateExecution(
  order: ExecutionOrder,
  book: OrderBookSnapshot,
  feeModel: FeeModel,
  protection: PriceProtection,
): ExecutionResult {
  const { quantity, filled } = assertOrder(order);
  assertProtection(protection);
  assertBook(order, book);
  if (typeof feeModel !== 'object' || feeModel === null) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'Fee model must match the execution market and currency',
    );
  }
  let feeModelVersion: unknown;
  let feeModelMarket: unknown;
  let feeModelCurrency: unknown;
  let feeModelCalculate: unknown;
  try {
    feeModelVersion = feeModel.version;
    feeModelMarket = feeModel.market;
    feeModelCurrency = feeModel.currency;
    feeModelCalculate = feeModel.calculate;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'Fee model properties must be readable',
    );
  }
  if (
    feeModelMarket !== order.market ||
    feeModelCurrency !== order.currency ||
    typeof feeModelVersion !== 'string' ||
    feeModelVersion.trim().length === 0 ||
    typeof feeModelCalculate !== 'function'
  ) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'Fee model must match the execution market and currency',
    );
  }
  const snapshotVersion: string = feeModelVersion;
  const snapshotCalculate = feeModelCalculate as FeeModel['calculate'];

  // Quantities are exact whole numbers. BigInt keeps the book walk and its
  // reported fill conservation independent of Decimal's precision setting.
  const remainingOrderQuantity = quantity - filled;
  let remaining = remainingOrderQuantity;
  let grossAmount = moneyDecimal(0);
  let feeTotal = moneyDecimal(0);
  let protectionStopped = false;
  const fills: ExecutionFill[] = [];
  const consumedLevels: ConsumedOrderBookLevel[] = [];
  const levels = order.side === 'BUY' ? book.asks : book.bids;
  const levelSide = order.side === 'BUY' ? 'ASK' : 'BID';
  const marketStyle =
    order.type === 'MARKET' ||
    ((order.type === 'STOP' || order.type === 'TAKE_PROFIT') &&
      order.limitPrice === undefined);
  const limitPrice =
    order.limitPrice === undefined
      ? undefined
      : readPositivePrice(order.limitPrice, 'Limit price');

  for (const [index, level] of levels.entries()) {
    if (remaining === 0n) {
      break;
    }
    const levelPrice = readPositivePrice(level.price, 'Order book level price');
    const levelVolume = readPositiveWhole(
      level.volume,
      'Order book level volume',
    );
    if (
      limitPrice !== undefined &&
      ((order.side === 'BUY' && levelPrice.gt(limitPrice)) ||
        (order.side === 'SELL' && levelPrice.lt(limitPrice)))
    ) {
      break;
    }
    if (
      marketStyle &&
      !withinProtection(
        level.price,
        protection.referenceMid,
        protection.maxDeviationBps,
      )
    ) {
      protectionStopped = true;
      break;
    }

    const consumed = levelVolume < remaining ? levelVolume : remaining;
    const quantityString = consumed.toString();
    let feeValue: unknown;
    try {
      feeValue = Reflect.apply(snapshotCalculate, feeModel, [
        {
          market: order.market,
          side: order.side,
          price: level.price,
          quantity: quantityString,
        },
      ]);
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'Fee model calculation failed',
      );
    }
    const fee = readFeeModelFee(feeValue);
    const normalizedFee = fee.toString();
    const fillNotional = assertExactMoney(
      levelPrice.mul(quantityString),
      'Fill notional',
    );

    fills.push({
      price: level.price,
      quantity: quantityString,
      fee: normalizedFee,
    });
    consumedLevels.push({
      side: levelSide,
      index,
      price: level.price,
      availableVolume: level.volume,
      consumedQuantity: quantityString,
    });
    grossAmount = assertExactMoney(
      grossAmount.plus(fillNotional),
      'Execution gross amount',
    );
    feeTotal = assertExactMoney(feeTotal.plus(fee), 'Execution fee total');
    remaining -= consumed;
  }

  const filledThisRun = remainingOrderQuantity - remaining;
  const referenceNotional = assertExactMoney(
    readPositivePrice(protection.referenceMid, 'Protection reference mid').mul(
      filledThisRun.toString(),
    ),
    'Execution reference notional',
  );
  const slippageAmount =
    order.side === 'BUY'
      ? assertExactMoney(
          grossAmount.minus(referenceNotional),
          'Execution slippage amount',
        )
      : assertExactMoney(
          referenceNotional.minus(grossAmount),
          'Execution slippage amount',
        );
  const netAmount =
    order.side === 'BUY'
      ? assertExactMoney(grossAmount.plus(feeTotal), 'Execution net amount')
      : assertExactMoney(grossAmount.minus(feeTotal), 'Execution net amount');
  const terminalReason =
    remaining === 0n
      ? undefined
      : protectionStopped
        ? 'PRICE_PROTECTION'
        : marketStyle
          ? 'IOC_REMAINDER'
          : undefined;

  return {
    fills,
    consumedLevels,
    filledQuantity: filledThisRun.toString(),
    unfilledQuantity: remaining.toString(),
    grossAmount: grossAmount.toString(),
    feeTotal: feeTotal.toString(),
    netAmount: netAmount.toString(),
    slippageAmount: slippageAmount.toString(),
    feeModelVersion: snapshotVersion,
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
}
