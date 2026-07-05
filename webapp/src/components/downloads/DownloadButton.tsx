import { useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { usePolling } from '../../hooks/usePolling';
import { CatalogSource } from '../../api/types';
import { DisplayStatus, totalSizeBytes } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { Modal } from '../shared/Modal';

const LABELS: Record<DisplayStatus, string> = {
  active: '✓ Installed',
  'update-available': 'Update',
  'not-installed': 'Download',
  error: 'Retry',
};

/** 1-click download with progress (PRD §5.1): row/card button → downloading (progress %) → done. */
export function DownloadButton({ source, status }: { source: CatalogSource; status: DisplayStatus }) {
  const startDownload = useAppStore((s) => s.startDownload);
  const pollDownload = useAppStore((s) => s.pollDownload);
  const downloads = useAppStore((s) => s.downloads);
  const storage = useAppStore((s) => s.storage);
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirmingOverfull, setConfirmingOverfull] = useState(false);
  const job = jobId ? downloads[jobId] : undefined;
  const active = job && (job.state === 'queued' || job.state === 'active');

  usePolling(
    () => {
      if (jobId) pollDownload(jobId);
    },
    active ? 800 : null,
  );

  const begin = async () => {
    const id = await startDownload(source.id);
    setJobId(id);
  };

  const handleClick = () => {
    // Pre-download check (PRD §5.4): warn before a download would push the
    // disk past 90% full.
    const size = totalSizeBytes(source);
    if (size !== null && storage?.totalBytes && storage.freeBytes !== null) {
      const usedAfter = storage.totalBytes - storage.freeBytes + size;
      if (usedAfter / storage.totalBytes > 0.9) {
        setConfirmingOverfull(true);
        return;
      }
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
    <>
      <button
        type="button"
        className="min-h-11 min-w-11 rounded border border-accent px-3 text-sm font-medium text-accent hover:bg-accent/10"
        onClick={handleClick}
        disabled={status === 'active'}
      >
        {LABELS[status]}
      </button>
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
    </>
  );
}
