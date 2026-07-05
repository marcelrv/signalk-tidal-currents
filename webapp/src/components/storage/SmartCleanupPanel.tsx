import { useEffect, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { formatBytes } from '../../lib/format';
import { Modal } from '../shared/Modal';

/**
 * Smart Cleanup (PRD §5.4 Phase 2): candidates farther than a distance
 * threshold from the vessel, safe to delete to free space. Designed empty
 * states (PRD §4) for the two distinct "nothing to show" cases — no
 * position fix vs. position known but everything's still in range.
 */
export function SmartCleanupPanel({ onClose }: { onClose: () => void }) {
  const candidates = useAppStore((s) => s.cleanupCandidates);
  const vesselPosition = useAppStore((s) => s.cleanupVesselPosition);
  const maxDistanceNm = useAppStore((s) => s.cleanupMaxDistanceNm);
  const fetchCleanupCandidates = useAppStore((s) => s.fetchCleanupCandidates);
  const deleteDataset = useAppStore((s) => s.deleteDataset);
  const fetchStorage = useAppStore((s) => s.fetchStorage);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchCleanupCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const freeableBytes = candidates.filter((c) => selected.has(c.id)).reduce((sum, c) => sum + c.sizeBytes, 0);

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      for (const id of selected) await deleteDataset(id);
      await Promise.all([fetchStorage(), fetchCleanupCandidates(maxDistanceNm)]);
      setSelected(new Set());
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal title="Smart Cleanup" onClose={onClose}>
      {!vesselPosition ? (
        <p className="text-muted">Enable a vessel position fix to use Smart Cleanup.</p>
      ) : candidates.length === 0 ? (
        <p className="text-muted">Nothing to clean up — everything installed is within {maxDistanceNm} nm.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Datasets farther than {maxDistanceNm} nm from the vessel — safe to remove for now:
          </p>
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded border border-muted/30 p-3">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="h-5 w-5" />
                  <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                  <span className="text-sm text-muted">{c.distanceNm !== null ? `${Math.round(c.distanceNm)} nm` : 'unknown location'}</span>
                  <span className="text-sm text-muted">{formatBytes(c.sizeBytes)}</span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={selected.size === 0 || deleting}
            onClick={confirmDelete}
            className="min-h-11 rounded bg-accent px-4 font-medium text-surface disabled:opacity-50"
          >
            {deleting ? 'Removing…' : `Free ~${formatBytes(freeableBytes)}`}
          </button>
        </div>
      )}
    </Modal>
  );
}
