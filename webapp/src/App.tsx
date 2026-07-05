import { useEffect, useMemo } from 'react';

import { useAppStore } from './store/useAppStore';
import { Theme, useTheme } from './theme/ThemeProvider';
import { Icon, IconName } from './components/shared/Icon';
import { ViewToggle } from './components/layout/ViewToggle';
import { LiveSourceChip } from './components/layout/LiveSourceChip';
import { ManageSheet } from './components/layout/ManageSheet';
import { QuickFilters } from './components/browser/QuickFilters';
import { SearchBox } from './components/browser/SearchBox';
import { SourceList } from './components/browser/SourceList';
import { SourceMap } from './components/browser/SourceMap';
import { SourceDetailModal } from './components/browser/SourceDetailModal';
import { FirstRunWizard } from './components/wizard/FirstRunWizard';
import { StorageGauge } from './components/storage/StorageGauge';
import { UpdateAllBanner } from './components/updates/UpdateAllBanner';
import { timeAgo } from './lib/format';

const THEME_CYCLE: Theme[] = ['day', 'dark', 'red'];
const THEME_ICON: Record<Theme, IconName> = { day: 'sun', dark: 'moon', red: 'nightMode' };
const THEME_LABEL: Record<Theme, string> = { day: 'Day', dark: 'Dark', red: 'Red night' };

/**
 * App shell, sized for small helm displays (7"+): one compact app bar
 * (title + live source chip + two icon actions), a sticky search/filter
 * toolbar on two thin rows, the browsing surface, and a slim status footer.
 * All management chrome (storage, cleanup, priorities, catalog sync) lives
 * in the ManageSheet behind the footer's "Manage" button.
 */
export function App() {
  const { theme, setTheme } = useTheme();
  const catalog = useAppStore((s) => s.catalog);
  const catalogLoading = useAppStore((s) => s.catalogLoading);
  const fetchCatalog = useAppStore((s) => s.fetchCatalog);
  const refreshCatalog = useAppStore((s) => s.refreshCatalog);
  const fetchDatasets = useAppStore((s) => s.fetchDatasets);
  const fetchStorage = useAppStore((s) => s.fetchStorage);
  const fetchPriority = useAppStore((s) => s.fetchPriority);
  const fetchVesselPosition = useAppStore((s) => s.fetchVesselPosition);
  const view = useAppStore((s) => s.view);
  const openWizard = useAppStore((s) => s.openWizard);
  const manageOpen = useAppStore((s) => s.manageOpen);
  const setManageOpen = useAppStore((s) => s.setManageOpen);

  useEffect(() => {
    fetchCatalog();
    fetchDatasets();
    fetchStorage();
    fetchPriority();
    fetchVesselPosition();
  }, [fetchCatalog, fetchDatasets, fetchStorage, fetchPriority, fetchVesselPosition]);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    for (const s of catalog?.document?.sources ?? []) for (const t of s.tags) tags.add(t);
    return [...tags].sort();
  }, [catalog]);

  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-2 px-3">
          <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Icon name="anchor" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold leading-tight">Tidal Currents</h1>
            <LiveSourceChip />
          </div>
          <button
            type="button"
            onClick={openWizard}
            aria-label="Download data for your area"
            title="Download data for your area"
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-sm font-medium text-accent"
          >
            <Icon name="download" className="h-4 w-4" />
            <span className="hidden sm:inline">Download data</span>
          </button>
          <button
            type="button"
            onClick={() => setTheme(nextTheme)}
            aria-label={`Theme: ${THEME_LABEL[theme]} — switch to ${THEME_LABEL[nextTheme]}`}
            title={`Theme: ${THEME_LABEL[theme]} — tap for ${THEME_LABEL[nextTheme]}`}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2"
          >
            <Icon name={THEME_ICON[theme]} className="h-5 w-5" />
          </button>
        </div>
      </header>

      {catalogLoading && !catalog ? (
        <main className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted">Loading catalog…</p>
        </main>
      ) : (
        <>
          <div className="sticky top-14 z-20 border-b border-border bg-bg">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <SearchBox />
                <ViewToggle />
              </div>
              <QuickFilters availableTags={availableTags} />
            </div>
          </div>
          <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-3 py-3">
            <UpdateAllBanner />
            {view === 'list' ? (
              <SourceList />
            ) : (
              <div className="flex min-h-[320px] flex-1 flex-col">
                <SourceMap />
              </div>
            )}
          </main>
        </>
      )}

      <footer className="sticky bottom-0 z-30 border-t border-border bg-surface">
        <div className="mx-auto flex h-12 w-full max-w-3xl items-center gap-3 px-3 pb-[env(safe-area-inset-bottom)]">
          <StorageGauge compact />
          <button
            type="button"
            onClick={() => refreshCatalog()}
            disabled={catalogLoading}
            className="min-w-0 truncate text-xs text-muted disabled:opacity-50"
            title="Tap to sync the catalog now"
          >
            {catalogLoading ? 'syncing…' : `synced ${catalog?.fetchedAt ? timeAgo(catalog.fetchedAt) : 'never'}`}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-xs font-semibold text-fg"
          >
            <Icon name="sliders" className="h-4 w-4" />
            Manage
          </button>
        </div>
      </footer>

      <FirstRunWizard />
      <SourceDetailModal />
      {manageOpen && <ManageSheet onClose={() => setManageOpen(false)} />}
    </div>
  );
}
