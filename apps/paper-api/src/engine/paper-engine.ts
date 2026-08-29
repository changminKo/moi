import { randomUUID } from 'node:crypto';
import type {
  Currency,
  DecimalString,
  FeeModel,
  Market,
  OrderBookSnapshot,
  OrderType,
  Quantity,
  Side,
} from '@moi/trading-core';
import type { MarketEnvelope } from '../market-data/market-state-store.js';
import type { EmergencyLatch } from '../safety/emergency-latch.js';
import {
  type ConditionalOrder,
  evaluateConditional,
} from './conditional-trigger.js';
import {
  cloneOrderBook,
  type MatchableOrder,
  matchOrder,
  type OrderMatch,
} from './match-orders.js';
import {
  createPricingContext,
  type PricingContext,
} from './pricing-context.js';

export interface TradeEvent {
  readonly price: DecimalString;
  readonly sourceTimestamp?: string | null;
  readonly source?: 'WEBSOCKET' | 'RECOVERY_REST';
  readonly recoveryEpoch?: bigint;
}
export interface ImmediateOrderCommand {
  readonly id?: string;
  readonly sessionId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly currency: Currency;
  readonly side: Side;
  readonly type?: 'MARKET' | 'LIMIT';
  readonly quantity: Quantity;
  readonly limitPrice?: DecimalString;
}
export interface PaperOrder extends MatchableOrder {
  readonly terminalReason?: 'IOC_REMAINDER';
}
export interface ConditionalPaperOrder
  extends Omit<PaperOrder, 'type'>,
    ConditionalOrder {
  readonly status: 'PENDING_TRIGGER' | 'TRIGGERED' | 'FILLED' | 'CANCELLED';
}
export interface SessionCalendar {
  isRegularSession(market: Market, at: Date): boolean;
}
export interface PaperEngineOptions {
  readonly feeModel: FeeModel;
  readonly pricingModelVersion?: string;
  readonly calendar?: SessionCalendar;
  readonly now?: () => Date;
  readonly isGateExclusive?: () => boolean;
  /** Optional process-local fail-closed interlock supplied by lifecycle wiring. */
  readonly emergencyLatch?: EmergencyLatch;
  readonly currentFencingToken?: (market: Market) => bigint;
  readonly onFill?: (
    order: PaperOrder,
    match: OrderMatch,
    pricing: PricingContext,
  ) => Promise<void> | void;
  readonly onAudit?: (event: unknown) => Promise<void> | void;
  readonly onConditionalTrigger?: (
    order: ConditionalPaperOrder,
    pricing: PricingContext,
  ) => Promise<void> | void;
}

