import { create } from 'zustand';

import { api, isPermissionError } from '../api/client';
import {
  CatalogSourceType,
  CatalogState,
  CleanupCandidate,
  DatasetEntry,
  DownloadJob,
  SourceType,
  StorageStats,
} from '../api/types';
import { downloadKeyFor } from '../lib/sources';

export interface Filters {
  types: Set<CatalogSourceType>;
  query: string;
  tags: Set<string>;
}

interface WizardState {
  open: boolean;
  dismissed: boolean;
}

/**
 * What the current visitor may do. `readonly` = browse only (anonymous or
 * non-admin on a secured server, e.g. a public demo) — mutations live on the
 * admin-only plugin path. `unknown` until loginStatus has been read; treated
 * as writable so a secured-but-logged-in admin never sees a flash of
 * disabled controls (a 401/403 on a write still flips it to `readonly`).
 */
export type Access = 'admin' | 'readonly' | 'unknown';

export const READ_ONLY_HINT = 'Read-only — log in as an administrator to change data';

export interface AppState {
  access: Access;
  fetchAccess: () => Promise<void>;

  catalog: CatalogState | null;
  catalogLoading: boolean;
  /** Last catalog fetch/refresh failure (null once one succeeds) — shown in the footer instead of being swallowed. */
  catalogError: string | null;
  fetchCatalog: () => Promise<void>;
  refreshCatalog: () => Promise<void>;

  datasets: DatasetEntry[];
  datasetsLoading: boolean;
  fetchDatasets: () => Promise<void>;
  deleteDataset: (id: string) => Promise<void>;
  setAutoUpdate: (id: string, enabled: boolean) => Promise<void>;

  storage: StorageStats | null;
  fetchStorage: () => Promise<void>;

  cleanupCandidates: CleanupCandidate[];
  cleanupVesselPosition: { lat: number; lon: number } | null;
  cleanupMaxDistanceNm: number;
  fetchCleanupCandidates: (maxDistanceNm?: number) => Promise<void>;

  priority: SourceType[];
  /** Resolved per-dataset stack (PRD §5.3 Phase 3): install ids, top wins. */
  priorityDatasets: string[];
  fetchPriority: () => Promise<void>;
  setPriority: (order: SourceType[]) => Promise<void>;
  setDatasetPriority: (datasets: string[]) => Promise<void>;

  /** The "Storage & data" management sheet (storage, cleanup, priority stack). */
  manageOpen: boolean;
  setManageOpen: (open: boolean) => void;

  downloads: Record<string, DownloadJob>;
  /** Keyed by downloadKeyFor(sourceId, regionId) — lets ANY component (a row's own button, or a bulk "Update All" action) find and render the right progress for a source/region it didn't necessarily start itself. */
  jobIdBySource: Record<string, string>;
  startDownload: (sourceId: string, selector?: { region_id?: string; type?: 'forecast' | 'nowcast'; variant?: string; filename?: string }) => Promise<string>;
  pollDownload: (id: string) => Promise<void>;
  /** Pure setter shared by the SSE hook and the polling fallback — one place that writes job state into the store. */
  setDownloadJob: (job: DownloadJob) => void;

  view: 'map' | 'list';
  setView: (v: 'map' | 'list') => void;

  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;

  /** Keyed by SourceRow.key (source.id, or `${source.id}:${region_id}` for a per-region row). */
  selection: { key: string | null };
  select: (key: string | null) => void;

  vesselPosition: { latitude: number; longitude: number } | null;
  fetchVesselPosition: () => Promise<void>;

