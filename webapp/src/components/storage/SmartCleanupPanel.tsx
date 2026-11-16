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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    // A failed read must not masquerade as "nothing to clean up".
    fetchCleanupCandidates().catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [fetchCleanupCandidates]); // zustand actions are stable, so this still runs once

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const allSelected = candidates.length > 0 && candidates.every((c) => selected.has(c.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.id)));

  // Only what is currently displayed counts: a candidate that vanished after a
  // refresh must neither be deleted nor inflate the count/size.
  const selectedCandidates = candidates.filter((c) => selected.has(c.id));
  const freeableBytes = selectedCandidates.reduce((sum, c) => sum + c.sizeBytes, 0);

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      for (const id of new Set(selectedCandidates.map((c) => c.id))) await deleteDataset(id);
      await Promise.all([fetchStorage(), fetchCleanupCandidates(maxDistanceNm)]);
      setSelected(new Set());
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      // Some deletes may have gone through: re-read so the list shows what is left.
      fetchCleanupCandidates(maxDistanceNm).catch(() => undefined);
      fetchStorage().catch(() => undefined);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal title="Smart Cleanup" onClose={onClose}>
      {loadError ? (
        <p role="alert" className="text-sm text-danger">Couldn't load cleanup candidates: {loadError}</p>
      ) : !vesselPosition ? (
        <p className="text-muted">Enable a vessel position fix to use Smart Cleanup.</p>
      ) : candidates.length === 0 ? (
        <p className="text-muted">Nothing to clean up — everything installed is within {maxDistanceNm} nm.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Datasets farther than {maxDistanceNm} nm from the vessel — safe to remove for now:
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted">
              {selectedCandidates.length} of {candidates.length} selected
            </span>
            <button
              type="button"
              onClick={toggleAll}
              disabled={deleting}
              className="min-h-11 rounded-full px-3 text-sm font-medium text-accent disabled:opacity-50"
            >
              {allSelected ? 'Select none' : 'Select all'}
            </button>
          </div>
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border p-3">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} disabled={deleting} className="h-5 w-5" />
                  <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                  <span className="text-sm text-muted">{c.distanceNm !== null ? `${Math.round(c.distanceNm)} nm` : 'unknown location'}</span>
                  <span className="text-sm text-muted">{formatBytes(c.sizeBytes)}</span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={selectedCandidates.length === 0 || deleting}
            onClick={() => void confirmDelete()} // reports its own errors via setDeleteError
            className="min-h-11 rounded-full bg-accent px-4 text-sm font-medium text-bg disabled:opacity-50"
          >
            {deleting ? 'Removing…' : `Free ~${formatBytes(freeableBytes)}`}
          </button>
          {deleteError && (
            <p role="alert" className="text-sm text-danger">
              Cleanup failed: {deleteError}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
