import { CatalogSource, DatasetEntry, GeoJsonGeometry, StorageStats, isTemplateFile } from '../api/types';

export type DisplayStatus = 'active' | 'update-available' | 'not-installed' | 'error';

/** Cross-references a catalog source against the installed-dataset inventory (PRD §4 status vocabulary). */
export function displayStatus(dataset: DatasetEntry | undefined): DisplayStatus {
  return dataset ? dataset.status : 'not-installed';
}

/** Total known download size for a source, or null when it can't be known up front (a template/forecast source has no size_bytes). */
export function totalSizeBytes(source: CatalogSource): number | null {
  let total = 0;
  for (const f of source.files) {
    if (isTemplateFile(f)) return null;
    total += f.size_bytes;
  }
  return total;
}

/**
 * A single downloadable unit shown in the UI. Most catalog sources map to
 * exactly one row, but a source with MULTIPLE region-scoped template files
 * (e.g. a multi-region NOAA forecast) expands into one row per region — each
 * independently downloadable, with its own geometry for the map and its own
 * name in the list. Without this, the UI has no way to show or download an
 * individual region: it would either collapse them all into one misleading
 * row, or (worse) let a "download" action silently grab whichever region
 * happens to be first in the catalog's file list.
 */
export interface SourceRow {
  /** Unique across all rows: `source.id`, or `${source.id}:${region_id}:${fileType}` for a per-region row. */
  key: string;
  source: CatalogSource;
  /** Set only for a per-region row — pass straight through as the download selector's region_id. */
  regionId?: string;
  /** Set only for a per-region row. A region can carry BOTH a forecast and a nowcast file under the SAME region_id (observed in the real NOAA catalog) — region_id alone doesn't uniquely identify a row/download, this does. */
  fileType?: 'forecast' | 'nowcast';
  name: string;
  regionName: string;
  geometry: GeoJsonGeometry;
  sizeBytes: number | null;
}

export function rowsForSource(source: CatalogSource): SourceRow[] {
  const templateFiles = source.files.filter(isTemplateFile);
  if (templateFiles.length > 1) {
    return templateFiles.map((f) => ({
      key: `${source.id}:${f.region_id}:${f.type}`,
      source,
      regionId: f.region_id,
      fileType: f.type,
      name: `${source.name} — ${f.name} (${f.type})`,
      regionName: f.name,
      geometry: f.boundary_geometry,
      sizeBytes: null, // catalog never gives forecast files a size up front
    }));
  }
  return [
    {
      key: source.id,
      source,
      regionId: templateFiles[0]?.region_id,
      fileType: templateFiles[0]?.type,
      name: source.name,
      regionName: source.region.name,
      geometry: source.region.boundary_geometry,
      sizeBytes: totalSizeBytes(source),
    },
  ];
}

export function rowsForSources(sources: CatalogSource[]): SourceRow[] {
  return sources.flatMap(rowsForSource);
}

/** `sourceId` + `regionId` (+ `fileType`, when a region has both a forecast and nowcast file) together, for keying per-download-job state — a source can have several downloads in flight at once, each needing its own key. */
export function downloadKeyFor(sourceId: string, regionId?: string, fileType?: 'forecast' | 'nowcast'): string {
  if (!regionId) return sourceId;
  return fileType ? `${sourceId}:${regionId}:${fileType}` : `${sourceId}:${regionId}`;
}

export function datasetForRow(datasets: DatasetEntry[], row: SourceRow): DatasetEntry | undefined {
  return datasets.find(
    (d) =>
      d.catalogSourceId === row.source.id &&
      (row.regionId === undefined || d.regionId === row.regionId) &&
      (row.fileType === undefined || d.fileType === row.fileType),
  );
}

/** Inverse of `datasetForRow` — the display row (name/regionName/size) for an installed dataset, so UI that only has the dataset (e.g. the Update-All banner) can still show a human-readable label instead of a raw id. */
export function rowForDataset(rows: SourceRow[], dataset: DatasetEntry): SourceRow | undefined {
  return rows.find(
    (r) =>
      r.source.id === dataset.catalogSourceId &&
      (dataset.regionId === undefined || r.regionId === dataset.regionId) &&
      (dataset.fileType === undefined || r.fileType === dataset.fileType),
  );
}

/** Pre-download check (PRD §5.4): would downloading `sizeBytes` more push the disk past 90% full? `null`/unknown inputs never trigger a warning — better to let the user proceed than block on incomplete information. */
export function wouldExceedDiskThreshold(sizeBytes: number | null, storage: StorageStats | null): boolean {
  if (sizeBytes === null || !storage?.totalBytes || storage.freeBytes === null) return false;
  const usedAfter = storage.totalBytes - storage.freeBytes + sizeBytes;
  return usedAfter / storage.totalBytes > 0.9;
}

export interface SourceFilters {
  types: Set<CatalogSource['type']>;
  query: string;
  tags: Set<string>;
}

export function matchesFilters(source: CatalogSource, filters: SourceFilters): boolean {
  if (filters.types.size > 0 && !filters.types.has(source.type)) return false;
  if (filters.tags.size > 0 && ![...filters.tags].every((t) => source.tags.includes(t))) return false;
  if (filters.query.trim()) {
    const q = filters.query.trim().toLowerCase();
    const haystack = `${source.name} ${source.description} ${source.region.name} ${source.tags.join(' ')}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/** Groups rows by provider (`source.source` field, PRD §5.1 "rows grouped by provider"), preserving first-seen provider order. */
export function groupRowsByProvider(rows: SourceRow[]): Array<{ provider: string; rows: SourceRow[] }> {
  const order: string[] = [];
  const groups = new Map<string, SourceRow[]>();
  for (const r of rows) {
    const provider = r.source.source;
    if (!groups.has(provider)) {
      groups.set(provider, []);
      order.push(provider);
    }
    groups.get(provider)!.push(r);
  }
  return order.map((provider) => ({ provider, rows: groups.get(provider)! }));
}
