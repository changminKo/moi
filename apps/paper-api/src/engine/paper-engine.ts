import { randomUUID } from 'node:crypto';
import {
  type Currency, type DecimalString, type FeeModel, type Market,
  type OrderBookSnapshot, type OrderType, type Quantity, type Side,
} from '@skipjack/trading-core';
import type { MarketEnvelope } from '../market-data/market-state-store.js';
import { cloneOrderBook, matchOrder, type MatchableOrder, type OrderMatch } from './match-orders.js';
import { createPricingContext, type PricingContext } from './pricing-context.js';

export interface TradeEvent { readonly price: DecimalString; readonly sourceTimestamp?: string | null; }
export interface ImmediateOrderCommand {
  readonly id?: string; readonly sessionId: string; readonly market: Market; readonly symbol: string;
  readonly currency: Currency; readonly side: Side; readonly type?: 'MARKET' | 'LIMIT';
  readonly quantity: Quantity; readonly limitPrice?: DecimalString;
}
export interface PaperOrder extends MatchableOrder { readonly terminalReason?: 'IOC_REMAINDER'; }
export interface SessionCalendar { isRegularSession(market: Market, at: Date): boolean; }
export interface PaperEngineOptions {
  readonly feeModel: FeeModel;
  readonly pricingModelVersion?: string;
  readonly calendar?: SessionCalendar;
  readonly now?: () => Date;
  readonly isGateExclusive?: () => boolean;
  readonly currentFencingToken?: (market: Market) => bigint;
  readonly onFill?: (order: PaperOrder, match: OrderMatch, pricing: PricingContext) => Promise<void> | void;
  readonly onAudit?: (event: unknown) => Promise<void> | void;
}

/** A single-writer market matcher. Persistence hooks run after all decisions are made. */
export class PaperEngine {
  readonly #options: PaperEngineOptions;
  readonly #orders = new Map<string, PaperOrder>();
  readonly #books = new Map<string, { envelope: MarketEnvelope<OrderBookSnapshot>; book: OrderBookSnapshot }>();
  readonly #trades = new Map<string, TradeEvent>();
  readonly #latest = new Map<string, MarketEnvelope<unknown>>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: PaperEngineOptions) { this.#options = options; }

  async onOrderBook(envelope: MarketEnvelope<OrderBookSnapshot>): Promise<void> {
    await this.#serialize(async () => {
      this.#assertEnvelope(envelope);
      const book = cloneOrderBook(envelope.payload);
      if (!this.#rememberEnvelope(this.#key(book.market, book.symbol), envelope)) return;
      this.#books.set(this.#key(book.market, book.symbol), { envelope, book });
      await this.#matchBook(book.market, book.symbol, envelope);
    });
  }

  async onTrade(envelope: MarketEnvelope<TradeEvent & { market: Market; symbol: string }>): Promise<void> {
    await this.#serialize(async () => {
      this.#assertEnvelope(envelope);
      if (!this.#rememberEnvelope(this.#key(envelope.payload.market, envelope.payload.symbol), envelope)) return;
      this.#trades.set(this.#key(envelope.payload.market, envelope.payload.symbol), envelope.payload);
    });
  }

  async placeImmediateOrder(command: ImmediateOrderCommand): Promise<PaperOrder> {
    return this.#serialize(async () => {
      const id = command.id ?? randomUUID();
      const type: OrderType = command.type ?? 'MARKET';
      const order: PaperOrder = { id, sessionId: command.sessionId, market: command.market, symbol: command.symbol,
        currency: command.currency, side: command.side, type, quantity: command.quantity,
        ...(command.limitPrice === undefined ? {} : { limitPrice: command.limitPrice }),
        status: 'OPEN', version: 0n, filledQuantity: '0' };
      this.#orders.set(id, order);
      const cached = this.#books.get(this.#key(order.market, order.symbol));
      if (cached !== undefined) await this.#matchBook(order.market, order.symbol, cached.envelope);
      return this.#orders.get(id) as PaperOrder;
    });
  }

  getOrder(id: string): PaperOrder | undefined { return this.#orders.get(id); }

  #assertEnvelope(envelope: MarketEnvelope<unknown>): void {
    if (envelope.recoveryEpoch < 0n || envelope.marketDataVersion < 0n || envelope.leaderFencingToken < 0n) throw new Error('invalid market envelope');
  }
  #rememberEnvelope(key: string, envelope: MarketEnvelope<unknown>): boolean {
    const previous = this.#latest.get(key);
    if (previous !== undefined && (envelope.recoveryEpoch < previous.recoveryEpoch ||
      (envelope.recoveryEpoch === previous.recoveryEpoch && envelope.leaderFencingToken < previous.leaderFencingToken) ||
      (envelope.recoveryEpoch === previous.recoveryEpoch && envelope.leaderFencingToken === previous.leaderFencingToken && envelope.marketDataVersion <= previous.marketDataVersion))) {
      return false;
    }
    this.#latest.set(key, envelope);
    return true;
  }
  async #matchBook(market: Market, symbol: string, envelope: MarketEnvelope<OrderBookSnapshot>): Promise<void> {
    const now = this.#options.now?.() ?? new Date();
    if (this.#options.calendar !== undefined && !this.#options.calendar.isRegularSession(market, now)) return;
    if (this.#options.isGateExclusive?.() === true) return;
    const book = cloneOrderBook(envelope.payload);
    for (const order of [...this.#orders.values()]) {
      if (order.market !== market || order.symbol !== symbol || (order.status !== 'OPEN' && order.status !== 'PARTIALLY_FILLED')) continue;
      const pricing = createPricingContext({ source: 'WEBSOCKET', recoveryEpoch: envelope.recoveryEpoch,
        marketDataVersion: envelope.marketDataVersion, leaderFencingToken: envelope.leaderFencingToken,
        referencePrice: this.#referencePrice(book), referenceTimestamp: null, book,
        pricingModelVersion: this.#options.pricingModelVersion ?? 'default', feeModelVersion: this.#options.feeModel.version });
      const match = matchOrder(order, book, pricing, this.#options.feeModel);
      if (this.#options.currentFencingToken?.(market) !== undefined && this.#options.currentFencingToken(market) !== envelope.leaderFencingToken) continue;
      const updated: PaperOrder = { ...order, filledQuantity: match.filledQuantity, status: match.nextStatus,
        version: order.version + 1n, ...(match.nextStatus === 'CANCELLED' ? { terminalReason: 'IOC_REMAINDER' as const } : {}) };
      this.#orders.set(order.id, updated);
      await this.#options.onFill?.(updated, match, pricing);
      await this.#options.onAudit?.({ eventType: 'FILL_CREATED', orderId: order.id, pricing, execution: match.execution });
    }
  }
  #referencePrice(book: OrderBookSnapshot): DecimalString { return book.asks[0]?.price ?? book.bids[0]?.price ?? '0'; }
  #key(market: Market, symbol: string): string { return `${market}:${symbol}`; }
  async #serialize<T>(work: () => Promise<T>): Promise<T> { const previous = this.#chain; let release!: () => void; this.#chain = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
}