/** A single-writer market matcher. Persistence hooks run after all decisions are made. */
export class PaperEngine {
  readonly #options: PaperEngineOptions;
  readonly #orders = new Map<string, PaperOrder>();
  readonly #books = new Map<
    string,
    { envelope: MarketEnvelope<OrderBookSnapshot>; book: OrderBookSnapshot }
  >();
  readonly #trades = new Map<string, TradeEvent>();
  readonly #conditional = new Map<string, ConditionalPaperOrder>();
  readonly #latest = new Map<string, MarketEnvelope<unknown>>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: PaperEngineOptions) {
    this.#options = options;
  }

  async onOrderBook(
    envelope: MarketEnvelope<OrderBookSnapshot>,
  ): Promise<void> {
    await this.#onOrderBook(envelope, 'WEBSOCKET');
  }

  /** Applies only a snapshot returned by the recovery REST boundary. */
  async onRecoveryOrderBook(
    envelope: MarketEnvelope<OrderBookSnapshot>,
  ): Promise<void> {
    await this.#onOrderBook(envelope, 'RECOVERY_REST');
  }

  async #onOrderBook(
    envelope: MarketEnvelope<OrderBookSnapshot>,
    source: 'WEBSOCKET' | 'RECOVERY_REST',
  ): Promise<void> {
    await this.#serialize(async () => {
      this.#assertEnvelope(envelope);
      if (
        this.#options.currentFencingToken?.(envelope.payload.market) !==
          undefined &&
        this.#options.currentFencingToken(envelope.payload.market) !==
          envelope.leaderFencingToken
      )
        return;
      const book = cloneOrderBook(envelope.payload);
      if (
        !this.#rememberEnvelope(this.#key(book.market, book.symbol), envelope)
      )
        return;
      this.#books.set(this.#key(book.market, book.symbol), { envelope, book });
      await this.#matchBook(book.market, book.symbol, envelope, source);
    });
  }

  async onTrade(
    envelope: MarketEnvelope<TradeEvent & { market: Market; symbol: string }>,
  ): Promise<void> {
    await this.#serialize(async () => {
      this.#assertEnvelope(envelope);
      if (
        this.#options.currentFencingToken?.(envelope.payload.market) !==
          undefined &&
        this.#options.currentFencingToken(envelope.payload.market) !==
          envelope.leaderFencingToken
      )
        return;
      if (
        !this.#rememberEnvelope(
          this.#key(envelope.payload.market, envelope.payload.symbol),
          envelope,
        )
      )
        return;
      this.#trades.set(
        this.#key(envelope.payload.market, envelope.payload.symbol),
        envelope.payload,
      );
      const now = this.#options.now?.() ?? new Date();
      if (
        this.#options.calendar !== undefined &&
        !this.#options.calendar.isRegularSession(envelope.payload.market, now)
      )
        return;
      const failures: unknown[] = [];
      for (const order of this.#conditional.values()) {
        // Same interlocks as book matching (§6.1): no trigger while the
        // matching gate is exclusive (RE_ELECTING / DRAINING / RECOVERING) or
        // the emergency latch is closed.
        if (this.#options.isGateExclusive?.() === true) break;
        if (this.#options.emergencyLatch?.matchingOpen === false) break;
        if (
          order.market !== envelope.payload.market ||
          order.symbol !== envelope.payload.symbol ||
          order.status !== 'PENDING_TRIGGER'
        )
          continue;
        if (!evaluateConditional(order, envelope.payload.price)) continue;
        const pricing = createPricingContext({
          source: envelope.payload.source ?? 'WEBSOCKET',
          recoveryEpoch: envelope.recoveryEpoch ?? envelope.recoveryEpoch,
          marketDataVersion: envelope.marketDataVersion,
          leaderFencingToken: envelope.leaderFencingToken,
          referencePrice: envelope.payload.price,
          referenceTimestamp: envelope.payload.sourceTimestamp ?? null,
          book: this.#books.get(this.#key(order.market, order.symbol))
            ?.book ?? {
            ...({
              symbol: order.symbol,
              market: order.market,
              currency: order.currency,
              bids: [],
              asks: [],
            } as OrderBookSnapshot),
          },
          pricingModelVersion: this.#options.pricingModelVersion ?? 'default',
          feeModelVersion: this.#options.feeModel.version,
          recoveryFill: envelope.payload.source === 'RECOVERY_REST',
        });
        const triggered = { ...order, status: 'TRIGGERED' as const };
        this.#conditional.set(order.id, triggered);
        this.#orders.set(order.id, triggered);
        try {
          await this.#options.onConditionalTrigger?.(triggered, pricing);
        } catch (error) {
          // Persistence is the source of truth: a rejected trigger left the
          // row PENDING_TRIGGER, so the engine returns to that state and the
          // next crossing trade evaluates the order again. Other conditional
          // orders crossed by this same trade are still evaluated.
          this.#conditional.set(order.id, order);
          this.#orders.set(order.id, order);
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          `${failures.length} conditional triggers failed to persist`,
        );
    });
  }

  async placeImmediateOrder(
    command: ImmediateOrderCommand,
  ): Promise<PaperOrder> {
    return this.#serialize(async () => {
      this.#options.emergencyLatch?.assertAdmission();
      const id = command.id ?? randomUUID();
      const type: OrderType = command.type ?? 'MARKET';
      const order: PaperOrder = {
        id,
        sessionId: command.sessionId,
        market: command.market,
        symbol: command.symbol,
        currency: command.currency,
        side: command.side,
        type,
        quantity: command.quantity,
        ...(command.limitPrice === undefined
          ? {}
          : { limitPrice: command.limitPrice }),
        status: 'OPEN',
        version: 0n,
        filledQuantity: '0',
      };
      this.#orders.set(id, order);
      const cached = this.#books.get(this.#key(order.market, order.symbol));
      if (cached !== undefined)
        await this.#matchBook(
          order.market,
          order.symbol,
          cached.envelope,
          'WEBSOCKET',
        );
      return this.#orders.get(id) as PaperOrder;
    });
  }

  getOrder(id: string): PaperOrder | undefined {
    return this.#orders.get(id);
  }

  async cancelOrder(id: string): Promise<PaperOrder | undefined> {
    return this.#serialize(async () => {
      const current = this.#orders.get(id);
      if (!current) return undefined;
      if (
        current.status === 'FILLED' ||
        current.status === 'CANCELLED' ||
        current.status === 'EXPIRED' ||
        current.status === 'REJECTED'
      )
        return current;
      const cancelled = {
        ...current,
        status: 'CANCELLED' as const,
        version: current.version + 1n,
      };
      this.#orders.set(id, cancelled);
      return cancelled;
    });
  }

  /** Clears process-local matcher state after the durable boundary is drained. */
  async reset(): Promise<void> {
    await this.#serialize(async () => {
      this.#orders.clear();
      this.#books.clear();
      this.#trades.clear();
      this.#conditional.clear();
      this.#latest.clear();
    });
  }

  registerConditionalOrder(order: ConditionalPaperOrder): void {
    this.#conditional.set(order.id, order);
    this.#orders.set(order.id, order);
  }

  /**
   * Re-registers an order persisted by a previous leader (§6.1 RESTORING).
   * Status, version, and filled quantity are kept verbatim and no matching
   * happens here: the next book observed by this leader drives any fill, so a
   * restored order never fills against a book this process has not seen.
   */
  restoreOrder(order: PaperOrder | ConditionalPaperOrder): void {
    if (order.status === 'PENDING_TRIGGER') {
      this.registerConditionalOrder(order as ConditionalPaperOrder);
      return;
    }
    this.#orders.set(order.id, order as PaperOrder);
  }

  #assertEnvelope(envelope: MarketEnvelope<unknown>): void {
    if (
      envelope.recoveryEpoch < 0n ||
      envelope.marketDataVersion < 0n ||
      envelope.leaderFencingToken < 0n
    )
      throw new Error('invalid market envelope');
  }
  #rememberEnvelope(key: string, envelope: MarketEnvelope<unknown>): boolean {
    const previous = this.#latest.get(key);
    if (
      previous !== undefined &&
      (envelope.recoveryEpoch < previous.recoveryEpoch ||
        (envelope.recoveryEpoch === previous.recoveryEpoch &&
          envelope.leaderFencingToken < previous.leaderFencingToken) ||
        (envelope.recoveryEpoch === previous.recoveryEpoch &&
          envelope.leaderFencingToken === previous.leaderFencingToken &&
          envelope.marketDataVersion <= previous.marketDataVersion))
    ) {
      return false;
    }
    this.#latest.set(key, envelope);
    return true;
  }
  async #matchBook(
    market: Market,
    symbol: string,
    envelope: MarketEnvelope<OrderBookSnapshot>,
    source: 'WEBSOCKET' | 'RECOVERY_REST',
  ): Promise<void> {
    const now = this.#options.now?.() ?? new Date();
    if (
      this.#options.calendar !== undefined &&
      !this.#options.calendar.isRegularSession(market, now)
    )
      return;
    if (this.#options.isGateExclusive?.() === true) return;
    if (this.#options.emergencyLatch?.matchingOpen === false) return;
    const book = cloneOrderBook(envelope.payload);
    for (const order of [...this.#orders.values()]) {
      if (
        order.market !== market ||
        order.symbol !== symbol ||
        (order.status !== 'OPEN' && order.status !== 'PARTIALLY_FILLED')
      )
        continue;
      const pricing = createPricingContext({
        source,
        recoveryEpoch: envelope.recoveryEpoch,
        marketDataVersion: envelope.marketDataVersion,
        leaderFencingToken: envelope.leaderFencingToken,
        referencePrice: this.#referencePrice(book),
        referenceTimestamp: null,
        book,
        pricingModelVersion: this.#options.pricingModelVersion ?? 'default',
        feeModelVersion: this.#options.feeModel.version,
        recoveryFill: source === 'RECOVERY_REST',
      });
      const match = matchOrder(order, book, pricing, this.#options.feeModel);
      if (
        this.#options.currentFencingToken?.(market) !== undefined &&
        this.#options.currentFencingToken(market) !==
          envelope.leaderFencingToken
      )
        continue;
      const updated: PaperOrder = {
        ...order,
        filledQuantity: match.filledQuantity,
        status: match.nextStatus,
        version: order.version + 1n,
        ...(match.nextStatus === 'CANCELLED'
          ? { terminalReason: 'IOC_REMAINDER' as const }
          : {}),
      };
      this.#orders.set(order.id, updated);
      try {
        await this.#options.onFill?.(updated, match, pricing);
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'ORDER_TERMINAL') {
          // A cancellation committed first: the ledger is the source of
          // truth, so the order leaves the book without a fill.
          this.#orders.set(order.id, {
            ...order,
            status: 'CANCELLED',
            version: order.version + 1n,
          });
          continue;
        }
        // Nothing was committed; keep matching from the pre-fill state.
        this.#orders.set(order.id, order);
        throw error;
      }
      await this.#options.onAudit?.({
        eventType: 'FILL_CREATED',
        orderId: order.id,
        pricing,
        execution: match.execution,
      });
    }
  }
  #referencePrice(book: OrderBookSnapshot): DecimalString {
    return book.asks[0]?.price ?? book.bids[0]?.price ?? '0';
  }
  #key(market: Market, symbol: string): string {
    return `${market}:${symbol}`;
  }
  async #serialize<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#chain;
    let release!: () => void;
    this.#chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
