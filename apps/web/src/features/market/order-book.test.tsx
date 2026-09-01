import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { BookLevel } from '../../lib/api-types';
import '../../lib/i18n';
import { depthPercent, maxVolume, OrderBook } from './order-book';

afterEach(cleanup);

/**
 * The levels exactly as the stream sends them — captured from a live
 * `US:AAPL` quote frame. The wire word is `volume`, the same word the ledger
 * column (`book_level_volume`), `OrderBookLevel` in `@moi/trading-core` and
 * the engine all use. The web type used to say `size`, so `level.size` was
 * `undefined` and `Decimal.max` threw `[DecimalError] Invalid argument:
 * undefined` — synchronously, during render, with no ErrorBoundary above it,
 * which unmounted the whole tree.
 */
const CAPTURED_ASKS: readonly BookLevel[] = [{ price: '316.65', volume: '40' }];
const CAPTURED_BIDS: readonly BookLevel[] = [{ price: '316.44', volume: '80' }];

const depthWidths = (): readonly string[] =>
  [...document.querySelectorAll<HTMLElement>('.depth-bar')].map(
    (bar) => bar.style.width,
  );

describe('OrderBook with the levels the stream actually sends', () => {
  test('renders a captured frame instead of throwing', () => {
    render(<OrderBook bids={CAPTURED_BIDS} asks={CAPTURED_ASKS} />);

    expect(screen.getByText('316.65')).toBeVisible();
    expect(screen.getByText('316.44')).toBeVisible();
    expect(screen.getByText('40')).toBeVisible();
    expect(screen.getByText('80')).toBeVisible();
  });

  test('scales each depth bar against the deepest level on either side', () => {
    render(<OrderBook bids={CAPTURED_BIDS} asks={CAPTURED_ASKS} />);

    // 80 is the deepest, so the ask's 40 is half of it.
    expect(depthWidths()).toEqual(['50%', '100%']);
  });
});

describe('OrderBook never throws on a malformed level', () => {
  // The boundary validator drops levels like these before they reach the
  // component, but the render path holds to the same contract on its own —
  // the one `format-number.ts` states: anything that is not a plain decimal
  // passes through unchanged, never a throw.
  test('renders a level whose volume is missing as zero depth', () => {
    const broken = [{ price: '316.65' }] as unknown as readonly BookLevel[];

    render(<OrderBook asks={broken} />);

    expect(screen.getByText('316.65')).toBeVisible();
    expect(depthWidths()).toEqual(['0%']);
  });

  test('renders a level whose volume is unparseable as zero depth', () => {
    render(
      <OrderBook
        asks={[{ price: '316.65', volume: 'N/A' }]}
        bids={[{ price: '316.44', volume: '80' }]}
      />,
    );

    expect(screen.getByText('N/A')).toBeVisible();
    expect(depthWidths()).toEqual(['0%', '100%']);
  });

  test('renders the empty state for both sides with no levels', () => {
    render(<OrderBook />);

    expect(screen.getByText('No asks')).toBeVisible();
    expect(screen.getByText('No bids')).toBeVisible();
  });
});

describe('depthPercent', () => {
  test('scales a volume against the maximum', () => {
    expect(depthPercent('40', '80')).toBe(50);
    expect(depthPercent('80', '80')).toBe(100);
  });

  test('caps at 100 rather than overflowing the bar', () => {
    expect(depthPercent('160', '80')).toBe(100);
  });

  test('returns zero instead of dividing by an empty book', () => {
    expect(depthPercent('40', '0')).toBe(0);
    expect(depthPercent('40', '0.0')).toBe(0);
  });

  test('returns zero for values it cannot parse', () => {
    expect(depthPercent('N/A', '80')).toBe(0);
    expect(depthPercent('40', '—')).toBe(0);
    expect(depthPercent(undefined as unknown as string, '80')).toBe(0);
  });
});

describe('maxVolume', () => {
  test('reports the deepest level as a decimal string', () => {
    expect(
      maxVolume([
        { price: '1', volume: '40' },
        { price: '2', volume: '80.5' },
      ]),
    ).toBe('80.5');
  });

  test('ignores levels it cannot parse instead of throwing', () => {
    const levels = [
      { price: '1', volume: '40' },
      { price: '2' },
      { price: '3', volume: 'N/A' },
    ] as unknown as readonly BookLevel[];

    expect(maxVolume(levels)).toBe('40');
  });

  test('reports zero for an empty book', () => {
    expect(maxVolume([])).toBe('0');
  });
});
