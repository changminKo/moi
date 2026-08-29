import type { Market } from '@moi/trading-core';

export interface WhitelistVersion {
  readonly version: string;
  readonly markets: Readonly<Record<Market, readonly string[]>>;
}

export class WhitelistService {
  #current: WhitelistVersion;
  #cancelOnly = new Set<string>();
  #activeLegs = new Map<string, number>();
  constructor(version: WhitelistVersion) {
    this.#current = version;
  }
  get version(): string {
    return this.#current.version;
  }
  isTradable(market: Market, symbol: string): boolean {
    return (
      (this.#current.markets[market] ?? []).includes(symbol) &&
      !this.#cancelOnly.has(`${market}:${symbol}`)
    );
  }
  symbols(market: Market): readonly string[] {
    return this.#current.markets[market] ?? [];
  }
  markActiveLeg(market: Market, symbol: string): void {
    const key = `${market}:${symbol}`;
    this.#activeLegs.set(key, (this.#activeLegs.get(key) ?? 0) + 1);
  }
  markLegGone(market: Market, symbol: string): void {
    const key = `${market}:${symbol}`;
    const n = (this.#activeLegs.get(key) ?? 1) - 1;
    n > 0 ? this.#activeLegs.set(key, n) : this.#activeLegs.delete(key);
  }
  async publish(next: WhitelistVersion): Promise<void> {
    for (const market of ['KR', 'US'] as const)
      for (const symbol of this.symbols(market))
        if (!(next.markets[market] ?? []).includes(symbol)) {
          const key = `${market}:${symbol}`;
          this.#cancelOnly.add(key);
          if ((this.#activeLegs.get(key) ?? 0) > 0)
            throw Object.assign(new Error(`active legs remain for ${key}`), {
              code: 'CANCEL_ONLY',
            });
        }
    this.#current = next;
  }
}
