import { READ_ONLY_HINT, useAppStore, useReadOnly } from '../../store/useAppStore';
import { DatasetEntry } from '../../api/types';

/**
 * "Keep fresh when online" per-dataset opt-in (PRD §5.5 Phase 2) — only
 * meaningful once a dataset is actually installed (an orphan or a
 * not-yet-downloaded row has nothing for the backend's periodic sweep to
 * re-download against).
 */
export function AutoUpdateToggle({ dataset }: { dataset: DatasetEntry }) {
  const setAutoUpdate = useAppStore((s) => s.setAutoUpdate);
  const readOnly = useReadOnly();
  if (!dataset.catalogSourceId) return null;
  // The checkbox is controlled by server state: on failure it simply stays as it was.
  const toggle = (enabled: boolean) => {
    setAutoUpdate(dataset.id, enabled).catch(() => undefined);
  };

  return (
    <label className="flex min-h-11 items-center gap-1.5 text-xs text-muted" title={readOnly ? READ_ONLY_HINT : undefined}>
      <input
        type="checkbox"
        checked={dataset.autoUpdate}
        disabled={readOnly}
        onChange={(e) => toggle(e.target.checked)}
        className="h-4 w-4"
      />
      Keep fresh
    </label>
  );
}
