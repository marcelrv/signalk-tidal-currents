import {
  CatalogState,
  CleanupCandidatesResponse,
  DatasetEntry,
  DownloadJob,
  PriorityResponse,
  StorageStats,
  SourceType,
  VectorResponse,
} from './types';

// Hardcoded, not derived from window.location — robust regardless of how the
// Admin UI mounts this webapp (relative resolution quirks, trailing slash,
// etc.). All backend I/O for this plugin lives under this one prefix:
// signalk-server keeps it admin-only, except the routes the plugin marks
// readable via router.access('readonly') (the manager's read-only view), so
// anonymous visitors can still browse on a locked-down server (public demo).
export const API_BASE = '/plugins/signalk-tidal-currents';

/** An HTTP error from the plugin API — `status` lets callers tell "not allowed" (401/403) apart from real failures; `body` is the parsed JSON response (e.g. the cached catalog a failed refresh still returns). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown = null) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isPermissionError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null) ?? `HTTP ${resp.status}`;
    throw new ApiError(message, resp.status, body);
  }
  return body as T;
}

/** Subset of signalk-server's `/skServer/loginStatus` this app cares about. */
export interface LoginStatus {
  status?: string;
  userLevel?: string;
  authenticationRequired?: boolean;
}

export const api = {
  getCatalog: () => request<CatalogState>('/catalog'),
  refreshCatalog: () => request<CatalogState>('/catalog/refresh', { method: 'POST' }),

  getDatasets: () => request<DatasetEntry[]>('/datasets'),
  deleteDataset: (id: string) => request<{ ok: true }>(`/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setAutoUpdate: (id: string, enabled: boolean) =>
    request<{ ok: true; autoUpdate: boolean }>(`/datasets/${encodeURIComponent(id)}/auto-update`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  getStorage: () => request<StorageStats>('/storage'),
  getCleanupCandidates: (maxDistanceNm?: number) =>
    request<CleanupCandidatesResponse>(`/cleanup-candidates${maxDistanceNm !== undefined ? `?maxDistanceNm=${maxDistanceNm}` : ''}`),

  startDownload: (sourceId: string, selector?: { region_id?: string; type?: 'forecast' | 'nowcast'; variant?: string; filename?: string }) =>
    request<DownloadJob>('/downloads', { method: 'POST', body: JSON.stringify({ sourceId, ...selector }) }),
  getDownload: (id: string) => request<DownloadJob>(`/downloads/${encodeURIComponent(id)}`),
  listDownloads: () => request<DownloadJob[]>('/downloads'),

  getPriority: () => request<PriorityResponse>('/priority'),
  setPriority: (body: { order?: SourceType[]; datasets?: string[] }) =>
    request<PriorityResponse>('/priority', { method: 'PUT', body: JSON.stringify(body) }),

  getVectorAt: (lat: number, lon: number) =>
    request<VectorResponse>(`/vector?latitude=${lat}&longitude=${lon}`),

  /** Throws an ApiError on any non-OK answer (incl. 404, e.g. a proxy not forwarding /skServer) — access then stays unknown/read-only, never granted. */
  getLoginStatus: async (): Promise<LoginStatus> => {
    // Bounded: a hung request would otherwise block dataset loading (which
    // waits on the access check) forever. The abort rejects with a non-ApiError,
    // i.e. a transient failure the caller retries. The timer stays armed through
    // the body read, since a body can stall after the headers have arrived.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const resp = await fetch('/skServer/loginStatus', { credentials: 'same-origin', signal: ctrl.signal });
      if (!resp.ok) throw new ApiError(`HTTP ${resp.status}`, resp.status);
      return (await resp.json()) as LoginStatus;
    } finally {
      clearTimeout(timer);
    }
  },

  // Vessel position comes from the SignalK server itself, not this plugin.
  getVesselPosition: async (): Promise<{ latitude: number; longitude: number } | null> => {
    const resp = await fetch('/signalk/v1/api/vessels/self/navigation/position');
    if (!resp.ok) return null;
    const body = await resp.json().catch(() => null);
    const value = body?.value ?? body;
    if (typeof value?.latitude === 'number' && typeof value?.longitude === 'number') {
      return { latitude: value.latitude, longitude: value.longitude };
    }
    return null;
  },
};
