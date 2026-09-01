import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_VISIBLE_TOASTS,
  TOAST_LIFETIME_MS,
  ToastRegion,
  useToastQueue,
} from './toast-region';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOTHING: readonly [string, string][] = [];

/** The region and the queue as the app wires them, plus a control to focus. */
function Harness({
  pushes = NOTHING,
}: {
  pushes?: readonly [string, string][];
}) {
  const { toasts, push, dismiss } = useToastQueue();
  // Both dependencies are stable, so this seeds the queue once — the way an
  // arriving fill would, from outside the render.
  useEffect(() => {
    for (const [id, text] of pushes) push(id, text);
  }, [pushes, push]);
  return (
    <>
      <button type="button">elsewhere</button>
      <ToastRegion
        label="Fill notifications"
        dismissLabel="Close"
        toasts={toasts}
        onDismiss={dismiss}
      />
    </>
  );
}

describe('ToastRegion', () => {
  it('mounts the live region empty so a later addition is announced', () => {
    render(
      <ToastRegion
        label="Fill notifications"
        dismissLabel="Close"
        toasts={[]}
        onDismiss={() => {}}
      />,
    );
    const region = screen.getByRole('list', { name: 'Fill notifications' });
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-live', 'polite');
    // Atomic would re-read the whole stack on every arrival.
    expect(region).toHaveAttribute('aria-atomic', 'false');
    expect(region).toBeEmptyDOMElement();
  });

  it('shows a pushed toast and never moves focus to it', () => {
    render(<Harness pushes={[['f1', 'AAPL Buy 1 filled']]} />);
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    act(() => elsewhere.focus());
    expect(screen.getByText('AAPL Buy 1 filled')).toBeVisible();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('retires a toast once its lifetime is up', () => {
    render(<Harness pushes={[['f1', 'AAPL Buy 1 filled']]} />);
    expect(screen.getByText('AAPL Buy 1 filled')).toBeVisible();
    act(() => void vi.advanceTimersByTime(TOAST_LIFETIME_MS));
    expect(screen.queryByText('AAPL Buy 1 filled')).not.toBeInTheDocument();
  });

  it('keeps the newest and drops the oldest past the visible bound', () => {
    const pushes = Array.from(
      { length: MAX_VISIBLE_TOASTS + 1 },
      (_value, index) => [`f${index}`, `fill ${index}`] as [string, string],
    );
    render(<Harness pushes={pushes} />);
    expect(screen.queryByText('fill 0')).not.toBeInTheDocument();
    expect(screen.getByText(`fill ${MAX_VISIBLE_TOASTS}`)).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_VISIBLE_TOASTS);
  });

  it('dismisses one toast on request and leaves the rest', () => {
    render(
      <Harness
        pushes={[
          ['f1', 'fill one'],
          ['f2', 'fill two'],
        ]}
      />,
    );
    act(() => screen.getAllByRole('button', { name: 'Close' })[0]?.click());
    expect(screen.queryByText('fill one')).not.toBeInTheDocument();
    expect(screen.getByText('fill two')).toBeVisible();
  });
});

describe('useToastQueue', () => {
  it('ignores a repeat of an id already on screen', () => {
    const { result } = renderHook(() => useToastQueue());
    act(() => result.current.push('f1', 'fill one'));
    act(() => result.current.push('f1', 'fill one again'));
    expect(result.current.toasts).toEqual([{ id: 'f1', text: 'fill one' }]);
  });

  it('clears its timers when the caller unmounts', () => {
    const { result, unmount } = renderHook(() => useToastQueue());
    act(() => result.current.push('f1', 'fill one'));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
