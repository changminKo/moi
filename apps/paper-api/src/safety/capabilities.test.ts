import { describe, expect, it } from 'vitest';
import {
  ALL_CAPABILITIES,
  intersectCapabilities,
  type SafetyIncident,
} from './capabilities.js';

const incident = (denied: readonly (typeof ALL_CAPABILITIES[number])[], causeCode: string): SafetyIncident => ({
  incidentId: causeCode,
  scope: { type: 'MARKET', id: 'KR' },
  denied: new Set(denied),
  causeCode,
  recoveryEpoch: null,
  version: 1n,
  status: 'ACTIVE',
});

describe('capability intersection', () => {
  it('intersects independent incidents without one cause clearing another', () => {
    const effective = intersectCapabilities([
      incident(['PLACE', 'AMEND', 'MATCH', 'TRIGGER'], 'FEED'),
      incident(['CANCEL'], 'OPERATOR'),
    ]);
    expect(effective.allowed).not.toContain('PLACE');
    expect(effective.allowed).not.toContain('CANCEL');
  });

  it('keeps cancellation available in CANCEL_ONLY and blocks read mutations', () => {
    const cancelOnly = intersectCapabilities([incident(['PLACE', 'AMEND', 'MATCH', 'TRIGGER'], 'FEED')]);
    expect(cancelOnly.allowed).toContain('CANCEL');
    expect(cancelOnly.allowed).not.toContain('MATCH');
    const readOnly = intersectCapabilities([incident(['PLACE', 'AMEND', 'CANCEL', 'MATCH', 'TRIGGER'], 'ACCOUNT')]);
    expect(readOnly.allowed).not.toContain('PLACE');
    expect(readOnly.allowed).not.toContain('CANCEL');
  });
});
