import { useMemo, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { estimatedSizeBytes, hasUnknownSizeRisk, rowForDataset, rowsForSources, totalSizeBytes, wouldExceedDiskThreshold } from '../../lib/sources';
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
  const [error, setError] = useState<string | null>(null);

  const updatable = useMemo(() => {
    const sources = catalog?.document?.sources ?? [];
    const rows = rowsForSources(sources);
    return datasets
      .filter((d) => d.status === 'update-available' && d.catalogSourceId)
      .map((d) => ({ dataset: d, source: sources.find((s) => s.id === d.catalogSourceId), row: rowForDataset(rows, d) }))
      .filter((u) => u.source);
  }, [catalog, datasets]);

  if (updatable.length === 0) return null;

  // Every entry here is an ALREADY-INSTALLED dataset that's gone stale.
  // `estimatedSizeBytes` prefers the catalog's declared size (exact, for a
  // static file) and falls back to the previous download's real size only
  // when the catalog can't know ahead of time (forecast/nowcast template
  // sources) — the same estimate the backend auto-update sweep uses.
  let knownTotal = 0;
  let unknownCount = 0;
  for (const { dataset, source, row } of updatable) {
    const size = row ? estimatedSizeBytes(row, dataset) : dataset.sizeBytes > 0 ? dataset.sizeBytes : totalSizeBytes(source!);
    if (size === null) unknownCount++;
    else knownTotal += size;
  }

  const begin = async () => {
    setStarting(true);
    setError(null);
    try {
      // allSettled, not all — one rejected startDownload (e.g. a stale
      // selector) must not hide that the rest still started, and must not
      // silently vanish the way a bare try/finally with no catch would.
      const results = await Promise.allSettled(
        updatable.map(({ dataset }) =>
          startDownload(dataset.catalogSourceId!, dataset.regionId ? { region_id: dataset.regionId, type: dataset.fileType, variant: dataset.variant } : undefined),
        ),
      );
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length > 0) {
        const reasons = failures.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join('; ');
        setError(`${failures.length} of ${updatable.length} update${updatable.length === 1 ? '' : 's'} failed to start: ${reasons}`);
      }
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

  // "~" because forecast re-downloads are estimated from the prior cycle's
  // size — the new cycle's bytes aren't known until fetched.
  const sizeLabel = `~${formatBytes(knownTotal)}${unknownCount > 0 ? ` + ${unknownCount} unknown` : ''}`;

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
          {updatable.map(({ dataset, source, row }) => {
            const size = row ? estimatedSizeBytes(row, dataset) : dataset.sizeBytes > 0 ? dataset.sizeBytes : totalSizeBytes(source!);
            return (
              <li key={dataset.id}>
                {row?.name ?? source!.name}
                {size !== null ? ` — ${formatBytes(size)}` : ' — size varies (forecast cycle)'}
              </li>
            );
          })}
        </ul>
      </details>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <button
          type="button"
          disabled={starting}
          onClick={handleClick}
          className="min-h-9 shrink-0 rounded-full bg-warn px-3.5 text-xs font-semibold text-bg disabled:opacity-50"
        >
          {starting ? 'Starting…' : `Update all · ${sizeLabel}`}
        </button>
        {error && (
          <span role="alert" className="max-w-[16rem] text-right text-xs text-danger">
            {error}
          </span>
        )}
      </div>
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
