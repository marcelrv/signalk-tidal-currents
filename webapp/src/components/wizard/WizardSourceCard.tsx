import { CatalogSource } from '../../api/types';
import { totalSizeBytes } from '../../lib/sources';
import { formatBytes } from '../../lib/format';

const TYPE_BADGE: Record<CatalogSource['type'], string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

export function WizardSourceCard({
  source,
  checked,
  onToggle,
}: {
  source: CatalogSource;
  checked: boolean;
  onToggle: () => void;
}) {
  const size = totalSizeBytes(source);
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded border border-muted/30 p-3">
      <input type="checkbox" checked={checked} onChange={onToggle} className="h-5 w-5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          <span className="rounded bg-muted/20 px-1.5 py-0.5 text-xs text-muted">{TYPE_BADGE[source.type]}</span>
          {source.name}
        </div>
        <div className="truncate text-sm text-muted">{source.region.name}</div>
      </div>
      <span className="text-sm text-muted">{size === null ? '~size unknown (forecast data)' : formatBytes(size)}</span>
    </label>
  );
}
