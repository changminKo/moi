import {
  DEFAULT_SPARKLINE_WINDOW,
  SPARKLINE_WINDOWS,
  type SparklineWindowSize,
} from './sparkline';

/**
 * The reader's chart window, remembered the way the locale is
 * (`lib/i18n/index.ts` and its `moi.locale` key): it is a display preference,
 * not data, so it outlives an instrument switch and a reload while the tick
 * ring itself is rebuilt per instrument.
 */
export const SPARKLINE_WINDOW_STORAGE_KEY = 'moi.sparklineWindow';

export function isSparklineWindowSize(
  value: unknown,
): value is SparklineWindowSize {
  return SPARKLINE_WINDOWS.some((size) => String(size) === String(value));
}

/**
 * Storage can be absent or throw (private mode, a browser blocking site
 * data), and a value stored by an older build may name a window this one no
 * longer offers. Either way the panel opens on the default rather than
 * failing: nothing here is allowed to throw during a render.
 */
export function readSparklineWindow(): SparklineWindowSize {
  try {
    const stored = window.localStorage.getItem(SPARKLINE_WINDOW_STORAGE_KEY);
    if (stored === null) return DEFAULT_SPARKLINE_WINDOW;
    const parsed = Number(stored);
    return isSparklineWindowSize(parsed) ? parsed : DEFAULT_SPARKLINE_WINDOW;
  } catch {
    return DEFAULT_SPARKLINE_WINDOW;
  }
}

export function writeSparklineWindow(next: SparklineWindowSize): void {
  try {
    window.localStorage.setItem(SPARKLINE_WINDOW_STORAGE_KEY, String(next));
  } catch {
    // Same contract as `changeLocale`: the choice just won't stick.
  }
}
