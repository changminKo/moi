import { describe, expect, test } from 'vitest';
import { formatTimestamp } from './format-datetime';

// A fixed instant so the assertions do not depend on the day they run:
// 2026-08-30T07:49:08.683Z is 16:49 in Seoul.
const INSTANT = '2026-08-30T07:49:08.683Z';

describe('formatTimestamp', () => {
  test('renders a Korean timestamp for the ko locale', () => {
    const formatted = formatTimestamp(INSTANT, 'ko', 'Asia/Seoul');

    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/오전|오후/);
    expect(formatted).not.toContain('T');
    expect(formatted).not.toContain('Z');
  });

  test('renders an English timestamp for the en locale', () => {
    const formatted = formatTimestamp(INSTANT, 'en', 'America/New_York');

    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/AM|PM/);
    expect(formatted).not.toContain('T');
  });

  test('renders the same instant differently per locale', () => {
    expect(formatTimestamp(INSTANT, 'ko', 'Asia/Seoul')).not.toBe(
      formatTimestamp(INSTANT, 'en', 'America/New_York'),
    );
  });

  test('resolves the instant into the requested zone', () => {
    // 07:49 UTC is 16:49 in Seoul and 03:49 in New York.
    expect(formatTimestamp(INSTANT, 'en', 'Asia/Seoul')).toContain('4:49');
    expect(formatTimestamp(INSTANT, 'en', 'America/New_York')).toContain(
      '3:49',
    );
  });

  test('returns the raw value when the timestamp cannot be parsed', () => {
    // The panel must keep rendering: a quote is still useful when only its
    // timestamp is malformed.
    expect(formatTimestamp('not-a-timestamp', 'ko')).toBe('not-a-timestamp');
    expect(formatTimestamp('', 'ko')).toBe('');
  });
});