  wizard: WizardState;
  openWizard: () => void;
  dismissWizard: () => void;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useAppStore = create<AppState>((set, get) => {
  /**
   * Every mutation goes through here: refuse up front in read-only mode
   * (controls are disabled anyway — this is the backstop), and if the server
   * answers 401/403 anyway (session expired, non-admin login), flip to
   * read-only so the UI reflects it instead of failing silently.
   */
  async function write<T>(fn: () => Promise<T>): Promise<T> {
    if (get().access === 'readonly') throw new Error(READ_ONLY_HINT);
    try {
      return await fn();
    } catch (e) {
      if (isPermissionError(e)) set({ access: 'readonly' });
      throw e;
    }
  }

  return {
  access: 'unknown',
  fetchAccess: async () => {
    const st = await api.getLoginStatus();
    // No loginStatus (no security) or security not enforced → full access,
    // mirroring the server. Otherwise only a logged-in admin may write.
    if (!st || st.authenticationRequired === false) set({ access: 'admin' });
    else set({ access: st.status === 'loggedIn' && st.userLevel === 'admin' ? 'admin' : 'readonly' });
  },

  catalog: null,
  catalogLoading: false,
  catalogError: null,
  fetchCatalog: async () => {
    set({ catalogLoading: true });
    try {
      const catalog = await api.getCatalog();
      set({ catalog, catalogError: catalog.error ?? null });
    } catch (e) {
      set({ catalogError: errorMessage(e) });
    } finally {
      set({ catalogLoading: false });
    }
  },
  refreshCatalog: async () => {
    if (get().access === 'readonly') return; // Sync is disabled in the UI; nothing to do
    set({ catalogLoading: true });
    try {
      const catalog = await write(() => api.refreshCatalog());
      set({ catalog, catalogError: catalog.error ?? null });
    } catch (e) {
      // Refresh failed — keep showing whatever is cached (re-read it in case
      // we had nothing yet), but surface why instead of swallowing it.
      const message = errorMessage(e);
      await get().fetchCatalog();
      set({ catalogError: isPermissionError(e) ? null : message });
    } finally {
      set({ catalogLoading: false });
    }
  },

  datasets: [],
  datasetsLoading: false,
  fetchDatasets: async () => {
    set({ datasetsLoading: true });
    try {
      const datasets = await api.getDatasets();
      set({ datasets });
      if (datasets.length === 0 && !get().wizard.dismissed && get().access !== 'readonly') set({ wizard: { open: true, dismissed: false } });
    } finally {
      set({ datasetsLoading: false });
    }
  },
  deleteDataset: async (id) => {
    await write(() => api.deleteDataset(id));
    // Deleting frees disk and drops the install out of the priority stack —
    // refresh everything that displays either, not just the dataset list.
    await Promise.all([get().fetchDatasets(), get().fetchStorage(), get().fetchPriority()]);
  },
  setAutoUpdate: async (id, enabled) => {
    await write(() => api.setAutoUpdate(id, enabled));
    await get().fetchDatasets();
  },

  storage: null,
  fetchStorage: async () => {
    const storage = await api.getStorage();
    set({ storage });
  },

  cleanupCandidates: [],
  cleanupVesselPosition: null,
  cleanupMaxDistanceNm: 50,
  fetchCleanupCandidates: async (maxDistanceNm) => {
    const res = await api.getCleanupCandidates(maxDistanceNm);
    set({ cleanupCandidates: res.candidates, cleanupVesselPosition: res.vesselPosition, cleanupMaxDistanceNm: res.maxDistanceNm });
  },

  priority: ['grib2', 'utcef', 'harmonic'],
  priorityDatasets: [],
  fetchPriority: async () => {
    const res = await api.getPriority().catch(() => null);
    if (res) set({ priority: res.order, priorityDatasets: res.datasets ?? [] });
  },
  setPriority: async (order) => {
    const res = await write(() => api.setPriority({ order }));
    set({ priority: res.order, priorityDatasets: res.datasets ?? [] });
  },
  setDatasetPriority: async (datasets) => {
    const res = await write(() => api.setPriority({ datasets }));
    set({ priority: res.order, priorityDatasets: res.datasets ?? [] });
  },

  manageOpen: false,
  setManageOpen: (open) => set({ manageOpen: open }),

  downloads: {},
  jobIdBySource: {},
  startDownload: async (sourceId, selector) => {
    const job = await write(() => api.startDownload(sourceId, selector));
    const key = downloadKeyFor(sourceId, selector?.region_id, selector?.type, selector?.variant);
    set((s) => ({
      downloads: { ...s.downloads, [job.id]: job },
      jobIdBySource: { ...s.jobIdBySource, [key]: job.id },
    }));
    return job.id;
  },
  pollDownload: async (id) => {
    const job = await api.getDownload(id);
    get().setDownloadJob(job);
  },
  setDownloadJob: (job) => {
    const prev = get().downloads[job.id];
    set((s) => ({ downloads: { ...s.downloads, [job.id]: job } }));
    // The download itself succeeded/failed here, but nothing else re-reads
    // the manifest on its own — without this, a finished job's row/button
    // just reverts to whatever `datasets`/`storage` said before the
    // download started (looking like the click "did nothing"), since the
    // job leaving `active` state is the only signal that data changed.
    if (job.state !== prev?.state && (job.state === 'done' || job.state === 'error')) {
      get().fetchDatasets();
      get().fetchStorage();
    }
  },

  view: 'list',
  setView: (view) => set({ view }),

  filters: { types: new Set(), query: '', tags: new Set() },
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),

  selection: { key: null },
  select: (key) => set({ selection: { key } }),

  vesselPosition: null,
  fetchVesselPosition: async () => {
    const pos = await api.getVesselPosition().catch(() => null);
    set({ vesselPosition: pos });
  },

  wizard: { open: false, dismissed: false },
  openWizard: () => set({ wizard: { open: true, dismissed: false } }),
  dismissWizard: () => set({ wizard: { open: false, dismissed: true } }),
  };
});
