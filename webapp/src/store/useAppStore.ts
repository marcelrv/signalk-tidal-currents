import { create } from 'zustand';

import { api } from '../api/client';
import {
  CatalogSourceType,
  CatalogState,
  DatasetEntry,
  DownloadJob,
  SourceType,
  StorageStats,
} from '../api/types';

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

  storage: StorageStats | null;
  fetchStorage: () => Promise<void>;

  priority: SourceType[];
  setPriority: (order: SourceType[]) => Promise<void>;

  downloads: Record<string, DownloadJob>;
  startDownload: (sourceId: string, selector?: { region_id?: string; filename?: string }) => Promise<string>;
  pollDownload: (id: string) => Promise<void>;

  view: 'map' | 'list';
  setView: (v: 'map' | 'list') => void;

  filters: Filters;
  setFilters: (patch: Partial<Filters>) => void;

  selection: { sourceId: string | null };
  select: (id: string | null) => void;

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
    await get().fetchDatasets();
  },

  storage: null,
  fetchStorage: async () => {
    const storage = await api.getStorage();
    set({ storage });
  },

  priority: ['grib2', 'utcef', 'harmonic'],
  setPriority: async (order) => {
    const res = await api.setPriority(order);
    set({ priority: res.order });
  },

  downloads: {},
  startDownload: async (sourceId, selector) => {
    const job = await api.startDownload(sourceId, selector);
    set((s) => ({ downloads: { ...s.downloads, [job.id]: job } }));
    return job.id;
  },
  pollDownload: async (id) => {
    const job = await api.getDownload(id);
    set((s) => ({ downloads: { ...s.downloads, [id]: job } }));
  },

  view: 'list',
  setView: (view) => set({ view }),

  filters: { types: new Set(), query: '', tags: new Set() },
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),

  selection: { sourceId: null },
  select: (id) => set({ selection: { sourceId: id } }),

  vesselPosition: null,
  fetchVesselPosition: async () => {
    const pos = await api.getVesselPosition().catch(() => null);
    set({ vesselPosition: pos });
  },

  wizard: { open: false, dismissed: false },
  openWizard: () => set({ wizard: { open: true, dismissed: false } }),
  dismissWizard: () => set({ wizard: { open: false, dismissed: true } }),
}));
