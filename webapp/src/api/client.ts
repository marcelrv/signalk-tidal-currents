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
// etc.). All backend I/O for this plugin lives under this one prefix.
const API_BASE = '/plugins/signalk-tidal-currents';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null) ?? `HTTP ${resp.status}`;
    throw new Error(message);
  }
  return body as T;
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

  startDownload: (sourceId: string, selector?: { region_id?: string; type?: 'forecast' | 'nowcast'; filename?: string }) =>
    request<DownloadJob>('/downloads', { method: 'POST', body: JSON.stringify({ sourceId, ...selector }) }),
  getDownload: (id: string) => request<DownloadJob>(`/downloads/${encodeURIComponent(id)}`),
  listDownloads: () => request<DownloadJob[]>('/downloads'),

  getPriority: () => request<PriorityResponse>('/priority'),
  setPriority: (body: { order?: SourceType[]; datasets?: string[] }) =>
    request<PriorityResponse>('/priority', { method: 'PUT', body: JSON.stringify(body) }),

  getVectorAt: (lat: number, lon: number) =>
    request<VectorResponse>(`/vector?latitude=${lat}&longitude=${lon}`),

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
