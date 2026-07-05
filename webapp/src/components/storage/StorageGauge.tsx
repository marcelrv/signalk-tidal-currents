import { useAppStore } from '../../store/useAppStore';
import { formatBytes } from '../../lib/format';

/** Persistent, compact disk gauge (PRD §5.4): "3.2 GB used / 16 GB total" for the volume holding the data directories. */
export function StorageGauge() {
  const storage = useAppStore((s) => s.storage);
  if (!storage) return null;

  const usedTotal = storage.totalBytes !== null && storage.freeBytes !== null ? storage.totalBytes - storage.freeBytes : null;
  const pct = usedTotal !== null && storage.totalBytes ? Math.min(100, Math.round((usedTotal / storage.totalBytes) * 100)) : null;

  return (
    <div
      className="flex min-w-0 items-center gap-2 text-xs text-muted"
      title={`Plugin data uses ${formatBytes(storage.usedByPluginBytes)} of this volume`}
    >
      {pct !== null && (
        <span className="h-2 w-20 overflow-hidden rounded-full bg-muted/20" aria-hidden>
          <span
            className={`block h-full rounded-full ${pct >= 90 ? 'bg-danger' : 'bg-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
      <span>
        {usedTotal !== null && storage.totalBytes !== null
          ? `${formatBytes(usedTotal)} used / ${formatBytes(storage.totalBytes)} total`
          : `${formatBytes(storage.usedByPluginBytes)} used by plugin`}
      </span>
    </div>
  );
}
