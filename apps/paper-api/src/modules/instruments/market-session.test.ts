import { describe, expect, it } from 'vitest';
import { derivePhase, tradingDateFor } from './market-session.js';

const day = (
  overrides: Partial<{
    isTradingDay: boolean;
    opensAt: string | null;
    closesAt: string | null;
  }> = {},
) => ({
  isTradingDay: true,
  opensAt: '2026-08-31T00:00:00.000Z',
  closesAt: '2026-08-31T06:30:00.000Z',
  ...overrides,
});

describe('derivePhase', () => {
  it('is HOLIDAY on a non-trading day even when a window is present', () => {
    expect(
      derivePhase(
        day({ isTradingDay: false }),
        new Date('2026-08-31T03:00:00.000Z'),
      ),
    ).toBe('HOLIDAY');
  });

  it('is CLOSED when the day is tradable but no session window is known', () => {
    expect(
      derivePhase(
        day({ opensAt: null, closesAt: null }),
        new Date('2026-08-31T03:00:00.000Z'),
      ),
    ).toBe('CLOSED');
    expect(
      derivePhase(
        day({ closesAt: null }),
        new Date('2026-08-31T03:00:00.000Z'),
      ),
    ).toBe('CLOSED');
  });

  it('is PRE_OPEN before the open and REGULAR from the opening instant', () => {
    expect(derivePhase(day(), new Date('2026-08-30T23:59:59.999Z'))).toBe(
      'PRE_OPEN',
    );
    // The opening instant belongs to the regular session.
    expect(derivePhase(day(), new Date('2026-08-31T00:00:00.000Z'))).toBe(
      'REGULAR',
    );
  });

  it('is REGULAR inside the window and POST_CLOSE from the closing instant', () => {
    expect(derivePhase(day(), new Date('2026-08-31T03:00:00.000Z'))).toBe(
      'REGULAR',
    );
    expect(derivePhase(day(), new Date('2026-08-31T06:29:59.999Z'))).toBe(
      'REGULAR',
    );
    // The closing instant is already outside the session.
    expect(derivePhase(day(), new Date('2026-08-31T06:30:00.000Z'))).toBe(
      'POST_CLOSE',
    );
    expect(derivePhase(day(), new Date('2026-08-31T09:00:00.000Z'))).toBe(
      'POST_CLOSE',
    );
  });

  it('is CLOSED when a timestamp cannot be parsed rather than guessing a phase', () => {
    expect(
      derivePhase(
        day({ opensAt: 'not-a-date' }),
        new Date('2026-08-31T03:00:00.000Z'),
      ),
    ).toBe('CLOSED');
  });
});

describe('tradingDateFor', () => {
  it('uses the market local calendar date, not the UTC date', () => {
    // 2026-08-31T20:00Z is already 2026-09-01 in Seoul and still 2026-08-31 in New York.
    const at = new Date('2026-08-31T20:00:00.000Z');
    expect(tradingDateFor('KR', at)).toBe('2026-09-01');
    expect(tradingDateFor('US', at)).toBe('2026-08-31');
  });

  it('formats as YYYY-MM-DD', () => {
    expect(tradingDateFor('KR', new Date('2026-01-02T01:00:00.000Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
