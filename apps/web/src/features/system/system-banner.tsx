import {
  presentationForReason,
  useTradingStatus,
} from './system-status-provider';
export function SystemBanner({ onDismiss }: { onDismiss?: () => void }) {
  const { reasons, loading, error, retry } = useTradingStatus();
  if (loading || (!error && reasons.length === 0)) return null;
  return (
    <aside
      className="system-banner"
      role="status"
      aria-label="Trading system status"
    >
      <div>{error ?? reasons.map(presentationForReason).join(' · ')}</div>
      {error && (
        <button type="button" onClick={retry}>
          Retry
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </aside>
  );
}
