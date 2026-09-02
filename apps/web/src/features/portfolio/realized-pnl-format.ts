import { withSignedCurrency } from '../../lib/currency';
import {
  capFractionDigits,
  formatDecimal,
  isZeroDecimal,
} from '../../lib/format-number';
import type { RealizedPnlEntry } from './realized-pnl';

// The same render cap the positions table applies to money: the fold's figure
// is exact and stays so; only what is drawn is shortened.
const MAX_DISPLAYED_FRACTION_DIGITS = 2;

export type PnlTone = 'pnl-gain' | 'pnl-loss' | undefined;

/**
 * How a realized figure is drawn: capped to two places, sign ahead of the
 * currency, and a tone class for the colour — the quote panel's up/down pair,
 * with zero left plain. Shared by the per-symbol cells and the session strip
 * so the two cannot disagree about what a loss looks like.
 */
export function formatRealizedPnl(entry: RealizedPnlEntry): {
  readonly text: string;
  readonly tone: PnlTone;
} {
  const capped = capFractionDigits(
    entry.realizedPnl,
    MAX_DISPLAYED_FRACTION_DIGITS,
  );
  const tone: PnlTone = isZeroDecimal(capped)
    ? undefined
    : capped.startsWith('-')
      ? 'pnl-loss'
      : 'pnl-gain';
  return {
    text: withSignedCurrency(entry.currency, formatDecimal(capped)),
    tone,
  };
}
