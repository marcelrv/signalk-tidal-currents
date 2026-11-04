import { create } from 'zustand';

import { api, ApiError, isPermissionError, LoginStatus } from '../api/client';
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
 * admin-only plugin path. `unknown` until loginStatus has been read; the UI
 * treats it like `readonly` (controls hidden/disabled, no banner) so a demo
 * visitor never sees a flash of admin controls — an admin briefly sees them
 * disabled instead. A 401/403 on a write flips to `readonly`.
 */
export type Access = 'admin' | 'readonly' | 'unknown';

export const READ_ONLY_HINT = 'Read-only — log in as an administrator to change data';

/** True unless the visitor is a confirmed admin — `unknown` counts as read-only (see `Access`). */
export const useReadOnly = () => useAppStore((s) => s.access !== 'admin');

/** The placeholder catalog served before start() has `status: 'empty'` + an error that is not a sync failure. */
const catalogErrorOf = (c: CatalogState) => (c.status === 'empty' ? null : c.error ?? null);

export interface AppState {
  access: Access;
  fetchAccess: () => Promise<void>;

  catalog: CatalogState | null;
  catalogLoading: boolean;
  /** Last catalog fetch/refresh failure (null once one succeeds) — shown in the footer instead of being swallowed. */
  catalogError: string | null;
  /** The server refused even the read-only manager routes (401/403 on GET) — see fetchCatalog. */
  readsDenied: boolean;
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
   * Every mutation goes through here. The server is the authority (controls
   * are hidden/disabled in read-only mode anyway): if it answers 401/403
   * (session expired, non-admin login), flip to read-only right away so the
   * UI reflects it, then re-read loginStatus — a transient refusal for a
   * still-logged-in admin restores the controls without waiting for a
   * window focus event (which an embedding iframe may never get).
   */
  async function write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isPermissionError(e)) {
        set({ access: 'readonly' });
        void get().fetchAccess();
      }
      throw e;
    }
  }

  let accessRetry: ReturnType<typeof setTimeout> | null = null;
  // fetchAccess can overlap (write() refusal, window focus, retry timer):
  // only the most recently STARTED call may set access.
  let accessSeq = 0;

  return {
  access: 'unknown',
  fetchAccess: async () => {
    if (accessRetry) clearTimeout(accessRetry);
    accessRetry = null;
    const seq = ++accessSeq;
    let st: LoginStatus;
    try {
      st = await api.getLoginStatus();
    } catch (e) {
      if (seq !== accessSeq) return;
      // Couldn't tell: grant nothing — fail closed if we had no answer yet (a
      // confirmed admin keeps theirs). Retry transient failures (network,
      // 5xx); a 404 (e.g. a reverse proxy not forwarding /skServer) won't
      // fix itself, so don't poll it.
      if (get().access === 'unknown') set({ access: 'readonly' });
      if (!(e instanceof ApiError && e.status === 404)) accessRetry = setTimeout(() => void get().fetchAccess(), 10_000);
      return;
    }
    if (seq !== accessSeq) return;
    const prev = get().access;
    // Only a confirmed "security not enforced" or a logged-in admin may write.
    const next: Access =
      st.authenticationRequired === false || (st.status === 'loggedIn' && st.userLevel === 'admin') ? 'admin' : 'readonly';
    set({ access: next });
    // Became admin after having been read-only (a failed first check later
    // retried, or a login elsewhere): re-run the empty-install check that
    // fetchDatasets skipped, so first-run onboarding isn't lost.
    // Same for the catalog: a refused first read left it empty + readsDenied.
    if (next === 'admin' && prev === 'readonly') {
      void get().fetchCatalog();
      get().fetchDatasets().catch(() => undefined);
    }
  },

  catalog: null,
  catalogLoading: false,
  catalogError: null,
  readsDenied: false,
  fetchCatalog: async () => {
    set({ catalogLoading: true });
    try {
      const catalog = await api.getCatalog();
      set({ catalog, catalogError: catalogErrorOf(catalog), readsDenied: false });
    } catch (e) {
      // A refused READ isn't a sync failure: the server doesn't offer the
      // read-only manager view to this visitor (signalk-server < 2.35 has no
      // per-route readonly access) — the banner explains it instead.
      if (isPermissionError(e)) set({ readsDenied: true });
      else set({ catalogError: errorMessage(e) });
    } finally {
      set({ catalogLoading: false });
    }
  },
  refreshCatalog: async () => {
    set({ catalogLoading: true });
    try {
      const catalog = await write(() => api.refreshCatalog());
      set({ catalog, catalogError: catalogErrorOf(catalog) });
    } catch (e) {
      // Refresh failed — keep showing whatever is cached (a 502 already
      // carries it in the body; otherwise re-read it in case we had nothing
      // yet), but surface why instead of swallowing it. A permission refusal
      // isn't a sync failure: keep the catalog's own error instead.
      const body = e instanceof ApiError ? e.body : null;
      const cached =
        body && typeof body === 'object' && 'status' in body ? (body as CatalogState) : await api.getCatalog().catch(() => null);
      if (cached) set({ catalog: cached });
      if (!isPermissionError(e)) set({ catalogError: errorMessage(e) });
      else if (cached) set({ catalogError: catalogErrorOf(cached) });
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
      // Only for a CONFIRMED admin: an unknown access (loginStatus still
      // pending/failing) must not pop the install wizard for a visitor.
      if (datasets.length === 0 && !get().wizard.dismissed && get().access === 'admin') set({ wizard: { open: true, dismissed: false } });
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
