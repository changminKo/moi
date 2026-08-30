import { describe, expect, it } from 'vitest';
import {
  assertKnownReason,
  composeTradingAvailability,
  presentationForReason,
} from './system-status-provider';

describe('trading availability', () => {
  it.each([
    ['NORMAL', true, true, true],
    ['CANCEL_ONLY', false, true, false],
    ['READ_ONLY', false, false, false],
    ['UNAVAILABLE', false, false, false],
  ] as const)('%s derives safe action gates', (mode, place, cancel, fx) => {
    const result = composeTradingAvailability({
      mode,
      canPlace: place,
      canCancel: cancel,
      canFx: fx,
      reasonCodes: [],
    });
    expect(result.place.enabled).toBe(place);
    expect(result.cancel.enabled).toBe(cancel);
    expect(result.fx.enabled).toBe(fx);
  });

  it('keeps market degradation and recovery scoped to placement', () => {
    for (const reason of ['MARKET_DATA_DEGRADED', 'RECOVERY_IN_PROGRESS']) {
      const result = composeTradingAvailability({
        mode: 'NORMAL',
        canPlace: true,
        canCancel: true,
        canFx: true,
        reasonCodes: [reason],
      });
      expect(result.place.enabled).toBe(false);
      expect(result.cancel.enabled).toBe(true);
      expect(result.fx.enabled).toBe(true);
      expect(result.place.reasons).toContain(reason);
    }
  });

  it('fails closed when the server rejects an action despite stale UI capability', () => {
    const result = composeTradingAvailability({
      mode: 'NORMAL',
      canPlace: false,
      canCancel: true,
      canFx: true,
      reasonCodes: ['CANCEL_ONLY'],
    });
    expect(result.place.enabled).toBe(false);
    expect(result.place.reasons).toContain('CANCEL_ONLY');
  });

  it('requires every server reason to have presentation text', () => {
    expect(presentationForReason('ACCOUNT_READ_ONLY')).toMatch(/account/i);
    expect(presentationForReason('ACCOUNT_READ_ONLY', 'ko')).toBe(
      '계정 보호 잠금',
    );
    expect(() => assertKnownReason('NEW_SERVER_REASON')).toThrow();
    expect(() => assertKnownReason('ACCOUNT_READ_ONLY')).not.toThrow();
  });

  it('degrades an unknown reason to its raw code instead of throwing', () => {
    // A newly emitted server code must not blank the app mid-incident.
    expect(presentationForReason('MARKET_CLOSED')).toBe('MARKET_CLOSED');
    expect(presentationForReason('MARKET_CLOSED', 'ko')).toBe('MARKET_CLOSED');
  });
});
