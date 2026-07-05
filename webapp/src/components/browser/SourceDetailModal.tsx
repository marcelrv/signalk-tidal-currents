import { useAppStore } from '../../store/useAppStore';
import { datasetForSource, displayStatus } from '../../lib/sources';
import { Modal } from '../shared/Modal';
import { StatusBadge } from '../shared/StatusBadge';
import { DownloadButton } from '../downloads/DownloadButton';
import { AttributionPanel } from '../attribution/AttributionPanel';

/** Dataset detail — opened by selecting a source from the list or map. */
export function SourceDetailModal() {
  const catalog = useAppStore((s) => s.catalog);
  const datasets = useAppStore((s) => s.datasets);
  const sourceId = useAppStore((s) => s.selection.sourceId);
  const select = useAppStore((s) => s.select);

  const source = catalog?.document?.sources.find((s) => s.id === sourceId);
  if (!source) return null;
  const dataset = datasetForSource(datasets, source.id);
  const status = displayStatus(dataset);

  return (
    <Modal title={source.name} onClose={() => select(null)}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{source.description}</p>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={status} />
          <DownloadButton source={source} status={status} />
        </div>
        <p className="text-sm text-muted">{source.region.name}</p>
        <div className="flex flex-wrap gap-1">
          {source.tags.map((t) => (
            <span key={t} className="rounded-full bg-muted/20 px-2 py-0.5 text-xs text-muted">
              {t}
            </span>
          ))}
        </div>
        <hr className="border-muted/20" />
        <AttributionPanel source={source} dataset={dataset} />
      </div>
    </Modal>
  );
}
