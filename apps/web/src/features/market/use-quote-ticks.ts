import { useEffect, useRef, useState } from 'react';
import type { QuoteSnapshot } from '../../lib/api-types';
import { appendTick, type TickPoint } from './sparkline';

/**
 * Collects the priced quote snapshots observed for one instrument. The ring
 * resets when the instrument changes and ignores repeated snapshots (same
 * asOf), so it grows only with genuinely new ticks.
 */
export function useQuoteTicks(
  quote: QuoteSnapshot | null,
): readonly TickPoint[] {
  const [ticks, setTicks] = useState<readonly TickPoint[]>([]);
  const instrumentRef = useRef<string>('');
  useEffect(() => {
    if (!quote) return;
    const instrument = `${quote.market}:${quote.symbol}`;
    if (instrumentRef.current !== instrument) {
      instrumentRef.current = instrument;
      setTicks([]);
    }
    if (quote.price === null) return;
    const tick: TickPoint = { asOf: quote.asOf, price: quote.price };
    setTicks((current) => appendTick(current, tick));
  }, [quote]);
  return ticks;
}
