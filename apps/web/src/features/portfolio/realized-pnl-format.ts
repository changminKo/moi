import { withSignedCurrency } from '../../lib/currency';
import {
  capFractionDigits,
  formatDecimal,
  isZeroDecimal,
  MONEY_DISPLAY_FRACTION_DIGITS,
} from '../../lib/format-number';
import type { RealizedPnlEntry } from './realized-pnl';

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
    MONEY_DISPLAY_FRACTION_DIGITS,
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
