import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { datasetForRow, groupRowsByProvider, matchesFilters, rowsForSources } from '../../lib/sources';
import { pointInGeometry } from '../../lib/geo';
import { SourceListRow } from './SourceListRow';

/**
 * List view (PRD §5.1): text-first browsing, rows grouped by provider,
 * fully keyboard/screen-reader accessible — works even with map rendering
 * disabled on very low-power devices. A source with multiple region-scoped
 * files (e.g. a multi-region forecast) expands into one row per region
 * (rowsForSources) — otherwise those regions would be invisible, collapsed
 * into a single "provider" row.
 */
export function SourceList() {
  const catalog = useAppStore((s) => s.catalog);
  const datasets = useAppStore((s) => s.datasets);
  const filters = useAppStore((s) => s.filters);
  const vesselPosition = useAppStore((s) => s.vesselPosition);

  const groups = useMemo(() => {
    const sources = catalog?.document?.sources ?? [];
    const filtered = sources.filter((s) => matchesFilters(s, filters));
    return groupRowsByProvider(rowsForSources(filtered));
  }, [catalog, filters]);

  // Smart default (once, on first load): expand only groups with a region
  // covering the vessel's current position; collapse everything if no
  // position is available yet. Computed once so the user's own toggles
  // afterward aren't overwritten by catalog/position refreshes.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const defaultedRef = useRef(false);
  useEffect(() => {
    if (defaultedRef.current || groups.length === 0) return;
    defaultedRef.current = true;
    if (!vesselPosition) return;
    setExpanded(
      new Set(
        groups
          .filter(({ rows }) => rows.some((r) => pointInGeometry(r.geometry, vesselPosition.latitude, vesselPosition.longitude)))
          .map((g) => g.provider),
      ),
    );
  }, [groups, vesselPosition]);

  if (!catalog?.document) {
    return <p className="p-4 text-muted">No catalog yet — sync when online.</p>;
  }
  if (groups.length === 0) {
    return <p className="p-4 text-muted">No datasets match the current filters.</p>;
  }

  return (
    <div>
      {groups.map(({ provider, rows }) => (
        <details
          key={provider}
          open={expanded.has(provider)}
          onToggle={(e) => {
            const isOpen = e.currentTarget.open;
            setExpanded((prev) => {
              const next = new Set(prev);
              if (isOpen) next.add(provider);
              else next.delete(provider);
              return next;
            });
          }}
        >
          <summary className="min-h-11 cursor-pointer bg-muted/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            {provider} <span className="normal-case text-muted/70">({rows.length})</span>
          </summary>
          <ul>
            {rows.map((row) => (
              <SourceListRow key={row.key} row={row} dataset={datasetForRow(datasets, row)} />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
