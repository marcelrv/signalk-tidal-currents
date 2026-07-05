import { useMemo } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { datasetForSource, groupByProvider, matchesFilters } from '../../lib/sources';
import { SourceListRow } from './SourceListRow';

/**
 * List view (PRD §5.1): text-first browsing, rows grouped by provider,
 * fully keyboard/screen-reader accessible — works even with map rendering
 * disabled on very low-power devices.
 */
export function SourceList() {
  const catalog = useAppStore((s) => s.catalog);
  const datasets = useAppStore((s) => s.datasets);
  const filters = useAppStore((s) => s.filters);

  const groups = useMemo(() => {
    const sources = catalog?.document?.sources ?? [];
    const filtered = sources.filter((s) => matchesFilters(s, filters));
    return groupByProvider(filtered);
  }, [catalog, filters]);

  if (!catalog?.document) {
    return <p className="p-4 text-muted">No catalog yet — sync when online.</p>;
  }
  if (groups.length === 0) {
    return <p className="p-4 text-muted">No datasets match the current filters.</p>;
  }

  return (
    <div>
      {groups.map(({ provider, sources }) => (
        <section key={provider} aria-label={provider}>
          <h2 className="bg-muted/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            {provider}
          </h2>
          <ul>
            {sources.map((source) => (
              <SourceListRow key={source.id} source={source} dataset={datasetForSource(datasets, source.id)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
