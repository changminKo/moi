import { describe, expect, it } from 'vitest';
import type { Capability, SafetyIncident } from '../safety/capabilities.js';
import { AdmissionLatch } from './admission-latch.js';
import { TradingCapabilities } from './trading-capabilities.js';

const incident = (
  scope: SafetyIncident['scope'],
  denied: readonly Capability[],
  causeCode = 'TEST',
): SafetyIncident => ({
  incidentId: `${scope.type}-${scope.id}`,
  scope,
  denied: new Set(denied),
  causeCode,
  recoveryEpoch: null,
  version: 1n,
  status: 'ACTIVE',
});

describe('TradingCapabilities', () => {
  it('yields only CANCEL while the admission latch is closed', () => {
    const latch = new AdmissionLatch();
    const capabilities = new TradingCapabilities({
      latch,
      activeIncidents: () => [],
    });
    expect([...capabilities.for('KR')]).toEqual(['CANCEL']);
    expect([...capabilities.for('US')]).toEqual(['CANCEL']);
  });

  it('yields every capability when open with no incidents', () => {
    const latch = new AdmissionLatch();
    latch.open();
    const capabilities = new TradingCapabilities({
      latch,
      activeIncidents: () => [],
    });
    expect([...capabilities.for('KR')].sort()).toEqual(
      ['AMEND', 'CANCEL', 'MATCH', 'PLACE', 'RECOVER', 'TRIGGER'].sort(),
    );
  });

  it('applies GLOBAL and LOCAL incidents to every market but MARKET incidents to their market only', () => {
    const latch = new AdmissionLatch();
    latch.open();
    const capabilities = new TradingCapabilities({
      latch,
      activeIncidents: () => [
        incident({ type: 'MARKET', id: 'KR' }, [
          'PLACE',
          'AMEND',
          'MATCH',
          'TRIGGER',
        ]),
        incident({ type: 'GLOBAL', id: '*' }, ['RECOVER']),
        incident({ type: 'SYMBOL', id: 'US:AAPL' }, ['PLACE']),
      ],
    });
    expect([...capabilities.for('KR')].sort()).toEqual(['CANCEL']);
    expect([...capabilities.for('US')].sort()).toEqual(
      ['AMEND', 'CANCEL', 'MATCH', 'PLACE', 'TRIGGER'].sort(),
    );
  });

  it('ignores resolved incidents', () => {
    const latch = new AdmissionLatch();
    latch.open();
    const resolved = {
      ...incident({ type: 'GLOBAL', id: '*' }, ['PLACE']),
      status: 'RESOLVED' as const,
    };
    const capabilities = new TradingCapabilities({
      latch,
      activeIncidents: () => [resolved],
    });
    expect(capabilities.for('US').has('PLACE')).toBe(true);
  });

  it('summarises trading health across markets with blocked-market reasons', () => {
    const latch = new AdmissionLatch();
    latch.open();
    const capabilities = new TradingCapabilities({
      latch,
      activeIncidents: () => [
        incident(
          { type: 'MARKET', id: 'KR' },
          ['PLACE', 'AMEND', 'MATCH', 'TRIGGER'],
          'TRANSPORT_CLOSED',
        ),
      ],
    });
    expect(capabilities.tradingHealth([])).toEqual({
      placement: true,
      cancellation: true,
      fx: true,
      reasons: ['MARKET_DEGRADED:KR'],
    });
  });

  it('reports CANCEL_ONLY with runtime reasons while the latch is closed', () => {
    const capabilities = new TradingCapabilities({
      latch: new AdmissionLatch(),
      activeIncidents: () => [],
    });
    expect(capabilities.tradingHealth(['ACQUIRING_LEASES'])).toEqual({
      placement: false,
      cancellation: true,
      fx: false,
      reasons: ['CANCEL_ONLY', 'ACQUIRING_LEASES'],
    });
  });

  it('blocks fx on GLOBAL incidents even when a market can still place', () => {
    const latch = new AdmissionLatch();
    latch.open();
    const capabilities = new TradingCapabilities({
      latch,
      activeIncidents: () => [
        incident({ type: 'GLOBAL', id: '*' }, ['RECOVER'], 'OPERATOR'),
      ],
    });
    const health = capabilities.tradingHealth([]);
    expect(health.placement).toBe(true);
    expect(health.fx).toBe(false);
    expect(health.reasons).toContain('GLOBAL_INCIDENT:OPERATOR');
  });
});
