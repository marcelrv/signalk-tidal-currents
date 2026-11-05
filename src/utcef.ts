// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * UTCEF (Unified Tidal and Current Exchange Format) source.
 *
 * A modern JSON/GeoJSON tidal-exchange format (see specs/utcef-specification).
 * Unlike the legacy HARMONIC station files, a UTCEF feature carries the
 * per-constituent amplitude and Greenwich phase lag directly and expects the
 * engine to derive the astronomical terms (ω, V₀, f, u) itself — see astro.ts.
 *
 * Scope of this implementation:
 *   - `harmonic_constituents_currents` — full 2D (u/v) harmonic currents.
 *     These are true vectors, so — unlike legacy reference stations — every
 *     UTCEF current station is direction-capable (a real set/drift vector).
 *   - `harmonic_constituents_heights` — parsed and retained but NOT published
 *     (this is a currents plugin; heights only exist here to support a future
 *     `relative_time_offset` implementation, which needs reference-port HW).
 *   - `relative_time_offset` — not yet implemented (needs HW/range-ratio from
 *     a reference height station); such features are counted but skipped.
 *
 * A `.utcef` file is a standard ZIP archive (like `.apk`/`.docx`) containing a
 * single `*.json` payload member; the container is detected by magic bytes, so
 * a raw-JSON `.utcef` and the deprecated gzip `.utcef.gz` are also accepted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import { astronomicalArgs, equilibriumArg, isKnownConstituent, nodeFactors } from './astro.js';
import { CurrentSample, distanceKm, KNOTS_TO_MS, lonInSpan, lonSpansOverlap } from './predict.js';

// Re-exported: the longitude-wrap helpers live in predict.ts (shared with the
// legacy harmonic bbox filter) but are part of the UTCEF viewport API too.
export { lonInSpan, lonSpansOverlap };

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Highest UTCEF schema major version this parser understands (spec §2). */
export const SUPPORTED_SCHEMA_MAJOR = 1;

export const UTCEF_EXT_RE = /\.utcef(\.gz)?$/i;

interface CurrentConstituent {
  name: string;
  uAmp: number; // m/s
  uPhaseG: number; // Greenwich phase lag, deg
  vAmp: number; // m/s
  vPhaseG: number; // Greenwich phase lag, deg
}

/** An internal current station distilled from a `harmonic_constituents_currents` feature. */
export interface UtcefCurrentStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  meanU: number; // m/s east
  meanV: number; // m/s north
  constituents: CurrentConstituent[];
  /** GeoJSON Polygon rings [ [ [lon,lat], … ] ] where the prediction is valid, if given. */
  representativeArea?: number[][][];
  /** Provenance: which file in the UTCEF dir this station came from (set by loadUtcefDir) — the hook per-dataset priority filters on. */
  file?: string;
}

/** A `metadata.data_sources[]` entry (spec §4.1). */
export interface UtcefDataSource {
  name: string;
  url?: string;
  role?: string;
}

export interface UtcefData {
  dir: string;
  files: string[];
  title?: string;
  /** Legal copyright/attribution statement (`metadata.copyright`). */
  copyright?: string;
  /** Data-sharing terms, e.g. "CC-BY-4.0" (`metadata.license`). */
  license?: string;
  /** Link to the full license text, when the dataset provides one (`metadata.license_url`). */
  licenseUrl?: string;
  /** Citation text required by the underlying data source, if any (`metadata.citation_required`). */
  citationRequired?: string;
  /** Source organizations/models feeding this dataset (`metadata.data_sources`). */
  dataSources?: UtcefDataSource[];
  currentStations: UtcefCurrentStation[];
  /** Count of parsed height features (retained for future use, not published). */
  heightStationCount: number;
  /** Count of features skipped because their method is not yet implemented. */
  unsupportedFeatureCount: number;
  warnings: string[];
}

