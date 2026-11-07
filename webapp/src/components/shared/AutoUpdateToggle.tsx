import { READ_ONLY_HINT, useAppStore, useReadOnly } from '../../store/useAppStore';
import { DatasetEntry } from '../../api/types';

/**
 * Per-dataset auto-download opt-out. Auto-download itself is one global
 * setting (Storage & data sheet); this only excludes a dataset from it, so
 * it is hidden while auto-download is Off — and for anything not actually
 * installed from the catalog (an orphan or not-yet-downloaded row has
 * nothing for the backend's sweep to re-download against).
 */
export function AutoUpdateToggle({ dataset }: { dataset: DatasetEntry }) {
  const setAutoUpdate = useAppStore((s) => s.setAutoUpdate);
  const autoDownloadOn = useAppStore((s) => (s.autoDownload?.intervalHours ?? 0) > 0);
  const readOnly = useReadOnly();
  if (!dataset.catalogSourceId || !autoDownloadOn) return null;

  return (
    <label className="flex min-h-11 items-center gap-1.5 text-xs text-muted" title={readOnly ? READ_ONLY_HINT : 'Include this dataset when auto-download runs'}>
      <input
        type="checkbox"
        checked={dataset.autoUpdate}
        disabled={readOnly}
        onChange={(e) => setAutoUpdate(dataset.id, e.target.checked)}
        className="h-4 w-4"
      />
      Auto-download
    </label>
  );
}
