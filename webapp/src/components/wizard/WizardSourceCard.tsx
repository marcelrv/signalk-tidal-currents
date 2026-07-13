import { DatasetEntry } from '../../api/types';
import { SourceRow, estimatedSizeBytes } from '../../lib/sources';
import { formatBytes } from '../../lib/format';

const TYPE_BADGE: Record<SourceRow['source']['type'], string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

export function WizardSourceCard({
  row,
  dataset,
  checked,
  onToggle,
  recommended,
}: {
  row: SourceRow;
  dataset: DatasetEntry | null;
  checked: boolean;
  onToggle: () => void;
  recommended?: boolean;
}) {
  const isInstalled = dataset && dataset.status !== 'error';
  const displaySize = estimatedSizeBytes(row, dataset ?? undefined);

  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border p-3">
      {isInstalled ? (
        <span className="flex h-5 w-5 items-center justify-center text-green-500">&#10003;</span>
      ) : (
        <input type="checkbox" checked={checked} onChange={onToggle} className="h-5 w-5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted">{TYPE_BADGE[row.source.type]}</span>
          {recommended && !isInstalled && (
            <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent">Recommended</span>
          )}
          {row.name}
          {isInstalled && <span className="text-xs text-green-500">active</span>}
        </div>
        <div className="truncate text-sm text-muted">{row.regionName}</div>
      </div>
      <span className="text-sm text-muted">{displaySize === null ? '~size unknown' : formatBytes(displaySize)}</span>
    </label>
  );
}