function toMsPerSecond(unit: string | undefined): number {
  const u = (unit ?? 'meters_per_second').toLowerCase();
  if (u === 'knots' || u === 'knot' || u === 'kn') return KNOTS_TO_MS;
  if (u === 'meters_per_second' || u === 'm/s' || u === 'mps') return 1;
  // Unknown unit — assume m/s but let the caller surface a warning.
  return 1;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Parse one UTCEF document (already-decompressed JSON text) into current stations. */
export function parseUtcef(text: string, sourceLabel: string, warnings: string[]): {
  title?: string;
  copyright?: string;
  license?: string;
  licenseUrl?: string;
  citationRequired?: string;
  dataSources?: UtcefDataSource[];
  currentStations: UtcefCurrentStation[];
  heightStationCount: number;
  unsupportedFeatureCount: number;
} {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${sourceLabel}: not valid JSON (${e instanceof Error ? e.message : e})`);
  }

  const meta = doc?.metadata ?? {};
  const version = String(meta.schema_version ?? '');
  const major = parseInt(version.split('.')[0], 10);
  if (Number.isFinite(major) && major > SUPPORTED_SCHEMA_MAJOR) {
    // Reject unsupported MAJOR versions (spec §2) rather than mis-parse.
    throw new Error(
      `${sourceLabel}: schema_version ${version} major ${major} > supported ${SUPPORTED_SCHEMA_MAJOR}`,
    );
  }

  const features: any[] = Array.isArray(doc?.dataset?.features) ? doc.dataset.features : [];
  const currentStations: UtcefCurrentStation[] = [];
  let heightStationCount = 0;
  let unsupportedFeatureCount = 0;
  // Unknown constituents are aggregated to ONE warning per name per file: a
  // whole-file property (e.g. every NOAA station carries S4/S6) would
  // otherwise emit thousands of per-station repeats.
  const unknownConstituents = new Map<string, number>();

  for (const f of features) {
    const props = f?.properties ?? {};
    const method = props.prediction_method;
    // Canonical identity is the top-level Feature.id (spec §4.2); station_id
    // is only a legacy alias.
    const id = String(f?.id ?? props.station_id ?? '').trim();
    const name = String(props.station_name ?? id);

    if (method === 'harmonic_constituents_heights') {
      heightStationCount++;
      continue;
    }
    if (method !== 'harmonic_constituents_currents') {
      // relative_time_offset and anything else: not implemented yet.
      unsupportedFeatureCount++;
      continue;
    }

    const coords = f?.geometry?.coordinates;
    if (
      f?.geometry?.type !== 'Point' ||
      !Array.isArray(coords) ||
      typeof coords[0] !== 'number' ||
      typeof coords[1] !== 'number'
    ) {
      warnings.push(`${sourceLabel}: feature "${id || name}" has no valid Point geometry — skipped`);
      continue;
    }
    if (!id) {
      warnings.push(`${sourceLabel}: a current feature is missing Feature.id — skipped`);
      continue;
    }

    const scale = toMsPerSecond(props.data_unit_speed);
    const hc = props.harmonic_constituents ?? {};
    const constituents: CurrentConstituent[] = [];
    for (const [cname, raw] of Object.entries<any>(hc)) {
      if (!isKnownConstituent(cname)) {
        unknownConstituents.set(cname, (unknownConstituents.get(cname) ?? 0) + 1);
        continue;
      }
      constituents.push({
        name: cname,
        uAmp: (Number(raw?.u_amplitude) || 0) * scale,
        uPhaseG: Number(raw?.u_phase_g) || 0,
        vAmp: (Number(raw?.v_amplitude) || 0) * scale,
        vPhaseG: Number(raw?.v_phase_g) || 0,
      });
    }
    if (constituents.length === 0) {
      warnings.push(`${sourceLabel}: station "${id}" has no usable harmonic constituents — skipped`);
      continue;
    }

    const mean = props.mean_offset ?? {};
    const area =
      props.representative_area?.type === 'Polygon' &&
      Array.isArray(props.representative_area.coordinates)
        ? (props.representative_area.coordinates as number[][][])
        : undefined;

    currentStations.push({
      id,
      name,
      longitude: coords[0],
      latitude: coords[1],
      meanU: (Number(mean.u_residual) || 0) * scale,
      meanV: (Number(mean.v_residual) || 0) * scale,
      constituents,
      representativeArea: area,
    });
  }

  for (const [cname, count] of unknownConstituents) {
    warnings.push(
      `${sourceLabel}: ${count} station(s) reference unknown constituent "${cname}" — skipped`,
    );
  }

  const dataSources: UtcefDataSource[] | undefined = Array.isArray(meta.data_sources)
    ? meta.data_sources
        .filter((s: any) => s && typeof s.name === 'string')
        .map((s: any) => ({ name: s.name, url: s.url, role: s.role }))
    : undefined;

  return {
    title: meta.title,
    copyright: meta.copyright,
    license: meta.license,
    licenseUrl: meta.license_url,
    citationRequired: meta.citation_required,
    dataSources,
    currentStations,
    heightStationCount,
    unsupportedFeatureCount,
  };
}

/**
 * Extract the JSON payload from a UTCEF `.utcef` ZIP archive (spec: "Container").
 * A `.utcef` file is an ordinary ZIP containing a single `*.json` member —
 * this reads the central directory and inflates the first `.json` entry.
 * Kept dependency-free (Node has gzip/inflate in `zlib` but no ZIP container
 * reader), consistent with the plugin's from-scratch GRIB2 decoder.
 */
function unzipJsonMember(buf: Buffer): string {
  const EOCD_SIG = 0x06054b50; // End Of Central Directory
  const CEN_SIG = 0x02014b50; // Central directory file header
  const LOC_SIG = 0x04034b50; // Local file header

  // The EOCD is at the end, before an optional ≤64 KB comment — scan back for it.
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a valid ZIP archive (no end-of-central-directory record)');

  const entries = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16); // offset of the central directory
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(cd) !== CEN_SIG) break;
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lhOffset = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    cd += 46 + nameLen + extraLen + commentLen;
    if (!/\.json$/i.test(name)) continue;

    if (buf.readUInt32LE(lhOffset) !== LOC_SIG) throw new Error('corrupt ZIP: bad local header');
    const lNameLen = buf.readUInt16LE(lhOffset + 26);
    const lExtraLen = buf.readUInt16LE(lhOffset + 28);
    const dataStart = lhOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) return data.toString('utf8'); // stored
    if (method === 8) return zlib.inflateRawSync(data).toString('utf8'); // deflate
    throw new Error(`unsupported ZIP compression method ${method}`);
  }
  throw new Error('ZIP archive contains no .json member');
}

/**
 * Read a single UTCEF file into its JSON text, detecting the container by magic
 * bytes rather than extension: ZIP (`50 4B`, the spec container), gzip
 * (`1F 8B`, deprecated `.utcef.gz`), or raw JSON (anything else).
 */
function readUtcefFile(full: string): string {
  const buf = fs.readFileSync(full);
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return unzipJsonMember(buf); // "PK"
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
}

/**
 * Recursive file listing as SORTED forward-slash relative paths — catalog
 * downloads land in subdirectories (real catalog filenames look like
 * `regions/europe/netherlands.utcef`), and the install manifest records that
 * same relative path, so provenance (`station.file`) matches it exactly.
 * Forward slashes even on Windows: the manifest uses them, and path.join
 * handles them fine when resolving back to an absolute path.
 */
export function listDataFilesRecursive(dir: string, match: RegExp, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel === '' ? dir : path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(relPath, depth + 1);
      } else if (match.test(e.name)) {
        out.push(relPath);
      }
    }
  };
  walk('', 0);
  return out.sort();
}

/**
 * Per-file parse cache, keyed by relative path (`sig` = size+mtime, the same
 * change signal createUtcefSource trusts for the whole directory). A reload
 * is triggered by ANY change — including every completed catalog download —
 * and a UTCEF file is a multi-MB JSON document; without this a boat with
 * many regions re-JSON.parses ALL of them whenever one changes, spiking CPU
 * and doubling peak RAM on a Cerbo GX / Pi. Parse failures are cached too,
 * so a corrupt file is reported once per change, not once per minute.
 * The cross-file merge (duplicate-id dedup, metadata precedence) is cheap
 * and re-runs on every load from the cached per-file results.
 */
export interface UtcefFileCacheEntry {
  sig: string;
  parsed: ReturnType<typeof parseUtcef> | null;
  /** Warnings emitted while parsing THIS file (feature-level issues, or the parse error itself). */
  warnings: string[];
}
export type UtcefFileCache = Map<string, UtcefFileCacheEntry>;

/** Parse every UTCEF file in a directory (recursively — catalog downloads land in subdirs) into a merged dataset. Pass a `cache` (owned by a long-lived source) to re-parse only files whose size/mtime changed. */
export function loadUtcefDir(dir: string, cache?: UtcefFileCache): UtcefData | null {
  if (!fs.existsSync(dir)) return null; // directory absent — UTCEF source simply not configured
  const entries = listDataFilesRecursive(dir, UTCEF_EXT_RE);
  if (entries.length === 0) {
    cache?.clear();
    return null;
  }

  const warnings: string[] = [];
  const currentStations: UtcefCurrentStation[] = [];
  const files: string[] = [];
  const seenIds = new Set<string>();
  const present = new Set<string>();
  let title: string | undefined;
  let copyright: string | undefined;
  let license: string | undefined;
  let licenseUrl: string | undefined;
  let citationRequired: string | undefined;
  let dataSources: UtcefDataSource[] | undefined;
  let heightStationCount = 0;
  let unsupportedFeatureCount = 0;

  for (const name of entries) {
    const full = path.join(dir, name);
    present.add(name);
    let sig = '';
    try {
      const st = fs.statSync(full);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      continue; // vanished between listing and stat
    }

    let entry = cache?.get(name);
    if (!entry || entry.sig !== sig) {
      const fileWarnings: string[] = [];
      let parsed: ReturnType<typeof parseUtcef> | null = null;
      try {
        parsed = parseUtcef(readUtcefFile(full), name, fileWarnings);
      } catch (e) {
        fileWarnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      entry = { sig, parsed, warnings: fileWarnings };
      cache?.set(name, entry);
    }

    warnings.push(...entry.warnings);
    const parsed = entry.parsed;
    if (!parsed) continue;
    if (!title) title = parsed.title;
    if (!copyright) copyright = parsed.copyright;
    if (!license) license = parsed.license;
    if (!licenseUrl) licenseUrl = parsed.licenseUrl;
    if (!citationRequired) citationRequired = parsed.citationRequired;
    if (!dataSources) dataSources = parsed.dataSources;
    heightStationCount += parsed.heightStationCount;
    unsupportedFeatureCount += parsed.unsupportedFeatureCount;
    let added = 0;
    for (const st of parsed.currentStations) {
      if (seenIds.has(st.id)) {
        warnings.push(`${name}: duplicate station id "${st.id}" — later occurrence ignored`);
        continue;
      }
      seenIds.add(st.id);
      st.file = name;
      currentStations.push(st);
      added++;
    }
    if (added > 0 || parsed.heightStationCount > 0) files.push(name);
  }
  // Deleted files must not pin their parsed stations in memory forever.
  if (cache) {
    for (const key of [...cache.keys()]) if (!present.has(key)) cache.delete(key);
  }

  return {
    dir,
    files,
    title,
    copyright,
    license,
    licenseUrl,
    citationRequired,
    dataSources,
    currentStations,
    heightStationCount,
    unsupportedFeatureCount,
    warnings,
  };
}

/** A UTCEF sample: always a full 2D vector, so direction/u/v are never null (unlike legacy reference stations). */
export interface UtcefSample extends CurrentSample {
  direction: number;
  u: number;
  v: number;
}

/**
 * Single-entry memo of the per-constituent astronomical terms (Greenwich
 * equilibrium argument + nodal phase, and nodal factor f) for one instant.
 * These depend only on (time, constituent), not on the station, so a map
 * overlay sampling thousands of stations at the SAME time computes each
 * constituent's V0/f/u once instead of once per station. null = unknown
 * constituent (already warned at load).
 */
let termsTimeMs = NaN;
let terms = new Map<string, { base: number; f: number } | null>();

function constituentTerms(timeMs: number, name: string): { base: number; f: number } | null {
  if (timeMs !== termsTimeMs) {
    termsTimeMs = timeMs;
    terms = new Map();
  }
  let t = terms.get(name);
  if (t === undefined) {
    const a = astronomicalArgs(timeMs);
    const v0 = equilibriumArg(a, name);
    const nf = nodeFactors(a, name);
    t = v0 === null || nf === null ? null : { base: v0 + nf.u, f: nf.f };
    terms.set(name, t);
  }
  return t;
}

/** Set/drift sample at a UTCEF current station for a UTC time. */
export function utcefSampleAt(station: UtcefCurrentStation, timeMs: number): UtcefSample {
  let u = station.meanU;
  let v = station.meanV;
  for (const c of station.constituents) {
    const t = constituentTerms(timeMs, c.name);
    if (t === null) continue; // unknown constituent (already warned at load)
    // t.base = Greenwich equilibrium argument + nodal phase
    u += t.f * c.uAmp * Math.cos((t.base - c.uPhaseG) * DEG2RAD);
    v += t.f * c.vAmp * Math.cos((t.base - c.vPhaseG) * DEG2RAD);
  }
  const speedMs = Math.hypot(u, v);
  // Direction of set (°T): same convention as the GRIB source.
  const direction = speedMs > 1e-6 ? ((90 - Math.atan2(v, u) * RAD2DEG) % 360 + 360) % 360 : 0;
  return {
    time: new Date(timeMs).toISOString(),
    speedKn: Math.round((speedMs / KNOTS_TO_MS) * 100) / 100,
    direction: Math.round(direction * 10) / 10,
    u: Math.round(u * 1000) / 1000,
    v: Math.round(v * 1000) / 1000,
  };
}

/** UTCEF current stations inside a lon/lat box (inclusive; longitudes compared modulo 360). No cap: callers thin the result, and stopping early in array order would make the thinned set depend on file load order. */
export function utcefStationsInBbox(
  data: UtcefData,
  bbox: { west: number; south: number; east: number; north: number },
): UtcefCurrentStation[] {
  return data.currentStations.filter(
    (s) => s.latitude >= bbox.south && s.latitude <= bbox.north && lonInSpan(s.longitude, bbox.west, bbox.east),
  );
}

/** Lon/lat bounds of a station's representative_area outer ring (memoised per station object). */
const areaBoundsCache = new WeakMap<UtcefCurrentStation, { west: number; south: number; east: number; north: number } | null>();
export function utcefAreaBounds(s: UtcefCurrentStation): { west: number; south: number; east: number; north: number } | null {
  let b = areaBoundsCache.get(s);
  if (b === undefined) {
    const ring = s.representativeArea?.[0];
    if (!ring || ring.length < 4) b = null;
    else {
      b = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
      for (const [x, y] of ring) {
        if (x < b.west) b.west = x;
        if (x > b.east) b.east = x;
        if (y < b.south) b.south = y;
        if (y > b.north) b.north = y;
      }
    }
    areaBoundsCache.set(s, b);
  }
  return b;
}

/**
 * Bucketed index over a set of stations answering "would utcefVectorAt claim
 * this point?" (contained in a representative_area, or a station within
 * maxKm) without utcefVectorAt's linear scan over every station — for map
 * overlays probing thousands of points per request. Stations are bucketed by
 * position, area polygons by their bounding box, so a probe only tests the
 * polygons whose bounds cover its cell. `files` restricts the probe to one
 * dataset's stations, as utcefVectorAt does.
 */
export function utcefCoverageIndex(stations: UtcefCurrentStation[], cellDeg = 0.5) {
  // Longitude cell indices wrap modulo 360 so probes near the antimeridian
  // find stations/polygons on the other side of it.
  const nLon = Math.round(360 / cellDeg);
  const key = (j: number, i: number) => `${j}:${((i % nLon) + nLon) % nLon}`;
  const cells = new Map<string, UtcefCurrentStation[]>();
  const areaCells = new Map<string, UtcefCurrentStation[]>();
  const push = (m: Map<string, UtcefCurrentStation[]>, key: string, s: UtcefCurrentStation) => {
    const list = m.get(key);
    if (list) list.push(s);
    else m.set(key, [s]);
  };
  for (const s of stations) {
    push(cells, key(Math.floor(s.latitude / cellDeg), Math.floor(s.longitude / cellDeg)), s);
    const b = utcefAreaBounds(s);
    if (b) {
      const i0 = Math.floor(b.west / cellDeg);
      const i1 = Math.min(Math.floor(b.east / cellDeg), i0 + nLon - 1);
      for (let j = Math.floor(b.south / cellDeg); j <= Math.floor(b.north / cellDeg); j++) {
        for (let i = i0; i <= i1; i++) push(areaCells, key(j, i), s);
      }
    }
  }
  const inFiles = (s: UtcefCurrentStation, files?: ReadonlySet<string>) =>
    !files || (s.file !== undefined && files.has(s.file));
  return {
    covers(lat: number, lon: number, maxKm: number, files?: ReadonlySet<string>): boolean {
      for (const s of areaCells.get(key(Math.floor(lat / cellDeg), Math.floor(lon / cellDeg))) ?? []) {
        if (!inFiles(s, files)) continue;
        // The polygon may be written past ±180; try the probe in each frame.
        for (const l of [lon, lon + 360, lon - 360]) if (pointInArea(s.representativeArea!, lat, l)) return true;
      }
      const dLat = maxKm / 111.32;
      const dLon = dLat / Math.max(Math.cos(lat * DEG2RAD), 0.01);
      const j0 = Math.floor((lat - dLat) / cellDeg);
      const j1 = Math.floor((lat + dLat) / cellDeg);
      const i0 = Math.floor((lon - dLon) / cellDeg);
      const i1 = Math.min(Math.floor((lon + dLon) / cellDeg), i0 + nLon - 1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          for (const s of cells.get(key(j, i)) ?? []) {
            if (inFiles(s, files) && distanceKm(lat, lon, s.latitude, s.longitude) <= maxKm) return true;
          }
        }
      }
      return false;
    },
  };
}

/** Ray-casting point-in-polygon over a GeoJSON Polygon's outer ring ([lon,lat]). */
function pointInArea(area: number[][][], lat: number, lon: number): boolean {
  const ring = area[0];
  if (!ring || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Nearest current stations to a position, closest first. */
export function nearestUtcefStations(
  data: UtcefData,
  lat: number,
  lon: number,
  limit = 10,
): Array<{ station: UtcefCurrentStation; distanceKm: number }> {
  return data.currentStations
    .map((station) => ({
      station,
      distanceKm: Math.round(distanceKm(lat, lon, station.latitude, station.longitude) * 100) / 100,
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/**
 * Best current vector at a position/time: prefer a station whose
 * `representative_area` contains the point; otherwise fall back to the
 * nearest station within `maxKm`. Returns null when nothing qualifies.
 * `files` restricts the search to stations loaded from those files —
 * how per-dataset priority (PRD §5.3 Phase 3) probes one installed
 * dataset at a time instead of the whole merged directory.
 */
export function utcefVectorAt(
  data: UtcefData,
  lat: number,
  lon: number,
  timeMs: number,
  maxKm = Infinity,
  files?: ReadonlySet<string>,
): { station: UtcefCurrentStation; distanceKm: number; sample: CurrentSample } | null {
  const stations = files
    ? data.currentStations.filter((s) => s.file !== undefined && files.has(s.file))
    : data.currentStations;
  if (stations.length === 0) return null;

  const containing = stations.find(
    (s) => s.representativeArea && pointInArea(s.representativeArea, lat, lon),
  );
  if (containing) {
    return {
      station: containing,
      distanceKm: Math.round(distanceKm(lat, lon, containing.latitude, containing.longitude) * 100) / 100,
      sample: utcefSampleAt(containing, timeMs),
    };
  }

  let near: { station: UtcefCurrentStation; distanceKm: number } | null = null;
  for (const station of stations) {
    const d = Math.round(distanceKm(lat, lon, station.latitude, station.longitude) * 100) / 100;
    if (!near || d < near.distanceKm) near = { station, distanceKm: d };
  }
  if (!near || near.distanceKm > maxKm) return null;
  return { station: near.station, distanceKm: near.distanceKm, sample: utcefSampleAt(near.station, timeMs) };
}

/** Coverage summary for the dataset endpoint / plugin status. */
export function utcefSummary(data: UtcefData): Record<string, unknown> {
  return {
    dir: data.dir,
    files: data.files,
    title: data.title,
    copyright: data.copyright,
    license: data.license,
    licenseUrl: data.licenseUrl,
    citationRequired: data.citationRequired,
    dataSources: data.dataSources,
    currentStations: data.currentStations.length,
    heightStations: data.heightStationCount,
    unsupportedFeatures: data.unsupportedFeatureCount,
    warnings: data.warnings,
  };
}

/**
 * Lazily (re)loading UTCEF source: re-stats the directory at most every
 * `checkIntervalMs` and reloads when the file set changed, so dropping a
 * fresh `.utcef` file in requires no plugin restart (same pattern as the
 * GRIB source).
 */
export interface UtcefSource {
  get(): UtcefData | null;
  readonly error: string | null;
  /** Forces the next get() call to re-stat the directory and reload immediately, bypassing checkIntervalMs — used right after a catalog-driven download finishes so a newly-downloaded file is served without waiting up to a minute. */
  invalidate(): void;
}

export function createUtcefSource(dir: string, checkIntervalMs = 60_000): UtcefSource {
  let data: UtcefData | null = null;
  let signature = '';
  let lastCheck = -Infinity;
  let error: string | null = null;
  // Survives across reloads: only files whose size/mtime changed get re-parsed.
  const fileCache: UtcefFileCache = new Map();

  const currentSignature = (): string => {
    try {
      return listDataFilesRecursive(dir, UTCEF_EXT_RE)
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return `${f}:${st.size}:${st.mtimeMs}`;
        })
        .join('|');
    } catch {
      return '';
    }
  };

  return {
    get(): UtcefData | null {
      const now = Date.now();
      if (now - lastCheck >= checkIntervalMs) {
        lastCheck = now;
        const sig = currentSignature();
        if (sig !== signature) {
          signature = sig;
          try {
            data = loadUtcefDir(dir, fileCache);
            error = null;
          } catch (e) {
            data = null;
            error = e instanceof Error ? e.message : String(e);
          }
        }
      }
      return data;
    },
    get error(): string | null {
      return error;
    },
    invalidate(): void {
      lastCheck = -Infinity;
    },
  };
}
