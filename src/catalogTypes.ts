// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Tide/Current Catalog document types (see specs/tide-current-catalog.md,
 * schema 1.0.0, in the signalk-router-data repo) and a tolerant validator.
 *
 * The catalog is a single small JSON document listing downloadable current
 * datasets (harmonic/grib2/utcef). Field names below are taken verbatim from
 * the spec and cross-checked against the real generated
 * tide-current-index.json — in particular:
 *   - a catalog source's ONLY attribution fields are `contributor`/`url`;
 *     there is no `license`/`citation_required` here (those live inside a
 *     UTCEF file's own `metadata` block instead, see utcef.ts).
 *   - `bounding_box` is nested under `region`, not a top-level source field.
 *   - static files carry `sha256`/`size_bytes`; template (forecast/nowcast)
 *     files carry `url_template`/`forecast_hours`/`cycle_hours` instead and
 *     have no hash (their freshness is judged by `update_check.method:
 *     "expiry"`, not a hash compare).
 *   - the real catalog has been observed omitting `url` on some static utcef
 *     file entries even though the spec marks it required — treated as
 *     optional here defensively (the download engine derives a fallback URL).
 */

/** Highest `catalog_schema_version` major this plugin understands. */
export const SUPPORTED_CATALOG_SCHEMA_MAJOR = 1;

export interface BoundingBox {
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
}

// The backend never interprets geometry contents — pure passthrough to the
// frontend map — so a minimal structural type is used instead of adding a
// @types/geojson dependency to the backend.
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
  /** 'expiry' only. */
  max_age_hours?: number;
  /** 'expiry' only. */
  latest_cycle?: string;
}

export interface StaticCatalogFile {
  filename: string;
  /** Spec: required. Real catalog has been observed omitting it on some entries — treat as optional. */
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
  /** Contains {YYYYMMDD}, {HH}, {hour:03d} placeholders. */
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
  /** Only attribution field on a catalog source — free text, may itself embed license/copyright wording. */
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

function parseMajor(semver: unknown): number {
  return parseInt(String(semver ?? '').split('.')[0], 10);
}

function isBoundingBox(v: any): v is BoundingBox {
  return (
    v &&
    Number.isFinite(v.min_lat) &&
    Number.isFinite(v.min_lon) &&
    Number.isFinite(v.max_lat) &&
    Number.isFinite(v.max_lon)
  );
}

function isGeoJsonGeometry(v: any): v is GeoJsonGeometry {
  return v && (v.type === 'Polygon' || v.type === 'MultiPolygon') && v.coordinates !== undefined;
}

function isRegion(v: any): v is CatalogRegion {
  return v && typeof v.name === 'string' && isBoundingBox(v.bounding_box) && isGeoJsonGeometry(v.boundary_geometry);
}

function isUpdateCheck(v: any): v is UpdateCheck {
  return v && (v.method === 'sha256' || v.method === 'expiry') && typeof v.last_checked === 'string';
}

function isCatalogFile(v: any): v is CatalogFile {
  if (!v) return false;
  if (typeof v.url_template === 'string') {
    return (
      typeof v.region_id === 'string' &&
      typeof v.name === 'string' &&
      (v.type === 'forecast' || v.type === 'nowcast') &&
      Array.isArray(v.forecast_hours) &&
      Array.isArray(v.cycle_hours)
    );
  }
  return typeof v.filename === 'string' && Number.isFinite(v.size_bytes);
}

function validateSource(raw: any, warnings: string[]): CatalogSource | null {
  const id = raw?.id;
  if (typeof id !== 'string' || !id) {
    warnings.push('dropped a catalog source with no id');
    return null;
  }
  if (raw.type !== 'harmonic' && raw.type !== 'grib2' && raw.type !== 'utcef') {
    warnings.push(`source "${id}": unknown type "${raw.type}" — dropped`);
    return null;
  }
  if (!isRegion(raw.region)) {
    warnings.push(`source "${id}": missing/invalid region — dropped`);
    return null;
  }
  if (!isUpdateCheck(raw.update_check)) {
    warnings.push(`source "${id}": missing/invalid update_check — dropped`);
    return null;
  }
  const files: CatalogFile[] = Array.isArray(raw.files) ? raw.files.filter((f: any) => {
    const ok = isCatalogFile(f);
    if (!ok) warnings.push(`source "${id}": dropped a malformed file entry`);
    return ok;
  }) : [];

  return {
    id,
    source: String(raw.source ?? ''),
    type: raw.type,
    name: String(raw.name ?? id),
    description: String(raw.description ?? ''),
    contributor: String(raw.contributor ?? ''),
    url: String(raw.url ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    region: raw.region,
    update_check: raw.update_check,
    files,
  };
}

/**
 * Validates + sanitizes a raw fetched/cached JSON blob. Drops individually
 * malformed sources with a warning rather than rejecting the whole document;
 * rejects the WHOLE document only on a catalog_schema_version major mismatch
 * (mirrors utcef.ts's per-file major-version rejection, applied catalog-wide
 * since there is only one document here, not many independent files).
 */
export function validateCatalogDocument(raw: unknown): { document: CatalogDocument; warnings: string[] } {
  const warnings: string[] = [];
  const doc = raw as any;
  if (!doc || typeof doc !== 'object') {
    throw new Error('catalog document is not a JSON object');
  }
  const major = parseMajor(doc.catalog_schema_version);
  if (Number.isFinite(major) && major > SUPPORTED_CATALOG_SCHEMA_MAJOR) {
    throw new Error(
      `catalog_schema_version ${doc.catalog_schema_version} major ${major} > supported ${SUPPORTED_CATALOG_SCHEMA_MAJOR}`,
    );
  }
  const rawSources: any[] = Array.isArray(doc.sources) ? doc.sources : [];
  const sources: CatalogSource[] = [];
  for (const s of rawSources) {
    const v = validateSource(s, warnings);
    if (v) sources.push(v);
  }
  const document: CatalogDocument = {
    catalog_schema_version: String(doc.catalog_schema_version ?? ''),
    version: Number(doc.version) || 0,
    generated: String(doc.generated ?? ''),
    source_count: sources.length,
    sources,
  };
  return { document, warnings };
}
