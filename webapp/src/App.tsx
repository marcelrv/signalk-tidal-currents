import { useEffect, useMemo } from 'react';

import { useAppStore } from './store/useAppStore';
import { useTheme } from './theme/ThemeProvider';
import { ViewToggle } from './components/layout/ViewToggle';
import { QuickFilters } from './components/browser/QuickFilters';
import { SearchBox } from './components/browser/SearchBox';
import { SourceList } from './components/browser/SourceList';
import { SourceMap } from './components/browser/SourceMap';
import { SourceDetailModal } from './components/browser/SourceDetailModal';
import { FirstRunWizard } from './components/wizard/FirstRunWizard';
import { LiveSourceChip } from './components/layout/LiveSourceChip';
import { StorageGauge } from './components/storage/StorageGauge';
import { PriorityList } from './components/priority/PriorityList';
import { timeAgo } from './lib/format';

export function App() {
  const { theme, setTheme } = useTheme();
  const catalog = useAppStore((s) => s.catalog);
  const catalogLoading = useAppStore((s) => s.catalogLoading);
  const fetchCatalog = useAppStore((s) => s.fetchCatalog);
  const fetchDatasets = useAppStore((s) => s.fetchDatasets);
  const fetchStorage = useAppStore((s) => s.fetchStorage);
  const fetchVesselPosition = useAppStore((s) => s.fetchVesselPosition);
  const view = useAppStore((s) => s.view);
  const openWizard = useAppStore((s) => s.openWizard);

  useEffect(() => {
    fetchCatalog();
    fetchDatasets();
    fetchStorage();
    fetchVesselPosition();
  }, [fetchCatalog, fetchDatasets, fetchStorage, fetchVesselPosition]);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    for (const s of catalog?.document?.sources ?? []) for (const t of s.tags) tags.add(t);
    return [...tags].sort();
  }, [catalog]);

  return (
    <div className="min-h-full bg-bg text-fg">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-muted/30 p-4">
        <div>
          <h1 className="text-lg font-semibold">Tidal Currents Manager</h1>
          <LiveSourceChip />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={openWizard}
            className="min-h-11 rounded border border-accent px-3 text-sm font-medium text-accent"
          >
            Plan a trip
          </button>
          <select
            aria-label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value as typeof theme)}
            className="min-h-11 rounded border border-muted/40 bg-surface px-2 text-fg"
          >
            <option value="day">Day</option>
            <option value="dark">Dark</option>
            <option value="red">Red (night)</option>
          </select>
        </div>
      </header>
      <main className="p-4">
        {catalogLoading && !catalog ? (
          <p className="text-muted">Loading catalog…</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <ViewToggle />
              <StorageGauge />
              <p className="text-xs text-muted">
                Last catalog sync: {catalog?.fetchedAt ? timeAgo(catalog.fetchedAt) : 'never'}
                {catalog?.error ? ` · ${catalog.error}` : ''}
              </p>
            </div>
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="sm:w-64"><SearchBox /></div>
              <QuickFilters availableTags={availableTags} />
            </div>
            {view === 'list' ? <SourceList /> : <SourceMap />}
            <details className="mt-4">
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Source priority</summary>
              <PriorityList />
            </details>
          </>
        )}
      </main>
      <FirstRunWizard />
      <SourceDetailModal />
    </div>
  );
}
