import { describe, expect, it } from 'vitest';
import type { Capability, SafetyIncident } from '../safety/capabilities.js';
import { marketHealthView } from './market-health-view.js';

const MARKET_DENIED: readonly Capability[] = [
  'PLACE',
  'AMEND',
  'MATCH',
  'TRIGGER',
];

function incident(
  overrides: Partial<SafetyIncident> & { scope: SafetyIncident['scope'] },
): SafetyIncident {
  return {
    incidentId: 'incident',
    denied: new Set(MARKET_DENIED),
    causeCode: 'TRANSPORT_CLOSED',
    recoveryEpoch: null,
    version: 1n,
    status: 'ACTIVE',
    ...overrides,
  };
}

describe('marketHealthView', () => {
  it('labels a healthy feed with no incident NORMAL', () => {
    expect(
      marketHealthView({ market: 'KR', feedState: 'HEALTHY', incidents: [] }),
    ).toEqual({ state: 'NORMAL', reasons: [] });
  });
  it('never reports NORMAL while an ACTIVE incident denies PLACE', () => {
    // The defect this defends: the in-memory feed state said NORMAL while the
    // ledger rows placement is derived from were still ACTIVE.
    expect(
      marketHealthView({
        market: 'US',
        feedState: 'HEALTHY',
        incidents: [
          incident({
            scope: { type: 'MARKET', id: 'US' },
            causeCode: 'PONG_FAILED',
          }),
        ],
      }),
    ).toEqual({ state: 'DEGRADED', reasons: ['PONG_FAILED'] });
  });
  it('counts a GLOBAL incident against every market and names it', () => {
    expect(
      marketHealthView({
        market: 'KR',
        feedState: 'HEALTHY',
        incidents: [
          incident({
            scope: { type: 'GLOBAL', id: '*' },
            causeCode: 'STARTUP_INVARIANT_OR_AUDIT_FAILURE',
          }),
        ],
      }),
    ).toEqual({
      state: 'DEGRADED',
      reasons: ['STARTUP_INVARIANT_OR_AUDIT_FAILURE'],
    });
  });
  it('ignores another market’s incident and any row that still allows PLACE', () => {
    expect(
      marketHealthView({
        market: 'KR',
        feedState: 'HEALTHY',
        incidents: [
          incident({ scope: { type: 'MARKET', id: 'US' } }),
          incident({
            scope: { type: 'MARKET', id: 'KR' },
            denied: new Set<Capability>(['RECOVER']),
            causeCode: 'RECOVER_ONLY',
          }),
          incident({
            scope: { type: 'MARKET', id: 'KR' },
            status: 'RESOLVED',
            causeCode: 'RESOLVED_ALREADY',
          }),
        ],
      }),
    ).toEqual({ state: 'NORMAL', reasons: ['RECOVER_ONLY'] });
  });
  it('keeps the feed state when it is worse than the incident rows', () => {
    expect(
      marketHealthView({
        market: 'KR',
        feedState: 'RECOVERING',
        incidents: [],
      }).state,
    ).toBe('RECOVERING');
    expect(
      marketHealthView({ market: 'KR', feedState: undefined, incidents: [] })
        .state,
    ).toBe('RECOVERING');
  });
});
