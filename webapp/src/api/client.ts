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
// etc.).
//
// Reads go to the v2 mount: signalk-server lets anonymous GETs through under
// `/signalk/v2/api/*` when `allow_readonly` is on, so the manager can still
// browse on a locked-down server (e.g. a public demo). Mutations go to the
// plugin path, which signalk-server restricts to administrators — the
// plugin doesn't mount them on v2 at all.
export const READ_BASE = '/signalk/v2/api/currents';
export const WRITE_BASE = '/plugins/signalk-tidal-currents';

/** An HTTP error from the plugin API — `status` lets callers tell "not allowed" (401/403) apart from real failures. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isPermissionError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const send = (base: string) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  let resp = await send(method === 'GET' ? READ_BASE : WRITE_BASE);
  // The v2 mount only exists once the plugin's start() got that far; the
  // plugin path is always mounted (and serves "not started" placeholders),
  // so fall back to it for reads the v2 mount doesn't have (a non-JSON 404 —
  // a plugin route's own JSON 404, e.g. unknown job id, is a real answer).
  if (method === 'GET' && resp.status === 404 && !resp.headers.get('content-type')?.includes('json')) resp = await send(WRITE_BASE);
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null) ?? `HTTP ${resp.status}`;
    throw new ApiError(message, resp.status);
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

  /** `null` when unavailable (no security plugin / older server) — treated as "everything allowed", same as the server does. */
  getLoginStatus: async (): Promise<LoginStatus | null> => {
    try {
      const resp = await fetch('/skServer/loginStatus', { credentials: 'same-origin' });
      if (!resp.ok) return null;
      return (await resp.json()) as LoginStatus;
    } catch {
      return null;
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
