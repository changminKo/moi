import { useTranslation } from 'react-i18next';
import { useAppLocale } from '../../lib/i18n';
import {
  presentationForReason,
  useTradingStatus,
} from './system-status-provider';
export function SystemBanner({ onDismiss }: { onDismiss?: () => void }) {
  const { reasons, loading, error, retry } = useTradingStatus();
  const { t } = useTranslation();
  const locale = useAppLocale();
  if (loading || (!error && reasons.length === 0)) return null;
  return (
    <aside
      className="system-banner"
      role="status"
      aria-label={t('banner.systemStatusAria')}
    >
      <div>
        {error ??
          reasons
            .map((reason) => presentationForReason(reason, locale))
            .join(' · ')}
      </div>
      {error && (
        <button type="button" onClick={retry}>
          {t('common.retry')}
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss}>
          {t('common.dismiss')}
        </button>
      )}
    </aside>
  );
}
