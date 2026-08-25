import { randomUUID } from 'node:crypto';
import {
  type Currency,
  type Market,
  planOcoReservation,
  type Side,
} from '@skipjack/trading-core';
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
  readonly nextSequence: (
    sessionId: string,
    mutationKind: string,
  ) => Promise<bigint>;
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

const currencyFor = (market: Market): Currency =>
  market === 'KR' ? 'KRW' : 'USD';

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

  async #placeSingle(
    command: PlaceOrderCommand,
    input: Exclude<PlaceOrderInput, { type: 'OCO' }>,
  ): Promise<unknown> {
    const id = this.#id();
    const sequence = await this.#deps.nextSequence(
      command.sessionId,
      'ORDER_PLACED',
    );
    const response = {
      id,
      status: 'OPEN',
      filledQuantity: '0',
      quantity: input.quantity,
    };
    const committed = await commitTradingMutation(this.#deps.unitOfWork, {
      sessionId: command.sessionId,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      order: {
        id,
        marketCode: input.market,
        symbol: input.symbol,
        orderType: input.type,
        side: input.side,
        quantity: input.quantity,
        status: 'OPEN',
        ...(input.limitPrice === undefined
          ? {}
          : { limitPrice: input.limitPrice }),
        ...(input.stopPrice === undefined
          ? {}
          : { stopPrice: input.stopPrice }),
      },
      audit: this.#audit(command.sessionId, input, id),
      outbox: this.#outbox(command.sessionId, sequence, id),
      response: { statusCode: 201, body: response },
    });
    if (committed.replayed) {
      return committed.body;
    }

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
    const sequence = await this.#deps.nextSequence(
      command.sessionId,
      'ORDER_PLACED',
    );
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
      groupId,
      legs: persistedLegs,
      reservation: shared,
      audit: this.#audit(command.sessionId, input, legIds[0]),
      outbox: this.#outbox(command.sessionId, sequence, legIds[0]),
      response: { statusCode: 201, body: response },
    });
    if (committed.replayed) {
      return committed.body;
    }

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

  #outbox(sessionId: string, sequence: bigint, orderId: string) {
    return {
      id: this.#id(),
      eventId: this.#id(),
      streamSequence: sequence,
      eventType: 'ORDER_PLACED',
      payload: { orderId },
      sessionId,
    };
  }
}
