import { useMemo } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { datasetForRow, displayStatus, rowsForSources } from '../../lib/sources';
import { Modal } from '../shared/Modal';
import { StatusBadge } from '../shared/StatusBadge';
import { ExpiryCountdown } from '../shared/ExpiryCountdown';
import { AutoUpdateToggle } from '../shared/AutoUpdateToggle';
import { DownloadButton } from '../downloads/DownloadButton';
import { AttributionPanel } from '../attribution/AttributionPanel';

/** Dataset detail — opened by selecting a row from the list or map. */
export function SourceDetailModal() {
  const catalog = useAppStore((s) => s.catalog);
  const datasets = useAppStore((s) => s.datasets);
  const key = useAppStore((s) => s.selection.key);
  const select = useAppStore((s) => s.select);

  const rows = useMemo(() => rowsForSources(catalog?.document?.sources ?? []), [catalog]);
  const row = rows.find((r) => r.key === key);
  if (!row) return null;
  const dataset = datasetForRow(datasets, row);
  const status = displayStatus(dataset);

  return (
    <Modal title={row.name} onClose={() => select(null)}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{row.source.description}</p>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={status} />
          {dataset && <ExpiryCountdown dataset={dataset} />}
          {dataset && <AutoUpdateToggle dataset={dataset} />}
          <DownloadButton source={row.source} regionId={row.regionId} fileType={row.fileType} status={status} />
        </div>
        <p className="text-sm text-muted">{row.regionName}</p>
        <div className="flex flex-wrap gap-1">
          {row.source.tags.map((t) => (
            <span key={t} className="rounded-full bg-muted/20 px-2 py-0.5 text-xs text-muted">
              {t}
            </span>
          ))}
        </div>
        <hr className="border-muted/20" />
        <AttributionPanel source={row.source} dataset={dataset} />
      </div>
    </Modal>
  );
}
