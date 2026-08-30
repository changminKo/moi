import { useTranslation } from 'react-i18next';

export function ErrorNotice({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="error-notice">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss}>
          {t('common.dismiss')}
        </button>
      )}
    </div>
  );
}
