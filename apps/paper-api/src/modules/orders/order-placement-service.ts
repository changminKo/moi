import { randomUUID } from 'node:crypto';
import {
  type Currency,
  currencyFor,
  DomainError,
  type FeeModel,
  type Market,
  type OrderType,
  planOcoReservation,
  planReservation,
  type Side,
} from '@moi/trading-core';
import {
  commitOcoPlacement,
  commitTradingMutation,
  type TradingMutationOrder,
  type UnitOfWork,
} from '../../db/unit-of-work.js';
import type { PlaceOrderInput } from './order-schemas.js';

interface ImmediateOrder {
  readonly id: string;
  readonly sessionId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly currency: Currency;
  readonly side: Side;
  readonly type: 'MARKET' | 'LIMIT';
  readonly quantity: string;
  readonly limitPrice?: string;
}

interface ConditionalOrder {
  readonly id: string;
  readonly sessionId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly currency: Currency;
  readonly side: Side;
  readonly type: 'STOP' | 'TAKE_PROFIT';
  readonly quantity: string;
  readonly stopPrice: string;
  readonly status: 'PENDING_TRIGGER';
  readonly version: bigint;
  readonly filledQuantity: string;
}

export interface OrderPlacementEngine {
  placeImmediateOrder(order: ImmediateOrder): Promise<unknown>;
  registerConditionalOrder(order: ConditionalOrder): void;
}

export interface OrderPlacementServiceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly engine: (market: Market) => OrderPlacementEngine | undefined;
  /** Current reference (ask) price used to size MARKET BUY cash reservations. */
  readonly referencePrice?: (
    market: Market,
    symbol: string,
  ) => string | undefined;
  /** Fee model used to size the estimated fee inside BUY reservations. */
  readonly feeModel?: (market: Market) => FeeModel;
  readonly afterPlacement?: (
    sessionId: string,
    sequence: bigint,
  ) => Promise<void>;
  readonly clock?: () => Date;
  readonly id?: () => string;
}

export interface PlaceOrderCommand {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly input: PlaceOrderInput;
}

export class OrderPlacementService {
  readonly #deps: OrderPlacementServiceDependencies;

  constructor(dependencies: OrderPlacementServiceDependencies) {
    this.#deps = dependencies;
  }

  async place(command: PlaceOrderCommand): Promise<unknown> {
    const input = command.input;
    return input.type === 'OCO'
      ? this.#placeOco(command, input)
      : this.#placeSingle(command, input);
  }

