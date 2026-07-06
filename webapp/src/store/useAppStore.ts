import { create } from 'zustand';

import { api } from '../api/client';
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

export interface AppState {
  catalog: CatalogState | null;
  catalogLoading: boolean;
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

export const useAppStore = create<AppState>((set, get) => ({
  catalog: null,
  catalogLoading: false,
  fetchCatalog: async () => {
    set({ catalogLoading: true });
    try {
      const catalog = await api.getCatalog();
      set({ catalog });
    } finally {
      set({ catalogLoading: false });
    }
  },
  refreshCatalog: async () => {
    set({ catalogLoading: true });
    try {
      const catalog = await api.refreshCatalog().catch((): CatalogState | null => null);
      if (catalog) set({ catalog });
      else await get().fetchCatalog(); // refresh failed — re-read whatever's cached
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
      if (datasets.length === 0 && !get().wizard.dismissed) set({ wizard: { open: true, dismissed: false } });
    } finally {
      set({ datasetsLoading: false });
    }
  },
  deleteDataset: async (id) => {
    await api.deleteDataset(id);
    // Deleting frees disk and drops the install out of the priority stack —
    // refresh everything that displays either, not just the dataset list.
    await Promise.all([get().fetchDatasets(), get().fetchStorage(), get().fetchPriority()]);
  },
  setAutoUpdate: async (id, enabled) => {
    await api.setAutoUpdate(id, enabled);
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
    const res = await api.setPriority({ order });
    set({ priority: res.order, priorityDatasets: res.datasets ?? [] });
  },
  setDatasetPriority: async (datasets) => {
    const res = await api.setPriority({ datasets });
    set({ priority: res.order, priorityDatasets: res.datasets ?? [] });
  },

  manageOpen: false,
  setManageOpen: (open) => set({ manageOpen: open }),

  downloads: {},
  jobIdBySource: {},
  startDownload: async (sourceId, selector) => {
    const job = await api.startDownload(sourceId, selector);
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
}));
