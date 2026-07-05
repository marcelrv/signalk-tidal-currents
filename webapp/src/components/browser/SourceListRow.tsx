import { useAppStore } from '../../store/useAppStore';
import { DatasetEntry } from '../../api/types';
import { SourceRow, displayStatus } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { StatusBadge } from '../shared/StatusBadge';
import { ExpiryCountdown } from '../shared/ExpiryCountdown';
import { DownloadButton } from '../downloads/DownloadButton';

const TYPE_BADGE: Record<SourceRow['source']['type'], string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

/**
 * `onSelected` fires in addition to the store's own select() — used by
 * RegionInspector to close itself when a row inside it is picked, so
 * selecting a row there doesn't leave the Inspector modal open underneath
 * the Detail modal (they'd otherwise visually stack/mix).
 */
export function SourceListRow({
  row,
  dataset,
  onSelected,
}: {
  row: SourceRow;
  dataset: DatasetEntry | undefined;
  onSelected?: () => void;
}) {
  const select = useAppStore((s) => s.select);
  const selected = useAppStore((s) => s.selection.key === row.key);
  const status = displayStatus(dataset);

  return (
    <li
      className={`flex min-h-11 flex-wrap items-center gap-3 border-b border-muted/20 px-3 py-3 ${selected ? 'bg-accent/5' : ''}`}
      aria-current={selected || undefined}
    >
      <button
        type="button"
        onClick={() => {
          select(row.key);
          onSelected?.();
        }}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="flex items-center gap-2 font-medium">
          <span className="rounded bg-muted/20 px-1.5 py-0.5 text-xs text-muted">{TYPE_BADGE[row.source.type]}</span>
          {row.name}
        </span>
        <span className="truncate text-sm text-muted">{row.regionName}</span>
      </button>
      <span className="text-sm text-muted" title={row.sizeBytes === null ? 'Forecast/nowcast cycle file — size varies, not known until downloaded' : undefined}>
        {row.sizeBytes === null ? 'size varies' : formatBytes(row.sizeBytes)}
      </span>
      <StatusBadge status={status} />
      {dataset && <ExpiryCountdown dataset={dataset} />}
      <DownloadButton source={row.source} regionId={row.regionId} fileType={row.fileType} status={status} />
    </li>
  );
}
