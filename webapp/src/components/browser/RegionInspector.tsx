import { useAppStore } from '../../store/useAppStore';
import { SourceRow, datasetForRow } from '../../lib/sources';
import { Modal } from '../shared/Modal';
import { SourceListRow } from './SourceListRow';

/**
 * Opens when tapping a map polygon (PRD §5.1): lists every dataset covering
 * that point — overlapping polygons (e.g. a global coarse model under a
 * high-res coastal one) all show up here rather than only the top one.
 * Each row's `onSelected={onClose}` closes THIS modal when picked, so
 * selecting a row opens the Detail modal instead of stacking on top of this
 * one (they'd otherwise visually mix).
 */
export function RegionInspector({ rows, onClose }: { rows: SourceRow[]; onClose: () => void }) {
  const datasets = useAppStore((s) => s.datasets);
  return (
    <Modal title={`${rows.length} dataset${rows.length === 1 ? '' : 's'} cover this area`} onClose={onClose}>
      <ul>
        {rows.map((row) => (
          <SourceListRow key={row.key} row={row} dataset={datasetForRow(datasets, row)} onSelected={onClose} />
        ))}
      </ul>
    </Modal>
  );
}
