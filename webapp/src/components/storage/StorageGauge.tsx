import { useAppStore } from '../../store/useAppStore';
import { formatBytes } from '../../lib/format';

/**
 * Disk gauge (PRD §5.4). `compact` is the always-visible footer form (tiny
 * bar + short figures); the full form lives in the Storage & data sheet and
 * adds the plugin's own share of the disk.
 */
export function StorageGauge({ compact }: { compact?: boolean }) {
  const storage = useAppStore((s) => s.storage);
  if (!storage) return null;

  const usedTotal = storage.totalBytes !== null && storage.freeBytes !== null ? storage.totalBytes - storage.freeBytes : null;
  const pct = usedTotal !== null && storage.totalBytes ? Math.min(100, Math.round((usedTotal / storage.totalBytes) * 100)) : null;
  const barColor = pct !== null && pct >= 90 ? 'bg-danger' : pct !== null && pct >= 75 ? 'bg-warn' : 'bg-accent';

  if (compact) {
    return (
      <div
        className="flex min-w-0 items-center gap-2 text-xs text-muted"
        title={`Plugin data uses ${formatBytes(storage.usedByPluginBytes)} of this volume`}
      >
        {pct !== null && (
          <span className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <span className={`block h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className="truncate tabular-nums">
          {usedTotal !== null && storage.totalBytes !== null
            ? `${formatBytes(usedTotal)} / ${formatBytes(storage.totalBytes)}`
            : formatBytes(storage.usedByPluginBytes)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {pct !== null && (
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="tabular-nums">
          {usedTotal !== null && storage.totalBytes !== null
            ? `${formatBytes(usedTotal)} used of ${formatBytes(storage.totalBytes)}`
            : 'Disk size unknown'}
        </span>
        <span className="text-xs text-muted tabular-nums">tidal data: {formatBytes(storage.usedByPluginBytes)}</span>
      </div>
    </div>
  );
}
