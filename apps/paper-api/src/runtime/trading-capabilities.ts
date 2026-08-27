import type { Market } from '@skipjack/trading-core';
import {
  ALL_CAPABILITIES,
  type Capability,
  type SafetyIncident,
} from '../safety/capabilities.js';

export interface TradingCapabilitiesDeps {
  readonly latch: { readonly isClosed: boolean };
  readonly activeIncidents: () => readonly SafetyIncident[];
}

export interface TradingHealth {
  readonly placement: boolean;
  readonly cancellation: true;
  readonly fx: boolean;
  readonly reasons: readonly string[];
}

const MARKETS: readonly Market[] = ['KR', 'US'];
const CANCEL_ONLY: ReadonlySet<Capability> = new Set<Capability>(['CANCEL']);

function appliesTo(incident: SafetyIncident, market: Market): boolean {
  if (incident.status !== 'ACTIVE') return false;
  const { type, id } = incident.scope;
  if (type === 'GLOBAL') return true;
  if (type === 'MARKET') return id === market;
  return false;
}

/** §6.4 effective capability computation per market. */
export class TradingCapabilities {
  readonly #deps: TradingCapabilitiesDeps;

  constructor(deps: TradingCapabilitiesDeps) {
    this.#deps = deps;
  }

  for(market: Market): ReadonlySet<Capability> {
    if (this.#deps.latch.isClosed) return CANCEL_ONLY;
    const denied = new Set<Capability>();
    for (const incident of this.#deps.activeIncidents()) {
      if (!appliesTo(incident, market)) continue;
      for (const capability of incident.denied) denied.add(capability);
    }
    return new Set(ALL_CAPABILITIES.filter((c) => !denied.has(c)));
  }

  tradingHealth(runtimeReasons: readonly string[]): TradingHealth {
    if (this.#deps.latch.isClosed) {
      return {
        placement: false,
        cancellation: true,
        fx: false,
        reasons: ['CANCEL_ONLY', ...runtimeReasons],
      };
    }
    const reasons: string[] = [...runtimeReasons];
    const perMarket = MARKETS.map((market) => ({
      market,
      capabilities: this.for(market),
    }));
    for (const { market, capabilities } of perMarket) {
      if (!capabilities.has('PLACE')) reasons.push(`MARKET_DEGRADED:${market}`);
    }
    const globalIncidents = this.#deps
      .activeIncidents()
      .filter((i) => i.status === 'ACTIVE' && i.scope.type === 'GLOBAL');
    for (const incident of globalIncidents)
      reasons.push(`GLOBAL_INCIDENT:${incident.causeCode}`);
    return {
      placement: perMarket.some((m) => m.capabilities.has('PLACE')),
      cancellation: true,
      fx: globalIncidents.length === 0,
      reasons,
    };
  }
}
