import { useMemo, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { hasUnknownSizeRisk, rowForDataset, rowsForSources, totalSizeBytes, wouldExceedDiskThreshold } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { Modal } from '../shared/Modal';

/**
 * "Update All" banner (PRD §5.5): "3 regions have new data · [Update All (45
 * MB)]" — the headline glance at what's stale. Built on the store's
 * jobIdBySource tracking (see useDownloadProgress) so each row's own
 * DownloadButton picks up progress for a job started here, not by itself.
 */
export function UpdateAllBanner() {
  const catalog = useAppStore((s) => s.catalog);
  const datasets = useAppStore((s) => s.datasets);
  const storage = useAppStore((s) => s.storage);
  const startDownload = useAppStore((s) => s.startDownload);
  const [confirmingOverfull, setConfirmingOverfull] = useState(false);
  const [starting, setStarting] = useState(false);

  const updatable = useMemo(() => {
    const sources = catalog?.document?.sources ?? [];
    const rows = rowsForSources(sources);
    return datasets
      .filter((d) => d.status === 'update-available' && d.catalogSourceId)
      .map((d) => ({ dataset: d, source: sources.find((s) => s.id === d.catalogSourceId), row: rowForDataset(rows, d) }))
      .filter((u) => u.source);
  }, [catalog, datasets]);

  if (updatable.length === 0) return null;

  let knownTotal = 0;
  let unknownCount = 0;
  for (const { source } of updatable) {
    const size = totalSizeBytes(source!);
    if (size === null) unknownCount++;
    else knownTotal += size;
  }

  const begin = async () => {
    setStarting(true);
    try {
      await Promise.all(
        updatable.map(({ dataset }) =>
          startDownload(dataset.catalogSourceId!, dataset.regionId ? { region_id: dataset.regionId, type: dataset.fileType } : undefined),
        ),
      );
    } finally {
      setStarting(false);
    }
  };

  // Unknown-size (template/forecast) entries are excluded from knownTotal
  // entirely, so wouldExceedDiskThreshold alone can silently pass even when
  // the disk is already fairly full and several unknown-size cycle files are
  // about to be re-downloaded — flag that case explicitly instead.
  const unknownSizeRisk = unknownCount > 0 && hasUnknownSizeRisk(null, storage);

  const handleClick = () => {
    if (wouldExceedDiskThreshold(knownTotal, storage) || unknownSizeRisk) {
      setConfirmingOverfull(true);
      return;
    }
    begin();
  };

  const sizeLabel = `${formatBytes(knownTotal)}${unknownCount > 0 ? ` + ${unknownCount} unknown size` : ''}`;

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-warn/30 bg-warn/10 px-3 py-1.5">
      <details className="min-w-0 text-sm">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-warn motion-safe:animate-pulse" />
          <span className="font-medium">
            {updatable.length} region{updatable.length === 1 ? '' : 's'} ha{updatable.length === 1 ? 's' : 've'} new data
          </span>
        </summary>
        <ul className="mb-2 mt-1 list-inside list-disc text-xs text-muted">
          {updatable.map(({ dataset, source, row }) => (
            <li key={dataset.id}>
              {row?.name ?? source!.name}
              {row?.sizeBytes != null ? ` — ${formatBytes(row.sizeBytes)}` : ' — size varies (forecast cycle)'}
            </li>
          ))}
        </ul>
      </details>
      <button
        type="button"
        disabled={starting}
        onClick={handleClick}
        className="min-h-9 shrink-0 rounded-full bg-warn px-3.5 text-xs font-semibold text-bg disabled:opacity-50"
      >
        {starting ? 'Starting…' : `Update all · ${sizeLabel}`}
      </button>
      {confirmingOverfull && (
        <Modal title="Disk almost full" onClose={() => setConfirmingOverfull(false)}>
          <p className="mb-2 text-muted">
            Updating all {updatable.length} region(s) (~{formatBytes(knownTotal)}
            {unknownCount > 0 ? ` + ${unknownCount} of unknown size` : ''}) would push this disk past 90% full
            {unknownSizeRisk ? ' — and some of these are forecast cycle files whose size can\'t be known ahead of time' : ''}.
            Continue anyway?
          </p>
          <ul className="mb-4 list-inside list-disc text-xs text-muted">
            {updatable.map(({ dataset, source, row }) => (
              <li key={dataset.id}>{row?.name ?? source!.name}</li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmingOverfull(false)} className="min-h-11 rounded px-4 text-muted">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingOverfull(false);
                begin();
              }}
              className="min-h-11 rounded bg-accent px-4 font-medium text-surface"
            >
              Update anyway
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