  /**
   * Sizes the ledger reservation a single order holds while it is open
   * (§ledger): BUY reserves cash — limit notional, or reference price with the
   * core's protection multiplier for MARKET / trigger orders — and SELL
   * reserves the position quantity. The reservation row is recorded with the
   * order in the same mutation so RESTORING can reconcile it.
   */
  #planSingleReservation(
    input: Exclude<PlaceOrderInput, { type: 'OCO' }>,
    orderId: string,
    status: 'OPEN' | 'PENDING_TRIGGER',
  ): Pick<
    Parameters<typeof commitTradingMutation>[1],
    'cash' | 'position' | 'reservationId'
  > {
    const currency = currencyFor(input.market);
    const referencePrice =
      input.type === 'MARKET'
        ? this.#deps.referencePrice?.(input.market, input.symbol)
        : input.type === 'LIMIT'
          ? undefined
          : (input.stopPrice ?? input.limitPrice);
    if (
      input.side === 'BUY' &&
      input.type !== 'LIMIT' &&
      referencePrice === undefined
    )
      throw new DomainError(
        'MARKET_DATA_DEGRADED',
        'no reference price is available to size the order',
      );
    const plan = planReservation({
      id: orderId,
      status,
      side: input.side,
      type: input.type as Exclude<OrderType, 'OCO'>,
      currency,
      symbol: input.symbol,
      quantity: input.quantity,
      ...(input.limitPrice === undefined
        ? {}
        : { limitPrice: input.limitPrice }),
      ...(referencePrice === undefined ? {} : { referencePrice }),
      estimatedFee: this.#estimatedFee(input, referencePrice),
    });
    if (plan.cash !== undefined)
      return {
        cash: { currency: plan.cash.currency, amount: plan.cash.amount },
        reservationId: this.#id(),
      };
    if (plan.position !== undefined)
      return {
        position: {
          marketCode: input.market,
          symbol: plan.position.symbol,
          quantity: plan.position.quantity,
        },
        reservationId: this.#id(),
      };
    return {};
  }

  #estimatedFee(
    input: Exclude<PlaceOrderInput, { type: 'OCO' }>,
    referencePrice: string | undefined,
  ): string {
    const feeModel = this.#deps.feeModel?.(input.market);
    const price = input.limitPrice ?? referencePrice;
    if (feeModel === undefined || input.side !== 'BUY' || price === undefined)
      return '0';
    return feeModel.calculate({
      market: input.market,
      side: 'BUY',
      price,
      quantity: input.quantity,
    });
  }

  async #placeSingle(
    command: PlaceOrderCommand,
    input: Exclude<PlaceOrderInput, { type: 'OCO' }>,
  ): Promise<unknown> {
    const id = this.#id();
    const isConditional = input.type === 'STOP' || input.type === 'TAKE_PROFIT';
    const initialStatus = isConditional ? 'PENDING_TRIGGER' : 'OPEN';
    const response = {
      id,
      status: initialStatus,
      filledQuantity: '0',
      quantity: input.quantity,
    };
    const reservation = this.#planSingleReservation(input, id, initialStatus);
    const committed = await commitTradingMutation(this.#deps.unitOfWork, {
      sessionId: command.sessionId,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      mutationKind: 'ORDER_PLACED',
      ...reservation,
      order: {
        id,
        marketCode: input.market,
        symbol: input.symbol,
        orderType: input.type,
        side: input.side,
        quantity: input.quantity,
        status: initialStatus,
        ...(input.limitPrice === undefined
          ? {}
          : { limitPrice: input.limitPrice }),
        ...(input.stopPrice === undefined
          ? {}
          : { stopPrice: input.stopPrice }),
      },
      audit: this.#audit(command.sessionId, input, id),
      outbox: this.#outbox(command.sessionId, id),
      response: { statusCode: 201, body: response },
    });
    if (committed.replayed) {
      return committed.body;
    }
    const sequence = this.#committedSequence(committed.sequence);

    if (input.type === 'MARKET' || input.type === 'LIMIT') {
      const engine = this.#engine(input.market);
      await engine.placeImmediateOrder({
        id,
        sessionId: command.sessionId,
        market: input.market,
        symbol: input.symbol,
        currency: currencyFor(input.market),
        side: input.side,
        type: input.type,
        quantity: input.quantity,
        ...(input.limitPrice === undefined
          ? {}
          : { limitPrice: input.limitPrice }),
      });
    } else if (input.type === 'STOP' || input.type === 'TAKE_PROFIT') {
      // Conditional singles wait in the engine for their trigger price
      // (§6.1); without this the persisted order would never match.
      this.#engine(input.market).registerConditionalOrder({
        id,
        sessionId: command.sessionId,
        market: input.market,
        symbol: input.symbol,
        currency: currencyFor(input.market),
        side: input.side,
        type: input.type,
        quantity: input.quantity,
        stopPrice: String(input.stopPrice ?? input.limitPrice),
        status: 'PENDING_TRIGGER',
        version: 0n,
        filledQuantity: '0',
      });
    }
    await this.#deps.afterPlacement?.(command.sessionId, sequence);
    return response;
  }

  async #placeOco(
    command: PlaceOrderCommand,
    input: PlaceOrderInput,
  ): Promise<unknown> {
    const legs = input.legs;
    if (legs === undefined) {
      throw new Error('validated OCO order has no legs');
    }
    const groupId = this.#id();
    const legIds = [this.#id(), this.#id()] as const;
    const currency = currencyFor(input.market);
    const persistedLegs = legs.map(
      (leg, index): TradingMutationOrder => ({
        id: legIds[index] as string,
        marketCode: leg.market,
        symbol: leg.symbol,
        orderType: leg.type,
        side: leg.side,
        quantity: leg.quantity,
        status: 'PENDING_TRIGGER',
        ...(leg.limitPrice === undefined ? {} : { limitPrice: leg.limitPrice }),
        ...(leg.stopPrice === undefined ? {} : { stopPrice: leg.stopPrice }),
      }),
    ) as unknown as readonly [TradingMutationOrder, TradingMutationOrder];
    const reservation = planOcoReservation(
      legs.map((leg, index) => ({
        id: legIds[index] as string,
        status: 'PENDING_TRIGGER' as const,
        side: leg.side,
        type: leg.type,
        currency,
        symbol: leg.symbol,
        quantity: leg.quantity,
        ...(leg.type === 'LIMIT'
          ? { limitPrice: leg.limitPrice as string }
          : { referencePrice: leg.stopPrice as string }),
        estimatedFee: '0',
      })) as unknown as Parameters<typeof planOcoReservation>[0],
    );
    const shared = reservation.position
      ? {
          id: this.#id(),
          kind: 'POSITION' as const,
          marketCode: input.market,
          symbol: reservation.position.symbol,
          amount: reservation.position.quantity,
        }
      : {
          id: this.#id(),
          kind: 'CASH' as const,
          currency: reservation.cash?.currency ?? currency,
          amount: reservation.cash?.amount ?? '0',
        };
    const response = {
      id: legIds[0],
      status: 'PENDING_TRIGGER',
      filledQuantity: '0',
      quantity: input.quantity,
    };
    const committed = await commitOcoPlacement(this.#deps.unitOfWork, {
      sessionId: command.sessionId,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      mutationKind: 'ORDER_PLACED',
      groupId,
      legs: persistedLegs,
      reservation: shared,
      audit: this.#audit(command.sessionId, input, legIds[0]),
      outbox: this.#outbox(command.sessionId, legIds[0]),
      response: { statusCode: 201, body: response },
    });
    if (committed.replayed) {
      return committed.body;
    }
    const sequence = this.#committedSequence(committed.sequence);

    const engine = this.#engine(input.market);
    for (const [index, leg] of legs.entries()) {
      engine.registerConditionalOrder({
        id: legIds[index] as string,
        sessionId: command.sessionId,
        market: leg.market,
        symbol: leg.symbol,
        currency,
        side: leg.side,
        type: leg.type === 'STOP' ? 'STOP' : 'TAKE_PROFIT',
        quantity: leg.quantity,
        stopPrice: String(leg.stopPrice ?? leg.limitPrice),
        status: 'PENDING_TRIGGER',
        version: 0n,
        filledQuantity: '0',
      });
    }
    await this.#deps.afterPlacement?.(command.sessionId, sequence);
    return response;
  }

  #engine(market: Market): OrderPlacementEngine {
    const engine = this.#deps.engine(market);
    if (engine === undefined) {
      throw new Error(`missing ${market} paper engine`);
    }
    return engine;
  }

  #id(): string {
    return (this.#deps.id ?? randomUUID)();
  }

  #audit(sessionId: string, input: PlaceOrderInput, orderId: string) {
    return {
      id: this.#id(),
      eventType: 'ORDER_PLACED',
      payload: input,
      occurredAt: (this.#deps.clock ?? (() => new Date()))(),
      sessionReference: sessionId,
      orderId,
    };
  }

  #outbox(sessionId: string, orderId: string) {
    return {
      id: this.#id(),
      eventId: this.#id(),
      eventType: 'ORDER_PLACED',
      payload: { orderId },
      sessionId,
    };
  }

  #committedSequence(sequence: bigint | undefined): bigint {
    if (sequence === undefined) {
      throw new Error('order placement committed without an account sequence');
    }
    return sequence;
  }
}
