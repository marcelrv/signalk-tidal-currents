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
import { CurrentSample, distanceKm, KNOTS_TO_MS } from './predict.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Highest UTCEF schema major version this parser understands (spec §2). */
export const SUPPORTED_SCHEMA_MAJOR = 1;

const UTCEF_EXT_RE = /\.utcef(\.gz)?$/i;

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
}

export interface UtcefData {
  dir: string;
  files: string[];
  title?: string;
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
        warnings.push(
          `${sourceLabel}: station "${id}" references unknown constituent "${cname}" — skipped`,
        );
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

  return { title: meta.title, currentStations, heightStationCount, unsupportedFeatureCount };
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

/** Parse every UTCEF file in a directory into a merged dataset. */
export function loadUtcefDir(dir: string): UtcefData | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => UTCEF_EXT_RE.test(f));
  } catch {
    return null; // directory absent — UTCEF source simply not configured
  }
  if (entries.length === 0) return null;

  const warnings: string[] = [];
  const currentStations: UtcefCurrentStation[] = [];
  const files: string[] = [];
  const seenIds = new Set<string>();
  let title: string | undefined;
  let heightStationCount = 0;
  let unsupportedFeatureCount = 0;

  for (const name of entries.sort()) {
    const full = path.join(dir, name);
    try {
      const text = readUtcefFile(full);
      const parsed = parseUtcef(text, name, warnings);
      if (!title) title = parsed.title;
      heightStationCount += parsed.heightStationCount;
      unsupportedFeatureCount += parsed.unsupportedFeatureCount;
      let added = 0;
      for (const st of parsed.currentStations) {
        if (seenIds.has(st.id)) {
          warnings.push(`${name}: duplicate station id "${st.id}" — later occurrence ignored`);
          continue;
        }
        seenIds.add(st.id);
        currentStations.push(st);
        added++;
      }
      if (added > 0 || parsed.heightStationCount > 0) files.push(name);
    } catch (e) {
      warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    dir,
    files,
    title,
    currentStations,
    heightStationCount,
    unsupportedFeatureCount,
    warnings,
  };
}

/** Set/drift sample at a UTCEF current station for a UTC time. */
export function utcefSampleAt(station: UtcefCurrentStation, timeMs: number): CurrentSample {
  const a = astronomicalArgs(timeMs);
  let u = station.meanU;
  let v = station.meanV;
  for (const c of station.constituents) {
    const v0 = equilibriumArg(a, c.name);
    const nf = nodeFactors(a, c.name);
    if (v0 === null || nf === null) continue; // unknown constituent (already warned at load)
    const base = v0 + nf.u; // Greenwich equilibrium argument + nodal phase
    u += nf.f * c.uAmp * Math.cos((base - c.uPhaseG) * DEG2RAD);
    v += nf.f * c.vAmp * Math.cos((base - c.vPhaseG) * DEG2RAD);
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
 */
export function utcefVectorAt(
  data: UtcefData,
  lat: number,
  lon: number,
  timeMs: number,
  maxKm = Infinity,
): { station: UtcefCurrentStation; distanceKm: number; sample: CurrentSample } | null {
  if (data.currentStations.length === 0) return null;

  const containing = data.currentStations.find(
    (s) => s.representativeArea && pointInArea(s.representativeArea, lat, lon),
  );
  if (containing) {
    return {
      station: containing,
      distanceKm: Math.round(distanceKm(lat, lon, containing.latitude, containing.longitude) * 100) / 100,
      sample: utcefSampleAt(containing, timeMs),
    };
  }

  const near = nearestUtcefStations(data, lat, lon, 1)[0];
  if (!near || near.distanceKm > maxKm) return null;
  return { station: near.station, distanceKm: near.distanceKm, sample: utcefSampleAt(near.station, timeMs) };
}

/** Coverage summary for the dataset endpoint / plugin status. */
export function utcefSummary(data: UtcefData): Record<string, unknown> {
  return {
    dir: data.dir,
    files: data.files,
    title: data.title,
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
}

export function createUtcefSource(dir: string, checkIntervalMs = 60_000): UtcefSource {
  let data: UtcefData | null = null;
  let signature = '';
  let lastCheck = -Infinity;
  let error: string | null = null;

  const currentSignature = (): string => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => UTCEF_EXT_RE.test(f))
        .sort()
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
            data = loadUtcefDir(dir);
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
  };
}
