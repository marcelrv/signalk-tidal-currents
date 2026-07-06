import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { datasetForRow, groupRowsByProvider, matchesFilters, rowsForSources } from '../../lib/sources';
import { pointInGeometry } from '../../lib/geo';
import { Icon } from '../shared/Icon';
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

  // Smart default (once): expand the groups with a region covering the
  // vessel's current position. Waits for BOTH the catalog groups AND a
  // vessel position before firing — the position usually arrives a moment
  // after the catalog, and consuming the one-shot on that first
  // position-less render used to leave every group collapsed. Once applied,
  // the user's own toggles aren't overwritten by later refreshes.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const defaultedRef = useRef(false);
  useEffect(() => {
    if (defaultedRef.current || groups.length === 0 || !vesselPosition) return;
    defaultedRef.current = true;
    setExpanded(
      new Set(
        groups
          .filter(({ rows }) => rows.some((r) => pointInGeometry(r.geometry, vesselPosition.latitude, vesselPosition.longitude)))
          .map((g) => g.provider),
      ),
    );
  }, [groups, vesselPosition]);

  if (!catalog?.document) {
    return <p className="p-4 text-sm text-muted">No catalog yet — sync when online.</p>;
  }
  if (groups.length === 0) {
    return <p className="p-4 text-sm text-muted">No datasets match the current filters.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ provider, rows }) => {
        const open = expanded.has(provider);
        const installedCount = rows.filter((r) => datasetForRow(datasets, r)).length;
        return (
          <details
            key={provider}
            open={open}
            onToggle={(e) => {
              const isOpen = e.currentTarget.open;
              setExpanded((prev) => {
                const next = new Set(prev);
                if (isOpen) next.add(provider);
                else next.delete(provider);
                return next;
              });
            }}
            className="overflow-hidden rounded-xl border border-border bg-surface"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
              <Icon name="chevronRight" className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{provider}</span>
              {installedCount > 0 && (
                <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success tabular-nums">
                  {installedCount} installed
                </span>
              )}
              <span className="shrink-0 text-xs text-muted tabular-nums">{rows.length}</span>
            </summary>
            <ul className="border-t border-border px-1 py-1">
              {rows.map((row) => (
                <SourceListRow key={row.key} row={row} dataset={datasetForRow(datasets, row)} />
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
