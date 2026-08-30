import type { Market } from '@moi/trading-core';

/**
 * Trading phase of one market at one instant. `CLOSED` is the honest answer
 * when the day is tradable but the provider gave no usable session window —
 * it never claims a holiday or a pre/post window the calendar did not state.
 */
export type MarketPhase =
  | 'REGULAR'
  | 'PRE_OPEN'
  | 'POST_CLOSE'
  | 'CLOSED'
  | 'HOLIDAY';

/** The calendar facts a phase is derived from (one market, one day). */
export interface MarketSessionWindow {
  readonly isTradingDay: boolean;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}

/** IANA zone whose local calendar date decides a market's trading date. */
const MARKET_TIME_ZONE: Readonly<Record<Market, string>> = {
  KR: 'Asia/Seoul',
  US: 'America/New_York',
};

function epoch(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Phase of `day` at `now`. Pure: same inputs, same answer, no clock of its own.
 * The opening instant is already REGULAR; the closing instant is already
 * POST_CLOSE, so the two windows never overlap.
 */
export function derivePhase(day: MarketSessionWindow, now: Date): MarketPhase {
  if (!day.isTradingDay) return 'HOLIDAY';
  const opens = epoch(day.opensAt);
  const closes = epoch(day.closesAt);
  if (opens === null || closes === null) return 'CLOSED';
  const at = now.getTime();
  if (at < opens) return 'PRE_OPEN';
  if (at < closes) return 'REGULAR';
  return 'POST_CLOSE';
}

/**
 * Calendar date (`YYYY-MM-DD`) the market is trading at `at`, in the market's
 * own time zone. Asking Toss for the UTC date would request yesterday's
 * calendar for KR every evening.
 */
export function tradingDateFor(market: Market, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TIME_ZONE[market],
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
