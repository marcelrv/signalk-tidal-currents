import { useMemo } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { DatasetEntry } from '../../api/types';
import { datasetCoverageAreaSqDeg, rowForDataset, rowsForSources } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { Icon } from '../shared/Icon';
import { DeleteDatasetButton } from '../shared/DeleteDatasetButton';

const TYPE_BADGE: Record<DatasetEntry['type'], string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

/**
 * Per-dataset priority stack (PRD §5.3 Phase 3): every installed dataset as
 * a card, top wins wherever coverage overlaps — across source types.
 * Reordered via up/down arrow buttons (44 px targets), not drag-and-drop —
 * native HTML5 drag is desktop-mouse-only and would violate the touch-first
 * rule. "Auto-sort" ranks by coverage area ascending (small/high-res on
 * top); any manual move overrides it. Tapping a card opens its Detail card
 * (which highlights the region when returning to the map).
 */
export function PriorityStack({ onSelected }: { onSelected?: () => void }) {
  const datasets = useAppStore((s) => s.datasets);
  const priorityDatasets = useAppStore((s) => s.priorityDatasets);
  const setDatasetPriority = useAppStore((s) => s.setDatasetPriority);
  const catalog = useAppStore((s) => s.catalog);
  const select = useAppStore((s) => s.select);

  const sources = useMemo(() => catalog?.document?.sources ?? [], [catalog]);
  const rows = useMemo(() => rowsForSources(sources), [sources]);

  // The backend's resolved stack, joined with the local inventory; installs
  // that appeared since the last /priority fetch are appended so the list
  // always shows every manifest-tracked dataset exactly once.
  const stack = useMemo(() => {
    const manifestDatasets = datasets.filter((d) => !d.id.startsWith('orphan:'));
    const byId = new Map(manifestDatasets.map((d) => [d.id, d]));
    const ordered: DatasetEntry[] = [];
    for (const id of priorityDatasets) {
      const d = byId.get(id);
      if (!d) continue;
      ordered.push(d);
      byId.delete(id);
    }
    ordered.push(...byId.values());
    return ordered;
  }, [datasets, priorityDatasets]);

  if (stack.length === 0) {
    return <p className="py-2 text-sm text-muted">Nothing downloaded yet — priorities appear once datasets are installed.</p>;
  }

  const apply = (ordered: DatasetEntry[]) => setDatasetPriority(ordered.map((d) => d.id));

  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= stack.length) return;
    const next = [...stack];
    [next[index], next[j]] = [next[j], next[index]];
    apply(next);
  };

  const autoSort = () => {
    const next = [...stack].sort((a, b) => {
      const areaA = datasetCoverageAreaSqDeg(a, sources) ?? Infinity;
      const areaB = datasetCoverageAreaSqDeg(b, sources) ?? Infinity;
      return areaA - areaB;
    });
    apply(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {stack.length > 1 && (
        <button
          type="button"
          onClick={autoSort}
          className="flex min-h-11 items-center gap-2 self-start rounded-full bg-surface-2 px-4 text-sm font-medium text-accent"
        >
          <Icon name="autoSort" className="h-4 w-4" />
          Auto-sort — high resolution first
        </button>
      )}
      <ol className="flex flex-col gap-1.5">
        {stack.map((dataset, i) => {
          const row = rowForDataset(rows, dataset);
          const name = row?.name ?? dataset.name;
          return (
            <li key={dataset.id} className="flex items-center gap-1 rounded-xl border border-border bg-surface px-2 py-1">
              <span className="w-5 shrink-0 text-center text-xs font-semibold text-muted tabular-nums">{i + 1}</span>
              <button
                type="button"
                onClick={() => {
                  if (row) {
                    select(row.key);
                    onSelected?.();
                  }
                }}
                className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-lg px-1.5 text-left"
              >
                <span className="truncate text-sm font-medium leading-tight">{name}</span>
                <span className="truncate text-xs text-muted">
                  {TYPE_BADGE[dataset.type]} · {formatBytes(dataset.sizeBytes)}
                </span>
              </button>
              <DeleteDatasetButton id={dataset.id} name={name} sizeBytes={dataset.sizeBytes} />
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  aria-label={`Move ${name} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className="flex min-h-6 min-w-11 items-center justify-center rounded-lg py-1 text-muted hover:bg-surface-2 disabled:opacity-25"
                >
                  <Icon name="arrowUp" className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${name} down`}
                  disabled={i === stack.length - 1}
                  onClick={() => move(i, 1)}
                  className="flex min-h-6 min-w-11 items-center justify-center rounded-lg py-1 text-muted hover:bg-surface-2 disabled:opacity-25"
                >
                  <Icon name="arrowDown" className="h-4 w-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">Top wins where coverage overlaps — put small, high-resolution datasets above global models.</p>
    </div>
  );
}
