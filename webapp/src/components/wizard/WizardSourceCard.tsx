import { SourceRow } from '../../lib/sources';
import { formatBytes } from '../../lib/format';

const TYPE_BADGE: Record<SourceRow['source']['type'], string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

export function WizardSourceCard({
  row,
  checked,
  onToggle,
}: {
  row: SourceRow;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border p-3">
      <input type="checkbox" checked={checked} onChange={onToggle} className="h-5 w-5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted">{TYPE_BADGE[row.source.type]}</span>
          {row.name}
        </div>
        <div className="truncate text-sm text-muted">{row.regionName}</div>
      </div>
      <span className="text-sm text-muted">{row.sizeBytes === null ? '~size unknown' : formatBytes(row.sizeBytes)}</span>
    </label>
  );
}
