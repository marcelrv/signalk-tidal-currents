import { useAppStore } from '../../store/useAppStore';
import { DatasetEntry } from '../../api/types';
import { SourceRow, displayStatus, estimatedSizeBytes } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { StatusDot } from '../shared/StatusBadge';
import { ExpiryCountdown } from '../shared/ExpiryCountdown';
import { DeleteDatasetButton } from '../shared/DeleteDatasetButton';
import { DownloadButton } from '../downloads/DownloadButton';

const TYPE_BADGE: Record<SourceRow['source']['type'], string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

/**
 * Dense two-line row: status dot + name on top, a single muted meta line
 * (type · region · size · expiry) below — sized for a 7" helm display where
 * the old one-control-per-column layout wrapped into a 3-row blob per
 * dataset. Management extras (auto-update toggle, attribution) live in the
 * Detail modal, not on every row.
 *
 * `onSelected` fires in addition to the store's own select() — used by
 * RegionInspector to close itself when a row inside it is picked, so the
 * Inspector doesn't stay stacked under the Detail modal.
 *
 * `compact` drops the delete button (RegionInspector's job is picking WHICH
 * dataset to inspect, not managing files).
 */
export function SourceListRow({
  row,
  dataset,
  onSelected,
  compact,
}: {
  row: SourceRow;
  dataset: DatasetEntry | undefined;
  onSelected?: () => void;
  compact?: boolean;
}) {
  const select = useAppStore((s) => s.select);
  const selected = useAppStore((s) => s.selection.key === row.key);
  const status = displayStatus(dataset);
  const sizeBytes = estimatedSizeBytes(row, dataset);

  return (
    <li
      className={`flex items-center gap-1 rounded-xl px-1 py-0.5 ${selected ? 'bg-accent/10' : ''}`}
      aria-current={selected || undefined}
    >
      <button
        type="button"
        onClick={() => {
          select(row.key);
          onSelected?.();
        }}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left"
      >
        <StatusDot status={status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-tight">{row.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
            <span className="shrink-0 font-medium">{TYPE_BADGE[row.source.type]}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{row.regionName}</span>
            <span aria-hidden>·</span>
            <span
              className="shrink-0 tabular-nums"
              title={row.sizeBytes === null ? 'Forecast/nowcast cycle file — size varies, not known until downloaded' : undefined}
            >
              {sizeBytes === null ? 'size varies' : formatBytes(sizeBytes)}
            </span>
            {dataset && <ExpiryCountdown dataset={dataset} />}
          </span>
        </span>
      </button>
      {!compact && dataset && <DeleteDatasetButton id={dataset.id} name={row.name} sizeBytes={dataset.sizeBytes} />}
      <DownloadButton source={row.source} regionId={row.regionId} fileType={row.fileType} variant={row.variant} status={status} />
    </li>
  );
}
