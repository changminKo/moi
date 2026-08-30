import type { Market } from '@moi/trading-core';
import { matchesInstrument } from './hangul-match.js';
import type { WhitelistService } from './whitelist-service.js';
export interface Instrument {
  readonly market: Market;
  readonly symbol: string;
  readonly name: string;
  readonly tradable: boolean;
  readonly currency?: 'KRW' | 'USD';
}
export interface CatalogInstrument extends Instrument {
  readonly aliases?: readonly string[];
}
export interface InstrumentServiceOptions {
  readonly catalog: readonly CatalogInstrument[];
  readonly whitelist?: WhitelistService;
}
export class InstrumentService {
  #catalog: readonly CatalogInstrument[];
  readonly #whitelist: WhitelistService | undefined;
  constructor(options: InstrumentServiceOptions) {
    this.#catalog = options.catalog;
    this.#whitelist = options.whitelist;
  }
  replaceCatalog(catalog: readonly CatalogInstrument[]): void {
    this.#catalog = catalog;
  }
  async search(query = '', market?: Market) {
    const items = this.#catalog
      .filter(
        (i) => (!market || i.market === market) && matchesInstrument(query, i),
      )
      .map((i) => {
        const instrument: Instrument = {
          market: i.market,
          symbol: i.symbol,
          name: i.name,
          tradable: this.#whitelist
            ? this.#whitelist.isTradable(i.market, i.symbol)
            : !i.symbol.endsWith('.UNLISTED'),
          ...(i.currency === undefined ? {} : { currency: i.currency }),
        };
        return instrument;
      });
    return { items };
  }
  async detail(market: Market, symbol: string) {
    return (await this.search(symbol, market)).items.find(
      (i) => i.symbol === symbol,
    );
  }
}
