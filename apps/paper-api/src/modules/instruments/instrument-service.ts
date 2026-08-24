import type { Market } from '@skipjack/trading-core';
import type { WhitelistService } from './whitelist-service.js';
export interface Instrument {
  readonly market: Market;
  readonly symbol: string;
  readonly name: string;
  readonly tradable: boolean;
  readonly currency?: 'KRW' | 'USD';
}
export interface InstrumentServiceOptions {
  readonly catalog: readonly Instrument[];
  readonly whitelist?: WhitelistService;
}
export class InstrumentService {
  readonly #catalog: readonly Instrument[];
  readonly #whitelist: WhitelistService | undefined;
  constructor(options: InstrumentServiceOptions) {
    this.#catalog = options.catalog;
    this.#whitelist = options.whitelist;
  }
  async search(query = '', market?: Market) {
    const q = query.trim().toLowerCase();
    const items = this.#catalog
      .filter(
        (i) =>
          (!market || i.market === market) &&
          (!q || `${i.symbol} ${i.name}`.toLowerCase().includes(q)),
      )
      .map((i) => ({
        ...i,
        tradable: this.#whitelist
          ? this.#whitelist.isTradable(i.market, i.symbol)
          : !i.symbol.endsWith('.UNLISTED'),
      }));
    return { items };
  }
  async detail(market: Market, symbol: string) {
    return (await this.search(symbol, market)).items.find(
      (i) => i.symbol === symbol,
    );
  }
}
