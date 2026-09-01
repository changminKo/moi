import { useCallback, useEffect, useRef, useState } from 'react';
import './toast-region.css';

/**
 * The smallest thing that can announce something the reader did not ask for.
 *
 * Deliberately not a notification framework: no variants, no severities, no
 * actions, no global singleton. One stack of short sentences, a lifetime and a
 * dismiss — enough for fills, and enough for the next caller that has news
 * with no home on screen, which is the only reason it is a module rather than
 * three hooks inside `fill-toasts.tsx`.
 *
 * Accessibility: the list is always mounted, empty included, because a live
 * region only announces content inserted into a region the screen reader was
 * already watching. `polite` and `aria-atomic="false"` so an arrival is read
 * once, after whatever the reader is already hearing, and does not re-read the
 * toasts beside it. Nothing here ever calls `focus()`: a fill is news, not an
 * interruption, and moving focus would throw a keyboard user out of the field
 * they were typing in.
 */

export type Toast = Readonly<{ id: string; text: string }>;

/**
 * Long enough to notice and read a short line while looking somewhere else,
 * short enough that a busy minute does not bury the screen.
 */
export const TOAST_LIFETIME_MS = 8_000;

/**
 * Newest wins. A fill that has waited behind a queue is no longer news, so
 * arrivals past this bound retire the oldest rather than waiting their turn.
 */
export const MAX_VISIBLE_TOASTS = 3;

export type ToastQueue = Readonly<{
  toasts: readonly Toast[];
  push: (id: string, text: string) => void;
  dismiss: (id: string) => void;
}>;

export function useToastQueue(
  lifetimeMs: number = TOAST_LIFETIME_MS,
): ToastQueue {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  // The ref is the authority and the state mirrors it, so several arrivals in
  // one tick compose without reading state React has not committed yet — and
  // so no timer is cleared from inside a state updater, which StrictMode
  // invokes twice.
  const list = useRef<readonly Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const commit = useCallback((next: readonly Toast[]) => {
    list.current = next;
    setToasts(next);
  }, []);
  const retire = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
  }, []);
  const dismiss = useCallback(
    (id: string) => {
      retire(id);
      commit(list.current.filter((toast) => toast.id !== id));
    },
    [commit, retire],
  );
  const push = useCallback(
    (id: string, text: string) => {
      // The same id twice is the same news: a replayed fill, or a re-render.
      if (timers.current.has(id)) return;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), lifetimeMs),
      );
      const next = [...list.current, { id, text }];
      const overflow = Math.max(0, next.length - MAX_VISIBLE_TOASTS);
      for (const evicted of next.slice(0, overflow)) retire(evicted.id);
      commit(next.slice(overflow));
    },
    [commit, dismiss, lifetimeMs, retire],
  );
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  return { toasts, push, dismiss };
}

export function ToastRegion({
  label,
  dismissLabel,
  toasts,
  onDismiss,
}: {
  label: string;
  dismissLabel: string;
  toasts: readonly Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <ol
      className="toast-region"
      aria-label={label}
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <li className="toast" key={toast.id}>
          <span className="toast-text">{toast.text}</span>
          <button
            className="toast-dismiss"
            type="button"
            aria-label={dismissLabel}
            onClick={() => onDismiss(toast.id)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
