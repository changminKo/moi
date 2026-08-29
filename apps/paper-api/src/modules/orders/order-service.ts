import { randomUUID } from 'node:crypto';
import { DomainError, type Market } from '@moi/trading-core';
import type { OrderPlacementService } from './order-placement-service.js';
import {
  type AmendOrderInput,
  amendOrderSchema,
  type PlaceOrderInput,
  placeOrderSchema,
} from './order-schemas.js';
export interface OrderServiceDependencies {
  readonly execute?:
    | ((command: {
        action: 'place' | 'amend' | 'cancel';
        sessionId: string;
        orderId?: string;
        input?: unknown;
      }) => Promise<unknown>)
    | undefined;
  readonly whitelist?:
    | { isTradable(market: Market, symbol: string): boolean }
    | undefined;
  readonly calendar?:
    | { get(market: Market): Promise<{ session: 'REGULAR' | 'CLOSED' }> }
    | undefined;
  readonly capabilities?:
    | ((
        sessionId: string,
        market: Market,
        symbol: string,
      ) => ReadonlySet<string> | Record<string, boolean>)
    | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly placement?: OrderPlacementService | undefined;
}
export interface PlaceOrderContext {
  readonly idempotencyKey: string;
  readonly requestHash: string;
}
export class OrderService {
  constructor(private readonly deps: OrderServiceDependencies = {}) {}
  async place(
    sessionId: string,
    input: PlaceOrderInput,
    context?: PlaceOrderContext,
  ): Promise<unknown> {
    const parsed = placeOrderSchema.parse(input);
    const symbols =
      parsed.type === 'OCO'
        ? (parsed.legs ?? []).map((leg) => [leg.market, leg.symbol] as const)
        : [[parsed.market, parsed.symbol] as const];
    for (const [market, symbol] of symbols) {
      if (
        this.deps.whitelist &&
        !this.deps.whitelist.isTradable(market, symbol)
      )
        throw new DomainError(
          'CANCEL_ONLY',
          `${market}:${symbol} is cancel-only`,
        );
      const capability = this.deps.capabilities?.(sessionId, market, symbol);
      if (
        capability !== undefined &&
        (typeof (capability as { has?: unknown }).has === 'function'
          ? !(capability as ReadonlySet<string>).has('PLACE')
          : (capability as Record<string, boolean>).PLACE === false)
      )
        throw new DomainError('CANCEL_ONLY', 'placing orders is disabled');
      if (
        parsed.type === 'MARKET' &&
        this.deps.calendar &&
        (await this.deps.calendar.get(market)).session !== 'REGULAR'
      )
        throw new DomainError('MARKET_CLOSED', 'market is closed');
    }
    if (this.deps.placement) {
      if (!context)
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'placement context is required',
        );
      return this.deps.placement.place({
        sessionId,
        input: parsed,
        ...context,
      });
    }
    return (
      this.deps.execute?.({ action: 'place', sessionId, input: parsed }) ?? {
        id: randomUUID(),
        ...parsed,
        status: 'OPEN',
      }
    );
  }
  async amend(
    sessionId: string,
    orderId: string,
    input: AmendOrderInput,
  ): Promise<unknown> {
    const parsed = amendOrderSchema.parse(input);
    return (
      this.deps.execute?.({
        action: 'amend',
        sessionId,
        orderId,
        input: parsed,
      }) ?? { id: orderId, ...parsed, status: 'OPEN' }
    );
  }
  async cancel(sessionId: string, orderId: string): Promise<unknown> {
    const capability = this.deps.capabilities?.(sessionId, 'US', '');
    if (
      capability !== undefined &&
      (typeof (capability as { has?: unknown }).has === 'function'
        ? !(capability as ReadonlySet<string>).has('CANCEL')
        : (capability as Record<string, boolean>).CANCEL === false)
    )
      throw new DomainError('ACCOUNT_READ_ONLY', 'cancellation is disabled');
    return (
      this.deps.execute?.({ action: 'cancel', sessionId, orderId }) ?? {
        id: orderId,
        status: 'CANCELLED',
      }
    );
  }
}
