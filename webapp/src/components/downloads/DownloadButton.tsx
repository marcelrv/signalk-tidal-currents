import { useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { usePolling } from '../../hooks/usePolling';
import { useDownloadProgress } from '../../hooks/useDownloadProgress';
import { CatalogSource } from '../../api/types';
import { DisplayStatus, downloadKeyFor, totalSizeBytes, wouldExceedDiskThreshold } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { Modal } from '../shared/Modal';

const LABELS: Record<DisplayStatus, string> = {
  active: '✓ Installed',
  'update-available': 'Update',
  'not-installed': 'Download',
  error: 'Retry',
};

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

  const handleClick = () => {
    if (wouldExceedDiskThreshold(totalSizeBytes(source), storage)) {
      setConfirmingOverfull(true);
      return;
    }
    begin();
  };

  if (active) {
    const pct = job.totalBytes ? Math.min(100, Math.round((job.bytes / job.totalBytes) * 100)) : null;
    return (
      <span className="min-h-11 min-w-11 inline-flex items-center justify-center rounded border border-muted/40 px-3 text-sm text-muted">
        {pct !== null ? `${pct}%` : formatBytes(job.bytes)}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="min-h-11 min-w-11 rounded border border-accent px-3 text-sm font-medium text-accent hover:bg-accent/10"
        onClick={handleClick}
        disabled={status === 'active'}
      >
        {LABELS[status]}
      </button>
      {error && (
        <span role="alert" className="max-w-[16rem] text-right text-xs text-danger">
          {error}
        </span>
      )}
      {confirmingOverfull && (
        <Modal title="Disk almost full" onClose={() => setConfirmingOverfull(false)}>
          <p className="mb-4 text-muted">
            Downloading {source.name} ({formatBytes(totalSizeBytes(source))}) would push this disk past 90% full.
            Continue anyway?
          </p>
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
              Download anyway
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
