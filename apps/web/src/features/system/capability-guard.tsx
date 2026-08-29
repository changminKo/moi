import type { ReactNode } from 'react';
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
  const capability = availability[action];
  if (capability.enabled) return <>{children}</>;
  return (
    <p role="status">
      {capability.reasons.map(presentationForReason).join(' · ') ||
        'Action unavailable'}
    </p>
  );
}
