import { DatasetEntry } from '../api/types';

export type ExpiryTier = 'ok' | 'warning' | 'expired';

/**
 * PRD §5.5: "GRIB expiry countdown on cards/rows: 'expires in 14h' → 🟡 at
 * <25% remaining → 🔴 when past." Returns null for non-expiry-method
 * datasets (UTCEF/harmonic, or a sha256-method grib install) — nothing to
 * show there.
 */
export function expiryTier(dataset: DatasetEntry): ExpiryTier | null {
  if (dataset.updateCheckMethod !== 'expiry' || dataset.remainingHours === undefined || !dataset.maxAgeHours) {
    return null;
  }
  if (dataset.remainingHours <= 0) return 'expired';
  if (dataset.remainingHours / dataset.maxAgeHours < 0.25) return 'warning';
  return 'ok';
}

function formatHours(hours: number): string {
  const abs = Math.abs(hours);
  if (abs < 48) return `${Math.round(abs)}h`;
  const days = Math.floor(abs / 24);
  const rem = Math.round(abs % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

/** "expires in 14h" / "expired 3h ago". */
export function formatCountdown(remainingHours: number): string {
  return remainingHours > 0 ? `expires in ${formatHours(remainingHours)}` : `expired ${formatHours(remainingHours)} ago`;
}
