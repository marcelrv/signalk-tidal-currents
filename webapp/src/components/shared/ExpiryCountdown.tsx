import { DatasetEntry } from '../../api/types';
import { expiryTier, formatCountdown } from '../../lib/expiry';

/**
 * Renders nothing for non-expiry-method datasets (UTCEF/harmonic — no
 * layout noise on rows that don't have a countdown at all). Same
 * pulsing + reduced-motion pattern as StatusBadge's update-available dot;
 * past-expiry is a solid indicator, not pulsing, matching the status
 * vocabulary's "🔴 Error" being a static state.
 */
export function ExpiryCountdown({ dataset }: { dataset: DatasetEntry }) {
  const tier = expiryTier(dataset);
  if (tier === null || dataset.remainingHours === undefined) return null;

  const text = formatCountdown(dataset.remainingHours);
  if (tier === 'ok') return <span className="text-xs text-muted">{text}</span>;
  if (tier === 'warning') {
    return <span className="text-xs font-medium text-warn motion-safe:animate-pulse">{text}</span>;
  }
  return <span className="text-xs font-medium text-danger">{text}</span>;
}
