import { useAppStore } from '../../store/useAppStore';
import { CatalogSource, DatasetEntry } from '../../api/types';
import { displayStatus, totalSizeBytes } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { StatusBadge } from '../shared/StatusBadge';
import { DownloadButton } from '../downloads/DownloadButton';

const TYPE_BADGE: Record<CatalogSource['type'], string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

export function SourceListRow({ source, dataset }: { source: CatalogSource; dataset: DatasetEntry | undefined }) {
  const select = useAppStore((s) => s.select);
  const selected = useAppStore((s) => s.selection.sourceId === source.id);
  const status = displayStatus(dataset);

  return (
    <li
      className={`flex min-h-11 flex-wrap items-center gap-3 border-b border-muted/20 px-3 py-3 ${selected ? 'bg-accent/5' : ''}`}
      aria-current={selected || undefined}
    >
      <button
        type="button"
        onClick={() => select(source.id)}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="flex items-center gap-2 font-medium">
          <span className="rounded bg-muted/20 px-1.5 py-0.5 text-xs text-muted">{TYPE_BADGE[source.type]}</span>
          {source.name}
        </span>
        <span className="truncate text-sm text-muted">{source.region.name}</span>
      </button>
      <span className="text-sm text-muted">{formatBytes(totalSizeBytes(source))}</span>
      <StatusBadge status={status} />
      <DownloadButton source={source} status={status} />
    </li>
  );
}
