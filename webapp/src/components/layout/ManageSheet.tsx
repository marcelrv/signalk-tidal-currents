import { useEffect, useMemo, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { timeAgo, formatBytes } from '../../lib/format';
import { Modal } from '../shared/Modal';
import { Icon } from '../shared/Icon';
import { DeleteDatasetButton } from '../shared/DeleteDatasetButton';
import { StorageGauge } from '../storage/StorageGauge';
import { SmartCleanupPanel } from '../storage/SmartCleanupPanel';
import { PriorityStack } from '../priority/PriorityStack';
import { PriorityList } from '../priority/PriorityList';

/**
 * "Storage & data" sheet — all the management chrome that used to crowd the
 * main screen (disk gauge, cleanup, catalog sync, priorities) lives here
 * behind one footer button, leaving the browsing surface to the actual
 * catalog. Sections top-to-bottom mirror how often they're needed:
 * storage/cleanup, per-dataset priority (Phase 3), fallback type order,
 * unmanaged files.
 */
export function ManageSheet({ onClose }: { onClose: () => void }) {
  const catalog = useAppStore((s) => s.catalog);
  const catalogLoading = useAppStore((s) => s.catalogLoading);
  const refreshCatalog = useAppStore((s) => s.refreshCatalog);
  const fetchPriority = useAppStore((s) => s.fetchPriority);
  const datasets = useAppStore((s) => s.datasets);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  useEffect(() => {
    fetchPriority();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const orphans = useMemo(() => datasets.filter((d) => d.id.startsWith('orphan:')), [datasets]);

  return (
    <Modal title="Storage & data" onClose={onClose}>
      <div className="flex flex-col gap-5 pt-1">
        <section aria-label="Storage" className="flex flex-col gap-2.5">
          <StorageGauge />
          <button
            type="button"
            onClick={() => setCleanupOpen(true)}
            className="flex min-h-11 items-center gap-2 self-start rounded-full bg-surface-2 px-4 text-sm font-medium text-accent"
          >
            <Icon name="trash" className="h-4 w-4" />
            Smart cleanup…
          </button>
        </section>

        <section aria-label="Catalog" className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
          <div className="min-w-0 text-sm">
            <div className="font-medium">Catalog</div>
            <div className="truncate text-xs text-muted">
              {catalog?.error ? `${catalog.error} · ` : ''}
              synced {catalog?.fetchedAt ? timeAgo(catalog.fetchedAt) : 'never'}
            </div>
          </div>
          <button
            type="button"
            disabled={catalogLoading}
            onClick={() => refreshCatalog()}
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-surface-2 px-4 text-sm font-medium text-accent disabled:opacity-50"
          >
            <Icon name="refresh" className={`h-4 w-4 ${catalogLoading ? 'motion-safe:animate-spin' : ''}`} />
            {catalogLoading ? 'Syncing…' : 'Sync now'}
          </button>
        </section>

        <section aria-label="Data priority" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Data priority</h3>
          <PriorityStack onSelected={onClose} />
        </section>

        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <Icon name="chevronRight" className="h-4 w-4 text-muted transition-transform group-open:rotate-90" />
            Fallback order for new or unlisted data
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-muted">
              Applies per data TYPE, to anything not ranked above (fresh downloads, files added by hand).
            </p>
            <PriorityList />
          </div>
        </details>

        {orphans.length > 0 && (
          <section aria-label="Unmanaged files" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Unmanaged files</h3>
            <p className="text-xs text-muted">Found in the data directories but not installed via the catalog.</p>
            <ul className="flex flex-col gap-1.5">
              {orphans.map((d) => (
                <li key={d.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-1">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{d.name}</span>
                    <span className="block text-xs text-muted tabular-nums">{formatBytes(d.sizeBytes)}</span>
                  </span>
                  <DeleteDatasetButton id={d.id} name={d.name} sizeBytes={d.sizeBytes} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {cleanupOpen && <SmartCleanupPanel onClose={() => setCleanupOpen(false)} />}
    </Modal>
  );
}
