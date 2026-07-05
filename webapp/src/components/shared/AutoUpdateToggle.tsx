import { useAppStore } from '../../store/useAppStore';
import { DatasetEntry } from '../../api/types';

/**
 * "Keep fresh when online" per-dataset opt-in (PRD §5.5 Phase 2) — only
 * meaningful once a dataset is actually installed (an orphan or a
 * not-yet-downloaded row has nothing for the backend's periodic sweep to
 * re-download against).
 */
export function AutoUpdateToggle({ dataset }: { dataset: DatasetEntry }) {
  const setAutoUpdate = useAppStore((s) => s.setAutoUpdate);
  if (!dataset.catalogSourceId) return null;

  return (
    <label className="flex min-h-11 items-center gap-1.5 text-xs text-muted">
      <input
        type="checkbox"
        checked={dataset.autoUpdate}
        onChange={(e) => setAutoUpdate(dataset.id, e.target.checked)}
        className="h-4 w-4"
      />
      Keep fresh
    </label>
  );
}
