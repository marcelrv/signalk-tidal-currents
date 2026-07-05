import { useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { usePolling } from '../../hooks/usePolling';
import { useDownloadProgress } from '../../hooks/useDownloadProgress';
import { CatalogSource } from '../../api/types';
import { DisplayStatus, downloadKeyFor, hasUnknownSizeRisk, totalSizeBytes, wouldExceedDiskThreshold } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { Modal } from '../shared/Modal';
import { Icon } from '../shared/Icon';

/** 1-click download with progress (PRD §5.1): row/card button → downloading (progress %) → done. Progress is pushed via SSE with a polling fallback (PRD §9 Phase 2) — the job may have been started elsewhere (e.g. the Update-All banner), not necessarily by this button instance. */
export function DownloadButton({
  source,
  regionId,
  fileType,
  status,
}: {
  source: CatalogSource;
  /** Present when this button represents one region of a multi-region source — passed through as the download selector. */
  regionId?: string;
  /** Present when that region has both a forecast and a nowcast file (real NOAA catalog shape) — region_id alone wouldn't uniquely select one. */
  fileType?: 'forecast' | 'nowcast';
  status: DisplayStatus;
}) {
  const startDownload = useAppStore((s) => s.startDownload);
  const pollDownload = useAppStore((s) => s.pollDownload);
  const downloads = useAppStore((s) => s.downloads);
  const storage = useAppStore((s) => s.storage);
  const jobId = useAppStore((s) => s.jobIdBySource[downloadKeyFor(source.id, regionId, fileType)]) ?? null;
  const [confirmingOverfull, setConfirmingOverfull] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = jobId ? downloads[jobId] : undefined;
  const active = job && (job.state === 'queued' || job.state === 'active');

  const fellBackToPolling = useDownloadProgress(active ? jobId : null);
  usePolling(
    () => {
      if (jobId) pollDownload(jobId);
    },
    active && fellBackToPolling ? 800 : null,
  );

  const begin = async () => {
    setError(null);
    try {
      await startDownload(source.id, regionId ? { region_id: regionId, type: fileType } : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sizeBytes = totalSizeBytes(source);
  const unknownSizeRisk = hasUnknownSizeRisk(sizeBytes, storage);

  const handleClick = () => {
    if (wouldExceedDiskThreshold(sizeBytes, storage) || unknownSizeRisk) {
      setConfirmingOverfull(true);
      return;
    }
    begin();
  };

  if (active) {
    const pct = job.totalBytes ? Math.min(100, Math.round((job.bytes / job.totalBytes) * 100)) : null;
    return (
      <span
        role="status"
        aria-label="Downloading"
        className="inline-flex min-h-9 min-w-14 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 px-2.5 text-xs font-medium text-accent tabular-nums motion-safe:animate-pulse"
      >
        {pct !== null ? `${pct}%` : formatBytes(job.bytes)}
      </span>
    );
  }

  if (status === 'active') {
    return (
      <span
        aria-label="Installed"
        title="Installed"
        className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center text-success"
      >
        <Icon name="check" className="h-4.5 w-4.5" />
      </span>
    );
  }

  const label = status === 'update-available' ? 'Update' : status === 'error' ? 'Retry' : 'Get';
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        aria-label={`${label} ${source.name}`}
        className={`flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold ${
          status === 'update-available'
            ? 'bg-warn/15 text-warn'
            : status === 'error'
              ? 'bg-danger/15 text-danger'
              : 'bg-accent text-bg'
        }`}
        onClick={handleClick}
      >
        <Icon name="download" className="h-3.5 w-3.5" />
        {label}
      </button>
      {error && (
        <span role="alert" className="max-w-[14rem] text-right text-xs text-danger">
          {error}
        </span>
      )}
      {confirmingOverfull && (
        <Modal title="Disk almost full" onClose={() => setConfirmingOverfull(false)}>
          <p className="mb-4 text-sm text-muted">
            {unknownSizeRisk
              ? `${source.name}'s download size can't be known ahead of time (forecast cycle file), and this disk is already over 75% full. Ensure you have enough free space before continuing.`
              : `Downloading ${source.name} (${formatBytes(sizeBytes)}) would push this disk past 90% full. Continue anyway?`}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmingOverfull(false)}
              className="min-h-11 rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingOverfull(false);
                begin();
              }}
              className="min-h-11 rounded-full bg-accent px-4 text-sm font-medium text-bg"
            >
              Download anyway
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
