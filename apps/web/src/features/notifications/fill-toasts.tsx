import { type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type FillAnnouncement,
  fillToastMessage,
} from '../orders/fill-announcement';
import {
  PortfolioStreamProvider,
  type PortfolioStreamValue,
} from '../portfolio/portfolio-stream-provider';
import type { usePortfolioStream } from '../portfolio/use-portfolio-stream';
import { ToastRegion, useToastQueue } from './toast-region';

/**
 * The one notification this app has: a fill announced wherever the reader is.
 *
 * Acceptance and execution are two different pieces of news. Acceptance has a
 * home — the `role="status"` line beside the button that produced it — and
 * keeps it. A fill has none: it lands moments later, asynchronously, with the
 * reader possibly on the portfolio page, on another instrument, or half way
 * through typing the next order. That is what makes a toast the right shape
 * here and the wrong one there.
 */
export function FillToastProvider({
  children,
  ...stream
}: { children: ReactNode } & Parameters<typeof usePortfolioStream>[0]) {
  const { t } = useTranslation();
  const { toasts, push, dismiss } = useToastQueue();
  const announce = useCallback(
    (announcement: FillAnnouncement) => {
      const message = fillToastMessage(announcement);
      push(
        announcement.id,
        t(message.key, { ...message.values, side: t(message.sideKey) }),
      );
    },
    [push, t],
  );
  return (
    <PortfolioStreamProvider {...stream} onFill={announce}>
      {children}
      <ToastRegion
        label={t('fillToast.regionAria')}
        dismissLabel={t('common.close')}
        toasts={toasts}
        onDismiss={dismiss}
      />
    </PortfolioStreamProvider>
  );
}

export type { PortfolioStreamValue };
