import type { Market } from '@moi/trading-core';
import type { HealthState } from '../market-data/health-machine.js';
import type { SafetyIncident } from '../safety/capabilities.js';

const HEALTH_LABEL: Record<HealthState, string> = {
  HEALTHY: 'NORMAL',
  DEGRADED: 'DEGRADED',
  RECOVERING: 'RECOVERING',
};

export interface MarketHealthView {
  readonly state: string;
  readonly reasons: readonly string[];
}

function appliesTo(incident: SafetyIncident, market: Market): boolean {
  if (incident.status !== 'ACTIVE') return false;
  const { type, id } = incident.scope;
  return type === 'GLOBAL' || (type === 'MARKET' && id === market);
}

/**
 * The reported state of one market (§16.33). Feed health lives in memory and
 * dies with the process; the ACTIVE incident rows decide whether orders can be
 * placed and survive a restart. Reporting the first while placement follows
 * the second is what let `state=NORMAL` sit next to `placement=false` with no
 * reason an operator could see, so the state answers to both.
 */
export function marketHealthView(input: {
  readonly market: Market;
  readonly feedState: HealthState | undefined;
  readonly incidents: readonly SafetyIncident[];
}): MarketHealthView {
  const applying = input.incidents.filter((incident) =>
    appliesTo(incident, input.market),
  );
  const feed = HEALTH_LABEL[input.feedState ?? 'RECOVERING'] ?? 'RECOVERING';
  const blocksPlacement = applying.some((incident) =>
    incident.denied.has('PLACE'),
  );
  return {
    state: feed === 'NORMAL' && blocksPlacement ? 'DEGRADED' : feed,
    reasons: applying.map((incident) => incident.causeCode),
  };
}
