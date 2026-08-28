import { randomUUID } from 'node:crypto';
import {
  type Currency,
  type DecimalString,
  decimal,
} from '@skipjack/trading-core';
import type { FxQuoteInput } from './fx-schemas.js';

export interface FxQuote {
  readonly id: string;
  readonly sessionId: string;
  readonly from: Currency;
  readonly to: Currency;
  readonly sourceAmount: DecimalString;
  readonly rate: DecimalString;
  readonly fee: '0';
  readonly targetAmount: DecimalString;
  readonly serverTime: string;
  readonly expiresAt: string;
}
export interface ExchangeReceipt {
  readonly quoteId: string;
  readonly sessionId: string;
  readonly from: Currency;
  readonly to: Currency;
  readonly sourceAmount: string;
  readonly targetAmount: string;
  readonly fee: '0';
  readonly exchangedAt: string;
}
export interface FxServiceOptions {
  readonly clock?: () => Date;
  readonly rate?:
    | DecimalString
    | ((from: Currency, to: Currency) => DecimalString);
  readonly quoteTtlMs?: number;
  readonly onExchange?: (
    quote: FxQuote,
    receipt: ExchangeReceipt,
  ) => Promise<void>;
  readonly wallets?: Map<string, Map<Currency, DecimalString>>;
  readonly loadWallets?: (
    sessionId: string,
  ) => Promise<Map<Currency, DecimalString>>;
}
const currencyOrder: Record<Currency, number> = { KRW: 0, USD: 1 };
function error(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, retryable });
}
function canonical(value: ReturnType<typeof decimal>): string {
  return value.toString();
}

export class FxService {
  readonly #clock: () => Date;
  readonly #rate: FxServiceOptions['rate'];
  readonly #ttl: number;
  readonly #quotes = new Map<string, FxQuote>();
  readonly #used = new Set<string>();
  readonly #responses = new Map<string, ExchangeReceipt>();
  readonly #wallets: Map<string, Map<Currency, DecimalString>>;
  readonly #onExchange?: FxServiceOptions['onExchange'];
  readonly #loadWallets?: FxServiceOptions['loadWallets'];
  constructor(options: FxServiceOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#rate = options.rate ?? '0.0007';
    this.#ttl = options.quoteTtlMs ?? 10_000;
    this.#onExchange = options.onExchange;
    this.#wallets = options.wallets ?? new Map();
    this.#loadWallets = options.loadWallets;
  }
  async quote(sessionId: string, input: FxQuoteInput): Promise<FxQuote> {
    if (input.from === input.to)
      throw error('INVALID_ORDER', 'Currencies must differ');
    const now = this.#clock();
    const rate: DecimalString =
      typeof this.#rate === 'function'
        ? this.#rate(input.from, input.to)
        : (this.#rate ?? '0.0007');
    const amount = decimal(input.amount);
    if (!amount.isFinite() || amount.isNegative() || amount.isZero())
      throw error('INVALID_QUANTITY', 'Amount must be positive');
    const targetAmount = canonical(amount.times(rate));
    const expiresAt = new Date(now.getTime() + this.#ttl);
    const result: FxQuote = {
      id: randomUUID(),
      sessionId,
      from: input.from,
      to: input.to,
      sourceAmount: canonical(amount),
      rate: canonical(decimal(rate)),
      fee: '0',
      targetAmount,
      serverTime: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.#quotes.set(result.id, result);
    return result;
  }
  async exchange(
    sessionId: string,
    quoteId: string,
    idempotencyKey: string,
  ): Promise<ExchangeReceipt> {
    const replay = this.#responses.get(`${sessionId}:${idempotencyKey}`);
    if (replay) return replay;
    const quote = this.#quotes.get(quoteId);
    if (!quote || quote.sessionId !== sessionId)
      throw error('NOT_FOUND', 'Quote not found');
    if (this.#used.has(quoteId))
      throw error('QUOTE_CONSUMED', 'Quote was already consumed');
    if (this.#clock().getTime() >= Date.parse(quote.expiresAt))
      throw error('QUOTE_EXPIRED', 'Exchange quote has expired');
    // The ordering is part of the contract and prevents cross-currency deadlocks.
    const locks = [quote.from, quote.to].sort(
      (a, b) => currencyOrder[a] - currencyOrder[b],
    );
    // The ledger is the source of truth: fills and reservations move cash
    // outside this service, so a loader always wins over the in-memory copy.
    const wallet =
      (await this.#loadWallets?.(sessionId)) ??
      this.#wallets.get(sessionId) ??
      new Map<Currency, DecimalString>();
    this.#wallets.set(sessionId, wallet);
    for (const currency of locks) {
      if (!wallet.has(currency)) wallet.set(currency, '0');
    }
    const source = decimal(wallet.get(quote.from) ?? '0');
    if (source.lessThan(quote.sourceAmount))
      throw error(
        'INSUFFICIENT_AVAILABLE_CASH',
        'Insufficient available balance',
      );
    const receipt: ExchangeReceipt = {
      quoteId,
      sessionId,
      from: quote.from,
      to: quote.to,
      sourceAmount: quote.sourceAmount,
      targetAmount: quote.targetAmount,
      fee: '0',
      exchangedAt: this.#clock().toISOString(),
    };
    if (this.#onExchange) await this.#onExchange(quote, receipt);
    wallet.set(quote.from, canonical(source.minus(quote.sourceAmount)));
    wallet.set(
      quote.to,
      canonical(decimal(wallet.get(quote.to) ?? '0').plus(quote.targetAmount)),
    );
    this.#used.add(quoteId);
    this.#responses.set(`${sessionId}:${idempotencyKey}`, receipt);
    return receipt;
  }
}
