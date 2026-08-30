import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppLocale } from '../../lib/i18n';
import {
  presentationForReason,
  useTradingStatus,
} from './system-status-provider';
export function CapabilityGuard({
  action,
  children,
}: {
  action: 'place' | 'cancel' | 'fx';
  children: ReactNode;
}) {
  const { availability } = useTradingStatus();
  const { t } = useTranslation();
  const locale = useAppLocale();
  const capability = availability[action];
  if (capability.enabled) return <>{children}</>;
  return (
    <p role="status">
      {capability.reasons
        .map((reason) => presentationForReason(reason, locale))
        .join(' · ') || t('guard.unavailable')}
    </p>
  );
}
