import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../lib/i18n';
import { QuoteSparkline } from './quote-sparkline';
import { SPARKLINE_CAP, type TickPoint } from './sparkline';

afterEach(cleanup);

const ring = (count: number): readonly TickPoint[] =>
  Array.from({ length: count }, (_, index) => ({
    asOf: `t${index}`,
    price: String(300 + index),
  }));

describe('QuoteSparkline window control', () => {
  it('offers every selectable window as a radio', () => {
    render(
      <QuoteSparkline
        ticks={ring(5)}
        windowSize={120}
        onWindowSizeChange={vi.fn()}
      />,
    );

    const group = screen.getByRole('group', { name: 'Chart window' });
    expect(group).toBeVisible();
    for (const label of ['30 ticks', '60 ticks', '120 ticks', '240 ticks']) {
      expect(screen.getByRole('radio', { name: label })).toBeVisible();
    }
    expect(screen.getByRole('radio', { name: '120 ticks' })).toBeChecked();
  });

  it('reports the window the reader picked', () => {
    const onWindowSizeChange = vi.fn();
    render(
      <QuoteSparkline
        ticks={ring(5)}
        windowSize={120}
        onWindowSizeChange={onWindowSizeChange}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: '30 ticks' }));

    expect(onWindowSizeChange).toHaveBeenCalledWith(30);
  });

  it('charts only the newest ticks of the chosen window', () => {
    render(
      <QuoteSparkline
        ticks={ring(100)}
        windowSize={30}
        onWindowSizeChange={vi.fn()}
      />,
    );

    expect(
      document.querySelector('polyline')?.getAttribute('points')?.split(' '),
    ).toHaveLength(30);
    // Prices 370..399 are the last thirty of the hundred collected.
    expect(screen.getByText(/high 399, low 370/)).toBeVisible();
  });

  // The ring only ever holds what the stream has actually pushed, so a wide
  // window must say how much of itself is filled rather than claim the width.
  it('says how much of a not-yet-filled window has been collected', () => {
    render(
      <QuoteSparkline
        ticks={ring(47)}
        windowSize={240}
        onWindowSizeChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/47 of 240 ticks so far/)).toBeVisible();
    expect(screen.queryByText(/Last 240 ticks/)).not.toBeInTheDocument();
  });

  it('states the plain count once the window is full', () => {
    render(
      <QuoteSparkline
        ticks={ring(SPARKLINE_CAP)}
        windowSize={30}
        onWindowSizeChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Last 30 ticks/)).toBeVisible();
    expect(screen.queryByText(/so far/)).not.toBeInTheDocument();
  });

  it('keeps the control on screen while the chart is still collecting', () => {
    render(
      <QuoteSparkline
        ticks={ring(1)}
        windowSize={120}
        onWindowSizeChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Collecting chart data…')).toBeVisible();
    expect(screen.getByRole('radio', { name: '30 ticks' })).toBeVisible();
  });
});
