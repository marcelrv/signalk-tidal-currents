import { useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { formatBytes } from '../../lib/format';
import { Modal } from './Modal';
import { Icon } from './Icon';

/**
 * Trash-icon button + confirm dialog for removing an installed dataset or an
 * unmanaged (orphan) file — deletion is the one destructive action in this
 * app, so it always confirms, showing what will be freed. Reused by list
 * rows, the priority stack cards, and the unmanaged-files list.
 */
export function DeleteDatasetButton({ id, name, sizeBytes }: { id: string; name: string; sizeBytes: number }) {
  const deleteDataset = useAppStore((s) => s.deleteDataset);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteDataset(id);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={`Delete ${name}`}
        title={`Delete ${name}`}
        onClick={() => setConfirming(true)}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-danger/10 hover:text-danger"
      >
        <Icon name="trash" className="h-4.5 w-4.5" />
      </button>
      {confirming && (
        <Modal title="Delete dataset" onClose={() => setConfirming(false)}>
          <p className="mb-4 text-sm text-muted">
            Remove <span className="font-medium text-fg">{name}</span> from this device? Frees {formatBytes(sizeBytes)}. You
            can download it again from the catalog at any time.
          </p>
          {error && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={remove}
              className="min-h-11 rounded-full bg-danger px-4 text-sm font-medium text-bg disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
