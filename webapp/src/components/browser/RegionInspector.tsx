import { useAppStore } from '../../store/useAppStore';
import { CatalogSource } from '../../api/types';
import { datasetForSource } from '../../lib/sources';
import { Modal } from '../shared/Modal';
import { SourceListRow } from './SourceListRow';

/**
 * Opens when tapping a map polygon (PRD §5.1): lists every dataset covering
 * that point — overlapping polygons (e.g. a global coarse model under a
 * high-res coastal one) all show up here rather than only the top one.
 */
export function RegionInspector({ sources, onClose }: { sources: CatalogSource[]; onClose: () => void }) {
  const datasets = useAppStore((s) => s.datasets);
  return (
    <Modal title={`${sources.length} dataset${sources.length === 1 ? '' : 's'} cover this area`} onClose={onClose}>
      <ul>
        {sources.map((source) => (
          <SourceListRow key={source.id} source={source} dataset={datasetForSource(datasets, source.id)} />
        ))}
      </ul>
    </Modal>
  );
}
