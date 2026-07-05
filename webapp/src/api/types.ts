// Mirrors the backend types in src/catalogTypes.ts, src/catalog.ts,
// src/manifest.ts, src/downloads.ts, src/managerApi.ts, src/storage.ts,
// src/priority.ts — kept in sync by hand (no shared package between the
// backend and this webapp).

export interface BoundingBox {
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
}

export interface GeoJsonGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

export interface CatalogRegion {
  name: string;
  bounding_box: BoundingBox;
  boundary_geometry: GeoJsonGeometry;
}

export interface UpdateCheck {
  method: 'sha256' | 'expiry';
  last_checked: string;
  max_age_hours?: number;
  latest_cycle?: string;
}

export interface StaticCatalogFile {
  filename: string;
  url?: string;
  sha256?: string;
  size_bytes: number;
}

export interface TemplateCatalogFile {
  region_id: string;
  name: string;
  description: string;
  boundary_geometry: GeoJsonGeometry;
  type: 'forecast' | 'nowcast';
  url_template: string;
  forecast_hours: number[];
  cycle_hours: string[];
}

export type CatalogFile = StaticCatalogFile | TemplateCatalogFile;

export function isTemplateFile(f: CatalogFile): f is TemplateCatalogFile {
  return typeof (f as TemplateCatalogFile).url_template === 'string';
}

export type CatalogSourceType = 'harmonic' | 'grib2' | 'utcef';

export interface CatalogSource {
  id: string;
  source: string;
  type: CatalogSourceType;
  name: string;
  description: string;
  contributor: string;
  url: string;
  tags: string[];
  region: CatalogRegion;
  update_check: UpdateCheck;
  files: CatalogFile[];
}

export interface CatalogDocument {
  catalog_schema_version: string;
  version: number;
  generated: string;
  source_count: number;
  sources: CatalogSource[];
}

export type CatalogStatus = 'empty' | 'cached' | 'error';

export interface CatalogState {
  status: CatalogStatus;
  document: CatalogDocument | null;
  fetchedAt: string | null;
  error: string | null;
  sourceUrl: string;
  warnings: string[];
}

export type ManifestDir = 'harmonic' | 'grib' | 'utcef';

export interface DatasetEntry {
  id: string;
  catalogSourceId: string | null;
  type: CatalogSourceType;
  name: string;
  files: string[];
  dir: ManifestDir;
  sizeBytes: number;
  downloadedAt: string | null;
  cycle?: string;
  regionId?: string;
  /** A region can carry both a forecast and a nowcast file (real NOAA catalog shape) — region_id alone doesn't uniquely re-select the same one. */
  fileType?: 'forecast' | 'nowcast';
  status: 'active' | 'update-available' | 'error';
  updateCheckMethod?: 'sha256' | 'expiry';
  expiresAt?: string;
  remainingHours?: number;
  maxAgeHours?: number;
  contributor?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
  citationRequired?: string;
  copyright?: string;
}

export interface StorageStats {
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
  usedByPluginBytes: number;
}

export interface CleanupCandidate {
  id: string;
  catalogSourceId: string | null;
  name: string;
  type: CatalogSourceType;
  sizeBytes: number;
  distanceNm: number | null;
  downloadedAt: string | null;
}

export interface CleanupCandidatesResponse {
  vesselPosition: { lat: number; lon: number } | null;
  maxDistanceNm: number;
  candidates: CleanupCandidate[];
}

export type DownloadJobState = 'queued' | 'active' | 'done' | 'error';

export interface DownloadJob {
  id: string;
  catalogSourceId: string;
  state: DownloadJobState;
  bytes: number;
  totalBytes: number | null;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  resultInstallId?: string;
}

export type SourceType = 'grib2' | 'utcef' | 'harmonic';

export interface PriorityResponse {
  order: SourceType[];
  default: SourceType[];
}

export interface VectorResponse {
  source: 'grib' | 'utcef' | 'station';
  station: { id: string; name: string; distanceKm?: number } | null;
  sample: { time: string; speedKn: number | null; direction: number | null; u: number | null; v: number | null };
}
