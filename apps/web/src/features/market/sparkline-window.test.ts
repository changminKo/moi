import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPARKLINE_WINDOW } from './sparkline';
import {
  readSparklineWindow,
  SPARKLINE_WINDOW_STORAGE_KEY,
  writeSparklineWindow,
} from './sparkline-window';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('readSparklineWindow', () => {
  it('defaults when nothing has been stored', () => {
    expect(readSparklineWindow()).toBe(DEFAULT_SPARKLINE_WINDOW);
  });

  it('reads back a window the reader chose', () => {
    writeSparklineWindow(30);
    expect(readSparklineWindow()).toBe(30);
  });

  it('ignores a stored value that is not one of the options', () => {
    window.localStorage.setItem(SPARKLINE_WINDOW_STORAGE_KEY, '1000');
    expect(readSparklineWindow()).toBe(DEFAULT_SPARKLINE_WINDOW);
    window.localStorage.setItem(SPARKLINE_WINDOW_STORAGE_KEY, 'lots');
    expect(readSparklineWindow()).toBe(DEFAULT_SPARKLINE_WINDOW);
  });

  it('defaults instead of throwing when storage is unavailable', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    expect(readSparklineWindow()).toBe(DEFAULT_SPARKLINE_WINDOW);
  });
});

describe('writeSparklineWindow', () => {
  it('swallows a storage failure instead of breaking the panel', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeSparklineWindow(240)).not.toThrow();
  });
});
